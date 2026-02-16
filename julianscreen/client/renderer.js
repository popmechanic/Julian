// JulianScreen — 4-layer canvas compositing engine + command dispatcher

const SCREEN_W = 640;
const SCREEN_H = 480;
const TILE_SIZE = 32;
const COLS = 20;
const ROWS = 15;

// Palette (indexed colors)
const PALETTE = [
  'transparent',   // 0
  '#FFD600',       // 1 — Julian yellow
  '#0F0F0F',       // 2 — near-black
  '#FFFFFF',       // 3 — white
  '#FF4444',       // 4 — red
  '#44FF44',       // 5 — green
  '#4488FF',       // 6 — blue
  '#FF88FF',       // 7 — pink
  '#FFAA00',       // 8 — orange
  '#00CCCC',       // 9 — cyan
  '#8844FF',       // 10 — purple
  '#888888',       // 11 — gray
  '#444444',       // 12 — dark gray
  '#CCCCCC',       // 13 — light gray
  '#664400',       // 14 — brown
  '#226622',       // 15 — dark green
];

// Create offscreen layers
function createLayer() {
  const c = document.createElement('canvas');
  c.width = SCREEN_W;
  c.height = SCREEN_H;
  return { canvas: c, ctx: c.getContext('2d') };
}

const bgLayer = createLayer();
const drawLayer = createLayer();
const spriteLayer = createLayer();
const uiLayer = createLayer();

// Main canvas (set up by init)
let mainCanvas, mainCtx;

// Current draw color index
let drawColorIndex = 1;

// Command queue with async processing (for W wait support)
let commandQueue = [];
let processing = false;

// Handler registry — filled by other modules
const handlers = {};

function registerHandler(type, fn) {
  handlers[type] = fn;
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (commandQueue.length > 0) {
    const cmd = commandQueue.shift();

    if (cmd.type === 'WAIT') {
      await new Promise(r => setTimeout(r, cmd.ms));
      continue;
    }

    const handler = handlers[cmd.type];
    if (handler) {
      handler(cmd);
    } else {
      console.warn('[renderer] No handler for:', cmd.type);
    }
  }

  processing = false;
}

function enqueueCommands(commands) {
  commandQueue.push(...commands);
  processQueue();
}

// Compositing
function composite() {
  mainCtx.fillStyle = '#0F0F0F';
  mainCtx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  mainCtx.drawImage(bgLayer.canvas, 0, 0);
  mainCtx.drawImage(drawLayer.canvas, 0, 0);
  mainCtx.drawImage(spriteLayer.canvas, 0, 0);
  mainCtx.drawImage(uiLayer.canvas, 0, 0);
}

// Animation loop
let lastTime = 0;
const TARGET_FPS = 30;
const FRAME_TIME = 1000 / TARGET_FPS;

function animLoop(time) {
  if (time - lastTime >= FRAME_TIME) {
    lastTime = time;

    // Clear sprite layer each frame (redrawn by animation)
    spriteLayer.ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);

    // Tick animations
    if (window.JScreen?.tickAnimations) {
      window.JScreen.tickAnimations(time);
    }

    composite();
  }
  requestAnimationFrame(animLoop);
}

// Drawing primitives
function drawRect(cmd) {
  drawLayer.ctx.fillStyle = PALETTE[drawColorIndex] || PALETTE[1];
  drawLayer.ctx.fillRect(cmd.x, cmd.y, cmd.w, cmd.h);
}

function drawCirc(cmd) {
  const ctx = drawLayer.ctx;
  const color = PALETTE[drawColorIndex] || PALETTE[1];
  // Bresenham midpoint circle
  let x = cmd.r, y = 0, d = 1 - cmd.r;
  ctx.fillStyle = color;
  while (x >= y) {
    ctx.fillRect(cmd.x + x, cmd.y + y, 1, 1);
    ctx.fillRect(cmd.x - x, cmd.y + y, 1, 1);
    ctx.fillRect(cmd.x + x, cmd.y - y, 1, 1);
    ctx.fillRect(cmd.x - x, cmd.y - y, 1, 1);
    ctx.fillRect(cmd.x + y, cmd.y + x, 1, 1);
    ctx.fillRect(cmd.x - y, cmd.y + x, 1, 1);
    ctx.fillRect(cmd.x + y, cmd.y - x, 1, 1);
    ctx.fillRect(cmd.x - y, cmd.y - x, 1, 1);
    y++;
    if (d <= 0) {
      d += 2 * y + 1;
    } else {
      x--;
      d += 2 * (y - x) + 1;
    }
  }
}

function drawLine(cmd) {
  const ctx = drawLayer.ctx;
  ctx.fillStyle = PALETTE[drawColorIndex] || PALETTE[1];
  // Bresenham line
  let x0 = cmd.x1, y0 = cmd.y1, x1 = cmd.x2, y1 = cmd.y2;
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function drawDot(cmd) {
  drawLayer.ctx.fillStyle = PALETTE[drawColorIndex] || PALETTE[1];
  drawLayer.ctx.fillRect(cmd.x, cmd.y, 1, 1);
}

function clearDraw() {
  drawLayer.ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
}

function setColor(cmd) {
  drawColorIndex = cmd.index;
}

// Init
let initialized = false;
function init(canvas) {
  mainCanvas = canvas;
  window.JScreen._canvas = canvas;
  mainCtx = canvas.getContext('2d');
  mainCtx.imageSmoothingEnabled = false;

  if (!initialized) {
    initialized = true;
    // Register drawing primitive handlers
    registerHandler('RECT', drawRect);
    registerHandler('CIRC', drawCirc);
    registerHandler('LINE', drawLine);
    registerHandler('DOT', drawDot);
    registerHandler('CLR', clearDraw);
    registerHandler('COL', setColor);

    requestAnimationFrame(animLoop);
  }
}

// Export as global
window.JScreen = {
  init,
  registerHandler,
  enqueueCommands,
  bgLayer,
  drawLayer,
  spriteLayer,
  uiLayer,
  SCREEN_W,
  SCREEN_H,
  TILE_SIZE,
  COLS,
  ROWS,
  PALETTE,
  tickAnimations: null,
  _canvas: null,
};
