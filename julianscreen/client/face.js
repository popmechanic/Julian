// JulianScreen — Face Mode
// Renders the PixelFace (from chat.jsx) scaled huge on the sprite layer.
// The 32x32 pixel face fills ~80% of the 640x480 screen.
// Each source pixel becomes a SCALE×SCALE block.

// ── Face Pixel Data (copied from chat.jsx PixelFace) ───────────────────

const FACE_EYES = {
  left: [
    [8,10],[9,10],[10,10],
    [7,11],[11,11],
    [7,12],[11,12],[12,12],
    [7,13],[8,13],[12,13],
    [7,14],[12,14],
    [8,15],[9,15],[10,15],[11,15]
  ],
  right: [
    [20,9],[21,9],[22,9],
    [19,10],[23,10],
    [19,11],[23,11],
    [19,12],[23,12],
    [19,13],[23,13],
    [20,14],[21,14],[22,14]
  ],
};

const FACE_MOUTH = {
  idle: [
    [6,20],
    [6,21],[7,21],
    [7,22],[8,22],
    [8,23],[9,23],[10,23],[11,23],[12,23],[13,23],[14,23],[15,23],[16,23],[17,23],
    [18,22],[19,22],
    [20,21],[21,21],
    [22,20],[23,20],[24,19]
  ],
  happy: [
    [6,19],
    [6,20],[7,20],
    [7,21],[8,21],
    [8,22],[9,22],[10,22],[11,22],[12,22],[13,22],[14,22],[15,22],[16,22],[17,22],[18,22],
    [19,21],[20,21],
    [21,20],[22,20],
    [23,19]
  ],
  sad: [
    [10,24],[11,24],[12,24],[13,24],[14,24],
    [9,23],[15,23],
    [8,22],[16,22],
    [7,21],[17,21],
    [7,20],[18,20]
  ],
  talk1: [
    [10,20],[11,20],[12,20],[13,20],[14,20],
    [9,21],[15,21],
    [9,22],[15,22],
    [9,23],[15,23],
    [10,24],[11,24],[12,24],[13,24],[14,24]
  ],
  talk2: [
    [11,22],[12,22],[13,22]
  ],
};

// Happy eyes — crescent shapes
const FACE_HAPPY_EYES = {
  left: [
    [8,13],[9,13],[10,13],
    [7,12],[11,12],
    [7,11],[11,11],
  ],
  right: [
    [20,12],[21,12],[22,12],
    [19,11],[23,11],
    [19,10],[23,10],
  ],
};

// Thinking eyes — looking up-left
const FACE_THINKING_EYES = {
  left: [
    [7,10],[8,10],[9,10],
    [6,11],[10,11],
    [6,12],[7,12],[10,12],
    [6,13],[10,13],
    [7,14],[8,14],[9,14]
  ],
  right: [
    [19,9],[20,9],[21,9],
    [18,10],[22,10],
    [18,11],[19,11],[22,11],
    [18,12],[22,12],
    [19,13],[20,13],[21,13]
  ],
};

// Thinking mouth — small, pursed
const FACE_THINKING_MOUTH = [
  [11,21],[12,21],[13,21],
  [10,22],[14,22],
  [11,23],[12,23],[13,23]
];

// Thinking dots (the "..." that float to the upper right)
const FACE_THINKING_DOTS = [
  [[25,8]],
  [[25,8],[27,6]],
  [[25,8],[27,6],[29,4]],
];

// Sad eyes — drooped
const FACE_SAD_EYES = {
  left: [
    [9,11],[10,11],[11,11],
    [8,12],[12,12],
    [8,13],[12,13],
    [8,14],[9,14],[12,14],
    [9,15],[10,15],[11,15]
  ],
  right: [
    [20,10],[21,10],[22,10],
    [19,11],[23,11],
    [19,12],[23,12],
    [19,13],[20,13],[23,13],
    [20,14],[21,14],[22,14]
  ],
};

// ── Face Mode State ────────────────────────────────────────────────────

let faceActive = false;
let faceState = 'idle'; // idle, talking, thinking, happy, sad
let blinking = false;
let nextBlink = performance.now() + 2000 + Math.random() * 3000;
let blinkEnd = 0;
let thinkDotPhase = 0;
let thinkDotTimer = 0;

// Scale: 32px source → 80% of 480 = 384px → scale factor 12
const SCALE = 12;
// Center the 32*12=384 face on the 640x480 screen
const OFFSET_X = Math.floor((640 - 32 * SCALE) / 2);
const OFFSET_Y = Math.floor((480 - 32 * SCALE) / 2);

// ── Rendering ──────────────────────────────────────────────────────────

function drawFacePixels(ctx, pixels, color) {
  ctx.fillStyle = color;
  for (const [x, y] of pixels) {
    ctx.fillRect(OFFSET_X + x * SCALE, OFFSET_Y + y * SCALE, SCALE, SCALE);
  }
}

function renderFace(ctx, timestamp) {
  const ON = '#FFD600';

  // Choose eyes based on state
  let eyes = FACE_EYES;
  if (faceState === 'happy') eyes = FACE_HAPPY_EYES;
  if (faceState === 'thinking') eyes = FACE_THINKING_EYES;
  if (faceState === 'sad') eyes = FACE_SAD_EYES;

  // Draw eyes (skip if blinking, unless happy — happy eyes don't blink)
  if (!blinking || faceState === 'happy') {
    drawFacePixels(ctx, eyes.left, ON);
    drawFacePixels(ctx, eyes.right, ON);
  }

  // Draw mouth based on state
  if (faceState === 'talking') {
    // Alternate between open and closed mouth
    if (Math.floor(timestamp / 150) % 2 === 0) {
      drawFacePixels(ctx, FACE_MOUTH.talk1, ON);
    } else {
      drawFacePixels(ctx, FACE_MOUTH.talk2, ON);
    }
  } else if (faceState === 'thinking') {
    drawFacePixels(ctx, FACE_THINKING_MOUTH, ON);
    // Animate thinking dots
    thinkDotTimer += 16;
    if (thinkDotTimer > 600) {
      thinkDotTimer = 0;
      thinkDotPhase = (thinkDotPhase + 1) % 4;
    }
    if (thinkDotPhase > 0 && thinkDotPhase <= 3) {
      drawFacePixels(ctx, FACE_THINKING_DOTS[thinkDotPhase - 1], ON);
    }
  } else if (faceState === 'happy') {
    drawFacePixels(ctx, FACE_MOUTH.happy, ON);
  } else if (faceState === 'sad') {
    drawFacePixels(ctx, FACE_MOUTH.sad, ON);
  } else {
    // idle
    drawFacePixels(ctx, FACE_MOUTH.idle, ON);
  }

  // Blink logic (not during happy)
  if (faceState !== 'happy') {
    const now = timestamp;
    if (blinking) {
      if (now >= blinkEnd) {
        blinking = false;
        nextBlink = now + 2000 + Math.random() * 3000;
      }
    } else if (now >= nextBlink) {
      blinking = true;
      blinkEnd = now + 120;
    }
  }
}

// ── Module Init ────────────────────────────────────────────────────────

function initFace() {
  const JS = window.JScreen;

  // Register FACE command handler
  JS.registerHandler('FACE', (cmd) => {
    if (cmd.mode === 'on') {
      faceActive = true;
      faceState = cmd.state || 'idle';
      // Clear background to black for clean face display
      JS.bgLayer.ctx.clearRect(0, 0, 640, 480);
      // Clear draw layer
      JS.drawLayer.ctx.clearRect(0, 0, 640, 480);
    } else if (cmd.mode === 'off') {
      faceActive = false;
    } else if (cmd.mode === 'state') {
      faceState = cmd.state || 'idle';
      if (cmd.state === 'thinking') {
        thinkDotPhase = 0;
        thinkDotTimer = 0;
      }
    }
  });

  // Expose face state for other modules
  JS.isFaceMode = () => faceActive;

  // Chain onto tickAnimations
  const prevTick = JS.tickAnimations;
  JS.tickAnimations = function tickFace(timestamp) {
    if (faceActive) {
      // In face mode, render the big face on the sprite layer
      // (sprite layer is cleared each frame by the animation loop)
      renderFace(JS.spriteLayer.ctx, timestamp);
      // Don't call prevTick — face mode replaces the normal avatar
      return;
    }
    // Normal mode — chain to previous tick (avatar sprites, etc.)
    if (prevTick) prevTick(timestamp);
  };
}

// Auto-init when JScreen is ready
if (window.JScreen) {
  initFace();
} else {
  window.addEventListener('load', initFace);
}
