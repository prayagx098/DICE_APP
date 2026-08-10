// DOM Elements
const dragZone = document.getElementById('swipe-zone');
const dice = document.getElementById('dice');
const diceWrapper = document.getElementById('dice-wrapper');
const diceShadow = document.getElementById('dice-shadow');
const hint = document.getElementById('hint');
const audioFallback = document.getElementById('dice-sound');

// Web Audio API State
let audioCtx = null;
let audioBuffer = null;

const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------
// Quaternion math. Orientation is tracked as an exact unit quaternion and
// integrated with a closed-form axis-angle update every frame, instead of
// accumulating independent X/Y/Z Euler angles (which only represents the
// true rotation of a spinning rigid body when a single axis is active -
// with two or more axes spinning at once, as happens on every real throw,
// Euler accumulation drifts from the physically correct orientation more
// with every frame). Quaternion composition is exact regardless of how
// many axes are spinning simultaneously.
// ---------------------------------------------------------------------
function quatMul(a, b) {
    return {
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
    };
}

function quatFromAxisAngle(ax, ay, az, angle) {
    const half = angle / 2;
    const s = Math.sin(half);
    return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(half) };
}

function quatNormalize(q) {
    const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (len < 1e-9) return { x: 0, y: 0, z: 0, w: 1 };
    return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

// Exact closed-form rotation for a constant angular velocity vector (rad
// per frame) applied over one frame - no small-angle approximation error.
function integrateOrientation(q, w) {
    const angle = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    if (angle < 1e-9) return q;
    const inv = 1 / angle;
    const dq = quatFromAxisAngle(w.x * inv, w.y * inv, w.z * inv, angle);
    return quatNormalize(quatMul(dq, q));
}

function quatToMatrix3d(q) {
    const { x, y, z, w } = q;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;

    const m00 = 1 - 2 * (yy + zz), m10 = 2 * (xy + wz), m20 = 2 * (xz - wy);
    const m01 = 2 * (xy - wz), m11 = 1 - 2 * (xx + zz), m21 = 2 * (yz + wx);
    const m02 = 2 * (xz + wy), m12 = 2 * (yz - wx), m22 = 1 - 2 * (xx + yy);

    return `matrix3d(${m00},${m10},${m20},0,${m01},${m11},${m21},0,${m02},${m12},${m22},0,0,0,0,1)`;
}

function quatDot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

function quatNegate(q) {
    return { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
}

// A drag/throw direction (dx, dy) rolls the dice about the axis
// perpendicular to that direction, exactly like a ball or wheel rolling
// across the screen plane in the direction it's pushed.
function rollAxisFromDelta(dx, dy) {
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag < 1e-9) return { x: 0, y: 0, z: 0 };
    return { x: -dy / mag, y: dx / mag, z: 0 };
}

// ---------------------------------------------------------------------
// Gestures State
// ---------------------------------------------------------------------
let isDragging = false;
let startX = 0;
let startY = 0;
let dragStartOrientation = { x: 0, y: 0, z: 0, w: 1 };
let lastMoveTime = 0;
let velocityX = 0;
let velocityY = 0;
let lastClientX = 0;
let lastClientY = 0;

// ---------------------------------------------------------------------
// Physics Simulation State
// ---------------------------------------------------------------------
let isRolling = false;
let diceValue = 1;
let orientation = { x: 0, y: 0, z: 0, w: 1 }; // Current exact orientation
let angVel = { x: 0, y: 0, z: 0 };            // Angular velocity, rad/frame
let posX = 0;
let posY = 0;
let posZ = 0;   // Real depth toward the camera (bounce height)
let velX = 0;
let velY = 0;
let velZ = 0;   // Vertical (bounce) velocity
let physicsRequestId = null;
let hintDismissed = false;

const sensitivity = 0.4;
const SWIPE_THRESHOLD = 30; // Min px to trigger swipe physics
const DICE_SIZE = 176;

// Real gravity/restitution constants - posZ/velZ are true px of depth, so
// GRAVITY and impact behavior read directly as real motion, not a faked
// scale trick.
const GRAVITY = 1.0;               // px/frame^2 toward the table
const BOUNCE_RESTITUTION = 0.5;    // Vertical velocity kept after hitting the table
const IMPACT_FRICTION = 0.72;      // Linear/angular energy kept after each table impact
const AIR_DRAG = 0.999;            // Drag while airborne
const GROUND_DRAG = 0.90;          // Drag while rolling on the table (real dice stop fast)
const SETTLE_LINEAR = 0.15;
const SETTLE_ANGULAR = 0.15 * DEG2RAD;
const SETTLE_VELZ = 0.05;

// Haptics: the Vibration API only exists on Chromium/Android - iOS Safari
// has never implemented it, so this degrades silently there.
const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
function vibrate(pattern) {
    if (canVibrate) navigator.vibrate(pattern);
}

// Exact target orientations for each face resting flush against the camera.
// Each is a single-axis rotation, so it's built directly (Opposite faces
// sum to 7).
const FACE_QUAT = {
    1: quatFromAxisAngle(0, 0, 0, 0),
    2: quatFromAxisAngle(0, 1, 0, -90 * DEG2RAD),
    3: quatFromAxisAngle(1, 0, 0, -90 * DEG2RAD),
    4: quatFromAxisAngle(1, 0, 0, 90 * DEG2RAD),
    5: quatFromAxisAngle(0, 1, 0, 90 * DEG2RAD),
    6: quatFromAxisAngle(0, 1, 0, 180 * DEG2RAD)
};

// Find which of the 6 faces is actually resting toward the camera, and the
// exact flush orientation for it closest to the current tumble. A face can
// come to rest at any of 4 in-plane twists (0/90/180/270 about the camera
// axis) and still be "that face" - checking all 24 combinations and picking
// the nearest one means the settle transition is always a small corrective
// nudge into alignment, the way a real die settles, never a large snap to
// an unrelated face.
function nearestFaceOrientation(current) {
    let bestFace = 1;
    let bestQuat = FACE_QUAT[1];
    let bestDot = -Infinity;

    for (let face = 1; face <= 6; face++) {
        for (let k = 0; k < 4; k++) {
            const twist = quatFromAxisAngle(0, 0, 1, k * 90 * DEG2RAD);
            let candidate = quatMul(twist, FACE_QUAT[face]);
            let dot = quatDot(candidate, current);
            if (dot < 0) {
                candidate = quatNegate(candidate);
                dot = -dot;
            }
            if (dot > bestDot) {
                bestDot = dot;
                bestFace = face;
                bestQuat = candidate;
            }
        }
    }

    return { face: bestFace, quat: bestQuat };
}

// Initialize
function init() {
    setupDiceFaces();
    initAudioEngine();
    setupEventListeners();
    renderTransforms();
}

// Generate premium ivory pips on face nodes
function setupDiceFaces() {
    while (dice.firstChild) {
        dice.removeChild(dice.firstChild);
    }

    const pipConfigs = {
        1: [1],
        2: [2, 3],
        3: [1, 2, 3],
        4: [2, 3, 4, 5],
        5: [1, 2, 3, 4, 5],
        6: [2, 3, 4, 5, 6, 7]
    };

    for (let i = 1; i <= 6; i++) {
        const face = document.createElement('div');
        face.classList.add('face', `face${i}`);

        const grid = document.createElement('div');
        grid.classList.add('pip-grid');

        const pips = pipConfigs[i];
        pips.forEach(pos => {
            const pip = document.createElement('span');
            pip.classList.add('pip', `p${pos}`);
            grid.appendChild(pip);
        });

        face.appendChild(grid);
        dice.appendChild(face);
    }
}

// Buffer the roll sound for low-latency Web Audio playback
async function initAudioEngine() {
    try {
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();

        const response = await fetch('dice.mp3');
        const arrayBuffer = await response.arrayBuffer();
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.warn('Web Audio API not supported. Falling back to Audio tag.', e);
    }
}

// Play low-latency sound with randomized pitch shifts and volume
function playRollSound(volume = 1, rateMin = 0.86, rateMax = 1.14) {
    if (audioCtx && audioBuffer) {
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.playbackRate.value = rateMin + Math.random() * (rateMax - rateMin);

        const gain = audioCtx.createGain();
        gain.gain.value = volume;

        source.connect(gain).connect(audioCtx.destination);
        source.start(0);
    } else if (volume >= 1) {
        audioFallback.currentTime = 0;
        audioFallback.play().catch(() => {});
    }
}

// Request true fullscreen on a user gesture (browsers require user activation).
// This is retried on every gesture rather than just once: on Android, the
// very first touchstart of a session frequently gets its fullscreen request
// silently rejected (transient activation isn't reliably granted that
// early), and if that one shot were the only attempt, the app would be
// stuck fullscreen-less for the rest of the session.
function tryEnterFullscreen() {
    if (document.fullscreenElement) return;

    const el = document.documentElement;
    const request = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!request) return;

    const result = request.call(el, { navigationUI: 'hide' });
    if (result && typeof result.catch === 'function') {
        result.catch(err => console.warn('Fullscreen request failed, will retry on next gesture:', err));
    }
}

function dismissHint() {
    if (hintDismissed) return;
    hintDismissed = true;
    hint.classList.add('hidden');
}

// Global Viewport Drag and Swipe events
function setupEventListeners() {
    // Mouse dragging
    dragZone.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', moveDrag);
    window.addEventListener('mouseup', endDrag);

    // Touch dragging (Mobile)
    dragZone.addEventListener('touchstart', startDrag, { passive: false });
    window.addEventListener('touchmove', moveDrag, { passive: false });
    window.addEventListener('touchend', endDrag, { passive: false });
}

function startDrag(e) {
    if (isRolling) return;

    e.preventDefault();
    tryEnterFullscreen();
    dismissHint();

    isDragging = true;

    // Stop any active settle transitions
    diceWrapper.style.transition = 'none';
    dice.style.transition = 'none';
    diceShadow.style.transition = 'none';

    const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;

    startX = clientX;
    startY = clientY;
    lastClientX = clientX;
    lastClientY = clientY;
    lastMoveTime = performance.now();

    dragStartOrientation = { ...orientation };

    velocityX = 0;
    velocityY = 0;
    // Position (posX/posY) is intentionally left untouched: the dice stays
    // exactly where its last roll settled, rather than jumping to center.
}

function moveDrag(e) {
    if (!isDragging || isRolling) return;

    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;

    const now = performance.now();
    const dt = now - lastMoveTime;

    if (dt > 0) {
        // Track dragging velocity
        velocityX = (clientX - lastClientX) / dt;
        velocityY = (clientY - lastClientY) / dt;
    }

    const deltaX = clientX - startX;
    const deltaY = clientY - startY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Trackball-style rotation: roll about the single axis perpendicular to
    // the drag vector, by an angle proportional to drag distance. This is
    // an exact rotation for any drag direction (including diagonals),
    // unlike separately blending independent X/Y Euler angles.
    if (distance > 1e-6) {
        const axis = rollAxisFromDelta(deltaX, deltaY);
        const deltaQuat = quatFromAxisAngle(axis.x, axis.y, axis.z, distance * sensitivity * DEG2RAD);
        orientation = quatNormalize(quatMul(deltaQuat, dragStartOrientation));
        dice.style.transform = quatToMatrix3d(orientation);
    }

    lastClientX = clientX;
    lastClientY = clientY;
    lastMoveTime = now;
}

function endDrag(e) {
    if (!isDragging) return;
    isDragging = false;
    // Some Android builds only grant fullscreen activation on the completed
    // tap rather than the initial touchstart - retry here as a second chance.
    tryEnterFullscreen();

    const clientX = e.type === 'touchend' ? e.changedTouches[0].clientX : e.clientX;
    const clientY = e.type === 'touchend' ? e.changedTouches[0].clientY : e.clientY;

    const deltaX = clientX - startX;
    const deltaY = clientY - startY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    if (distance > SWIPE_THRESHOLD) {
        // Swipe Roll: calculate initial physics translation velocities
        let initialVelX = velocityX * 16;
        let initialVelY = velocityY * 16;

        // Limit velocity to prevent chaotic out-of-bounds speed
        const speed = Math.sqrt(initialVelX * initialVelX + initialVelY * initialVelY);
        const maxSpeed = 26;
        if (speed > maxSpeed) {
            initialVelX = (initialVelX / speed) * maxSpeed;
            initialVelY = (initialVelY / speed) * maxSpeed;
        }

        // Spin axis/speed proportional to swipe velocity - the dice rolls
        // in the direction it was thrown, like an actual die.
        const swipeAngVel = {
            x: -velocityY * 12 * DEG2RAD,
            y: velocityX * 12 * DEG2RAD,
            z: (Math.random() - 0.5) * 6 * DEG2RAD
        };

        launchPhysicsDice(initialVelX, initialVelY, swipeAngVel);
    } else {
        if (distance < 10) {
            // Tap Roll: launch in random direction at high velocity
            const angle = Math.random() * Math.PI * 2;
            const speed = 14 + Math.random() * 8;

            const initialVelX = Math.cos(angle) * speed;
            const initialVelY = Math.sin(angle) * speed;

            const tapAngVel = {
                x: (Math.random() - 0.5) * 36 * DEG2RAD,
                y: (Math.random() - 0.5) * 36 * DEG2RAD,
                z: (Math.random() - 0.5) * 14 * DEG2RAD
            };

            launchPhysicsDice(initialVelX, initialVelY, tapAngVel);
        } else {
            // Cancel roll: settle rotation flush on the current face, but
            // never move the dice from where it currently sits.
            snapToFace(diceValue);
        }
    }
}

// Start the gravity-driven bounce/roll physics loop
function launchPhysicsDice(initialVelX, initialVelY, initialAngVel) {
    if (isRolling) return;
    isRolling = true;

    velX = initialVelX;
    velY = initialVelY;
    angVel = initialAngVel;

    // Throw force determines how high the dice hops off the table -
    // a harder swipe produces a bigger, longer-lived bounce.
    const throwSpeed = Math.sqrt(initialVelX * initialVelX + initialVelY * initialVelY);
    velZ = 6 + Math.min(throwSpeed, 26) * 0.4;
    posZ = 0;

    playRollSound();
    vibrate(14);

    // Disable css transitions for dynamic per-frame calculation
    diceWrapper.style.transition = 'none';
    dice.style.transition = 'none';
    diceShadow.style.transition = 'none';

    if (physicsRequestId) {
        cancelAnimationFrame(physicsRequestId);
    }

    physicsRequestId = requestAnimationFrame(updatePhysicsLoop);
}

// Animation Frame Physics Loop
function updatePhysicsLoop() {
    if (!isRolling) return;

    // --- Vertical (bounce) axis: real gravity + restitution ---
    velZ -= GRAVITY;
    posZ += velZ;

    let justImpacted = false;
    let impactIntensity = 0;
    if (posZ <= 0) {
        posZ = 0;
        if (Math.abs(velZ) > 0.8) {
            // Scale the post-bounce chaos by how hard this particular impact
            // was, using the incoming velocity (not the post-restitution
            // one) - otherwise a nearly-spent final micro-bounce injects the
            // same size of random kick as the first big one, and the dice
            // never settles, just jitters in place indefinitely.
            impactIntensity = Math.min(1, Math.abs(velZ) / 12);
            velZ = -velZ * BOUNCE_RESTITUTION;

            // Each table impact bleeds energy from the roll/spin too,
            // producing real discrete bounces instead of a smooth slide -
            // plus a touch of chaos, since real dice never bounce perfectly
            // predictably.
            velX *= IMPACT_FRICTION;
            velY *= IMPACT_FRICTION;
            angVel.x = angVel.x * IMPACT_FRICTION + (Math.random() - 0.5) * 0.02 * impactIntensity;
            angVel.y = angVel.y * IMPACT_FRICTION + (Math.random() - 0.5) * 0.02 * impactIntensity;
            angVel.z = angVel.z * IMPACT_FRICTION + (Math.random() - 0.5) * 0.02 * impactIntensity;
            justImpacted = true;
        } else {
            velZ = 0;
        }
    }

    if (justImpacted) {
        playRollSound(Math.min(0.55, 0.18 + impactIntensity * 0.4), 1.05, 1.45);
        vibrate(Math.round(6 + impactIntensity * 18));
    }

    // --- Horizontal axes: drag is lighter while airborne, heavier once grounded ---
    const drag = posZ > 0 ? AIR_DRAG : GROUND_DRAG;
    velX *= drag;
    velY *= drag;
    angVel.x *= drag;
    angVel.y *= drag;
    angVel.z *= drag;

    posX += velX;
    posY += velY;
    orientation = integrateOrientation(orientation, angVel);

    // Viewport boundary collisions
    const width = window.innerWidth;
    const height = window.innerHeight;
    const limitX = (width - DICE_SIZE) / 2;
    const limitY = (height - DICE_SIZE) / 2;

    if (posX > limitX) {
        posX = limitX;
        velX = -velX * 0.76;
    } else if (posX < -limitX) {
        posX = -limitX;
        velX = -velX * 0.76;
    }

    if (posY > limitY) {
        posY = limitY;
        velY = -velY * 0.76;
    } else if (posY < -limitY) {
        posY = -limitY;
        velY = -velY * 0.76;
    }

    renderTransforms();

    // Check if the dice has come to rest on the table
    const linearSpeed = Math.sqrt(velX * velX + velY * velY);
    const angularSpeed = Math.sqrt(angVel.x * angVel.x + angVel.y * angVel.y + angVel.z * angVel.z);

    if (posZ === 0 && linearSpeed < SETTLE_LINEAR && angularSpeed < SETTLE_ANGULAR && Math.abs(velZ) < SETTLE_VELZ) {
        settleDice();
    } else {
        physicsRequestId = requestAnimationFrame(updatePhysicsLoop);
    }
}

// Push the current physics state to the DOM. posZ is real depth toward the
// camera - the perspective on the .stage does the foreshortening/scale
// math natively, rather than a hand-rolled approximation.
function renderTransforms() {
    diceWrapper.style.transform = `translate3d(${posX}px, ${posY}px, ${posZ}px)`;
    dice.style.transform = quatToMatrix3d(orientation);

    const shadowScale = Math.max(0.35, 1 - posZ * 0.006);
    const shadowOpacity = Math.max(0.15, 1 - posZ * 0.009);
    diceShadow.style.transform = `translate3d(${posX}px, ${posY}px, 0) scale(${shadowScale})`;
    diceShadow.style.opacity = shadowOpacity;
}

// Settle roll: resolve to a flush, corner-free face - in place, no re-centering
function settleDice() {
    if (physicsRequestId) {
        cancelAnimationFrame(physicsRequestId);
        physicsRequestId = null;
    }

    // The result is read off the physics itself - whichever face the tumble
    // actually left closest to the camera - rather than an independent
    // random pick forced onto the dice after the fact. Forcing an unrelated
    // random result meant the settle could require snapping to a totally
    // different face than where the tumble stopped, which looked exactly
    // like an unnatural "reroll" right at the end. Reading the real resting
    // face means the correction is always just a small nudge into exact
    // alignment, the way an actual die settles.
    const { face, quat } = nearestFaceOrientation(orientation);
    diceValue = face;

    // Re-enable smooth transition animations
    diceWrapper.style.transition = 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1)';
    dice.style.transition = 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1)';
    diceShadow.style.transition = 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.5s ease';

    // Rest flat on the table exactly where it landed
    posZ = 0;
    velZ = 0;
    angVel = { x: 0, y: 0, z: 0 };

    // The browser's native transform interpolation decomposes the matrix
    // and slerps its rotation component, so this transition glides from
    // wherever the tumble stopped straight to the exact flush orientation -
    // one full face, never a corner or edge, facing the camera - via the
    // shortest possible path (quat sign already corrected above).
    orientation = quat;

    renderTransforms();
    vibrate([10, 40, 15]);

    setTimeout(() => {
        isRolling = false;
    }, 500);
}

// Cancel a small drag: settle rotation flush without moving the dice at all
function snapToFace(faceVal) {
    dice.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';

    orientation = { ...FACE_QUAT[faceVal] };
    dice.style.transform = quatToMatrix3d(orientation);
}

// Run
window.onload = init;
