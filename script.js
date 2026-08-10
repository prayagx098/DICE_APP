// DOM Elements
const dragZone = document.getElementById('swipe-zone');
const dice = document.getElementById('dice');
const diceWrapper = document.getElementById('dice-wrapper');
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
let velX = 0;
let velY = 0;
let spinX = 0;
let spinY = 0;
let spinZ = 0;
let physicsRequestId = null;

const sensitivity = 0.4;
const SWIPE_THRESHOLD = 30; // Min px to trigger swipe physics

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

// Play low-latency sound with randomized pitch shifts
function playRollSound() {
    if (audioCtx && audioBuffer) {
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        
        // Randomize pitch multiplier (0.86 to 1.14) for realistic roll variants
        source.playbackRate.value = 0.86 + Math.random() * 0.28;
        
        source.connect(audioCtx.destination);
        source.start(0);
    } else {
        audioFallback.currentTime = 0;
        audioFallback.play().catch(e => {});
    }
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

    isDragging = true;
    
    // Stop any active settle transitions
    diceWrapper.style.transition = 'none';
    dice.style.transition = 'none';

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
    
    posX = 0;
    posY = 0;
    diceWrapper.style.transform = 'translate3d(0px, 0px, 0)';
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
        const maxSpeed = 24;
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
            // Cancel roll: snap back smoothly
            snapToFace(diceValue);
        }
    }
}

// Start Bouncing physics loop
function launchPhysicsDice(initialVelX, initialVelY, initialSpinX, initialSpinY, initialSpinZ) {
    if (isRolling) return;
    isRolling = true;

    // Reset loop variables
    posX = 0;
    posY = 0;
    velX = initialVelX;
    velY = initialVelY;
    spinX = initialSpinX;
    spinY = initialSpinY;
    spinZ = initialSpinZ;

    playRollSound();

    // Disable css transitions for dynamic calculation
    diceWrapper.style.transition = 'none';
    dice.style.transition = 'none';
    
    // Add visual container shake during bounces
    document.querySelector('.diceContainer').classList.add('shaking');

    if (physicsRequestId) {
        cancelAnimationFrame(physicsRequestId);
    }
    
    physicsRequestId = requestAnimationFrame(updatePhysicsLoop);
}

// Animation Frame Physics Loop
function updatePhysicsLoop() {
    if (!isRolling) return;

    // Apply deceleration friction (decay multiplier per frame)
    velX *= 0.982;
    velY *= 0.982;
    spinX *= 0.982;
    spinY *= 0.982;
    spinZ *= 0.982;

    posX += velX;
    posY += velY;
    currentRotateX += spinX;
    currentRotateY += spinY;
    currentRotateZ += spinZ;

    // Viewport Boundary collisions
    const width = window.innerWidth;
    const height = window.innerHeight;
    const limitX = (width - 160) / 2;
    const limitY = (height - 160) / 2;

    let wallImpact = false;

    // Left/Right walls
    if (posX > limitX) {
        posX = limitX;
        velX = -velX * 0.76; // Reverse direction with 24% bounce energy loss
        wallImpact = true;
    } else if (posX < -limitX) {
        posX = -limitX;
        velX = -velX * 0.76;
        wallImpact = true;
    }

    // Top/Bottom walls
    if (posY > limitY) {
        posY = limitY;
        velY = -velY * 0.76;
        wallImpact = true;
    } else if (posY < -limitY) {
        posY = -limitY;
        velY = -velY * 0.76;
        wallImpact = true;
    }

    // Apply translation to wrapper & 3D rotation to the inner cube
    diceWrapper.style.transform = `translate3d(${posX}px, ${posY}px, 0)`;
    dice.style.transform = `rotateX(${currentRotateX}deg) rotateY(${currentRotateY}deg) rotateZ(${currentRotateZ}deg)`;

    // Check if the dice has slowed down enough to settle
    const linearSpeed = Math.sqrt(velX * velX + velY * velY);
    const angularSpeed = Math.sqrt(spinX * spinX + spinY * spinY + spinZ * spinZ);

    if (linearSpeed < 0.22 && angularSpeed < 0.22) {
        settleDice();
    } else {
        physicsRequestId = requestAnimationFrame(updatePhysicsLoop);
    }
}

// Settle roll, snap flat and return to center
function settleDice() {
    if (physicsRequestId) {
        cancelAnimationFrame(physicsRequestId);
        physicsRequestId = null;
    }

    // Settle target random result
    const roll = Math.floor(Math.random() * 6) + 1;
    diceValue = roll;

    // Re-enable smooth transition animations
    diceWrapper.style.transition = 'transform 0.6s cubic-bezier(0.25, 1, 0.5, 1)';
    dice.style.transition = 'transform 0.6s cubic-bezier(0.25, 1, 0.5, 1)';

    // 1. Pull the translated wrapper back to the viewport center (0, 0)
    posX = 0;
    posY = 0;
    diceWrapper.style.transform = 'translate3d(0px, 0px, 0)';

    // 2. Snap rotations flat matching geometrically correct angles
    const snapMultipleX = Math.round(currentRotateX / 360) * 360;
    const snapMultipleY = Math.round(currentRotateY / 360) * 360;

    const targetOffset = faceRotations[roll];
    currentRotateX = snapMultipleX + targetOffset.x;
    currentRotateY = snapMultipleY + targetOffset.y;
    currentRotateZ = 0;

    dice.style.transform = `rotateX(${currentRotateX}deg) rotateY(${currentRotateY}deg) rotateZ(0deg)`;

    setTimeout(() => {
        document.querySelector('.diceContainer').classList.remove('shaking');
        isRolling = false;
    }, 600);
}

// Snap back to face when swipe cancels
function snapToFace(faceVal) {
    diceWrapper.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
    dice.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';

    posX = 0;
    posY = 0;
    diceWrapper.style.transform = 'translate3d(0px, 0px, 0)';

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
