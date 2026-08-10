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

// Gestures State
let isDragging = false;
let startX = 0;
let startY = 0;
let currentRotateX = 0;
let currentRotateY = 0;
let currentRotateZ = 0;
let dragRotateX = 0;
let dragRotateY = 0;
let lastMoveTime = 0;
let velocityX = 0;
let velocityY = 0;
let lastClientX = 0;
let lastClientY = 0;

// Physics Simulation State
let isRolling = false;
let diceValue = 1;
let posX = 0;
let posY = 0;
let posZ = 0;   // Height above the table (bounce)
let velX = 0;
let velY = 0;
let velZ = 0;   // Vertical (bounce) velocity
let spinX = 0;
let spinY = 0;
let spinZ = 0;
let physicsRequestId = null;
let hintDismissed = false;
let fullscreenAttempted = false;

const sensitivity = 0.4;
const SWIPE_THRESHOLD = 30; // Min px to trigger swipe physics

// Real-world-ish bounce constants
const GRAVITY = 1.15;              // Downward accel applied to velZ each frame
const BOUNCE_RESTITUTION = 0.5;    // Vertical velocity kept after hitting the table
const IMPACT_FRICTION = 0.72;      // Spin/slide energy kept after each table impact
const AIR_DRAG = 0.999;            // Drag while airborne
const GROUND_DRAG = 0.90;          // Drag while rolling on the table (real dice stop fast)
const LIFT_PX_PER_UNIT = 1.4;      // Visual px of upward offset per posZ unit
const SCALE_PER_UNIT = 0.0025;     // Perspective "closer to camera" scale per posZ unit

// Geometrically correct physical face rotations (Opposite sides sum to 7)
// Face 1: Front (0, 0)
// Face 2: Right (0, -90)
// Face 3: Top (-90, 0)
// Face 4: Bottom (90, 0)
// Face 5: Left (0, 90)
// Face 6: Back (0, -180)
const faceRotations = {
    1: { x: 0, y: 0 },
    2: { x: 0, y: -90 },
    3: { x: -90, y: 0 },
    4: { x: 90, y: 0 },
    5: { x: 0, y: 90 },
    6: { x: 0, y: -180 }
};

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

// Request true fullscreen on the very first gesture (browsers require user activation)
function tryEnterFullscreen() {
    if (fullscreenAttempted) return;
    fullscreenAttempted = true;

    const el = document.documentElement;
    const request = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;

    if (request && !document.fullscreenElement) {
        request.call(el).catch(() => {});
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

    dragRotateX = currentRotateX;
    dragRotateY = currentRotateY;

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

    // Map dragging offsets to 3D cube rotation angles
    currentRotateY = dragRotateY + deltaX * sensitivity;
    currentRotateX = dragRotateX - deltaY * sensitivity;

    dice.style.transform = `rotateX(${currentRotateX}deg) rotateY(${currentRotateY}deg) rotateZ(${currentRotateZ}deg)`;

    lastClientX = clientX;
    lastClientY = clientY;
    lastMoveTime = now;
}

function endDrag(e) {
    if (!isDragging) return;
    isDragging = false;

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

        // Spin speeds proportional to swipe velocity
        const swipeSpinX = -velocityY * 12;
        const swipeSpinY = velocityX * 12;
        const swipeSpinZ = (Math.random() - 0.5) * 6;

        launchPhysicsDice(initialVelX, initialVelY, swipeSpinX, swipeSpinY, swipeSpinZ);
    } else {
        if (distance < 10) {
            // Tap Roll: launch in random direction at high velocity
            const angle = Math.random() * Math.PI * 2;
            const speed = 14 + Math.random() * 8;

            const initialVelX = Math.cos(angle) * speed;
            const initialVelY = Math.sin(angle) * speed;

            const swipeSpinX = (Math.random() - 0.5) * 36;
            const swipeSpinY = (Math.random() - 0.5) * 36;
            const swipeSpinZ = (Math.random() - 0.5) * 14;

            launchPhysicsDice(initialVelX, initialVelY, swipeSpinX, swipeSpinY, swipeSpinZ);
        } else {
            // Cancel roll: settle rotation flush on the current face, but
            // never move the dice from where it currently sits.
            snapToFace(diceValue);
        }
    }
}

// Start the gravity-driven bounce/roll physics loop
function launchPhysicsDice(initialVelX, initialVelY, initialSpinX, initialSpinY, initialSpinZ) {
    if (isRolling) return;
    isRolling = true;

    velX = initialVelX;
    velY = initialVelY;
    spinX = initialSpinX;
    spinY = initialSpinY;
    spinZ = initialSpinZ;

    // Throw force determines how high the dice hops off the table -
    // a harder swipe produces a bigger, longer-lived bounce.
    const throwSpeed = Math.sqrt(initialVelX * initialVelX + initialVelY * initialVelY);
    velZ = 3 + Math.min(throwSpeed, 26) * 0.27;
    posZ = 0;

    playRollSound();

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
    if (posZ <= 0) {
        posZ = 0;
        if (Math.abs(velZ) > 0.8) {
            velZ = -velZ * BOUNCE_RESTITUTION;
            // Each table impact bleeds energy from the roll/spin too,
            // producing real discrete bounces instead of a smooth slide.
            velX *= IMPACT_FRICTION;
            velY *= IMPACT_FRICTION;
            spinX *= IMPACT_FRICTION;
            spinY *= IMPACT_FRICTION;
            spinZ *= IMPACT_FRICTION;
            justImpacted = true;
        } else {
            velZ = 0;
        }
    }

    if (justImpacted) {
        playRollSound(Math.min(0.55, 0.18 + Math.abs(velZ) * 0.03), 1.05, 1.45);
    }

    // --- Horizontal axes: drag is lighter while airborne, heavier once grounded ---
    const drag = posZ > 0 ? AIR_DRAG : GROUND_DRAG;
    velX *= drag;
    velY *= drag;
    spinX *= drag;
    spinY *= drag;
    spinZ *= drag;

    posX += velX;
    posY += velY;
    currentRotateX += spinX;
    currentRotateY += spinY;
    currentRotateZ += spinZ;

    // Viewport boundary collisions
    const width = window.innerWidth;
    const height = window.innerHeight;
    const limitX = (width - 176) / 2;
    const limitY = (height - 176) / 2;

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
    const angularSpeed = Math.sqrt(spinX * spinX + spinY * spinY + spinZ * spinZ);

    if (posZ === 0 && linearSpeed < 0.15 && angularSpeed < 0.15 && Math.abs(velZ) < 0.05) {
        settleDice();
    } else {
        physicsRequestId = requestAnimationFrame(updatePhysicsLoop);
    }
}

// Push the current physics state to the DOM
function renderTransforms() {
    const lift = posZ * LIFT_PX_PER_UNIT;
    const scale = 1 + posZ * SCALE_PER_UNIT;

    diceWrapper.style.transform = `translate3d(${posX}px, ${posY - lift}px, 0) scale(${scale})`;
    dice.style.transform = `rotateX(${currentRotateX}deg) rotateY(${currentRotateY}deg) rotateZ(${currentRotateZ}deg)`;

    const shadowScale = Math.max(0.32, 1 - posZ * 0.014);
    const shadowOpacity = Math.max(0.12, 1 - posZ * 0.022);
    diceShadow.style.transform = `translate3d(${posX}px, ${posY}px, 0) scale(${shadowScale})`;
    diceShadow.style.opacity = shadowOpacity;
}

// Settle roll: resolve to a flush, corner-free face - in place, no re-centering
function settleDice() {
    if (physicsRequestId) {
        cancelAnimationFrame(physicsRequestId);
        physicsRequestId = null;
    }

    const roll = Math.floor(Math.random() * 6) + 1;
    diceValue = roll;

    // Re-enable smooth transition animations
    diceWrapper.style.transition = 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1)';
    dice.style.transition = 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1)';
    diceShadow.style.transition = 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.5s ease';

    // Rest flat on the table exactly where it landed
    posZ = 0;
    velZ = 0;

    // Snap rotations to the nearest geometrically-correct flush orientation,
    // so one full face - never a corner or edge - faces the camera.
    const snapMultipleX = Math.round(currentRotateX / 360) * 360;
    const snapMultipleY = Math.round(currentRotateY / 360) * 360;

    const targetOffset = faceRotations[roll];
    currentRotateX = snapMultipleX + targetOffset.x;
    currentRotateY = snapMultipleY + targetOffset.y;
    currentRotateZ = 0;

    renderTransforms();

    setTimeout(() => {
        isRolling = false;
    }, 500);
}

// Cancel a small drag: settle rotation flush without moving the dice at all
function snapToFace(faceVal) {
    dice.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';

    const snapMultipleX = Math.round(currentRotateX / 360) * 360;
    const snapMultipleY = Math.round(currentRotateY / 360) * 360;

    const targetOffset = faceRotations[faceVal];
    currentRotateX = snapMultipleX + targetOffset.x;
    currentRotateY = snapMultipleY + targetOffset.y;
    currentRotateZ = 0;

    dice.style.transform = `rotateX(${currentRotateX}deg) rotateY(${currentRotateY}deg) rotateZ(0deg)`;
}

// Run
window.onload = init;
