// JulianScreen — tile background system + scene presets
(function() {

let tileData = null;       // loaded from /sprites/tiles.json
let tileGrid = [];         // [ROWS][COLS] of tile name strings
let dirty = true;          // redraw flag
let waterFrame = 0;        // 0 or 1 for animated water
let lastWaterSwap = 0;     // timestamp of last water frame toggle

const WATER_INTERVAL = 500; // ms between water frame swaps
const T_ROWS = 6;
const T_COLS = 8;
const T_TILE = 16;

// Scene presets: fill the entire 6x8 grid
const SCENES = {
  home:     { 0:'wall',  1:'wall',  2:'floor', 3:'floor', 4:'floor', 5:'floor' },
  outside:  { 0:'sky',   1:'sky',   2:'sky',   3:'grass', 4:'grass', 5:'grass' },
  night:    { 0:'stars', 1:'stars', 2:'stars', 3:'stars', 4:'stars', 5:'stars' },
  rain:     { 0:'sky',   1:'sky',   2:'sky',   3:'grass', 4:'grass', 5:'grass' },
  empty:    { 0:'empty', 1:'empty', 2:'empty', 3:'empty', 4:'empty', 5:'empty' },
  terminal: { 0:'grid',  1:'grid',  2:'grid',  3:'grid',  4:'grid',  5:'grid'  },
  space:    { 0:'stars', 1:'stars', 2:'stars', 3:'stars', 4:'dots',  5:'dots'  },
};

// Initialize grid to all empty
function initGrid() {
  tileGrid = [];
  for (let r = 0; r < T_ROWS; r++) {
    tileGrid[r] = [];
    for (let c = 0; c < T_COLS; c++) {
      tileGrid[r][c] = 'empty';
    }
  }
}

// Apply a scene preset
function applyScene(name) {
  const scene = SCENES[name];
  if (!scene) { console.warn('[tiles] Unknown scene:', name); return; }
  for (let r = 0; r < T_ROWS; r++) {
    const tileName = scene[r] || 'empty';
    for (let c = 0; c < T_COLS; c++) {
      tileGrid[r][c] = tileName;
    }
  }
  dirty = true;
}

// Render all tiles to bgLayer
function drawTileGrid() {
  const ctx = window.JScreen.bgLayer.ctx;
  const PAL = window.JScreen.PALETTE;
  ctx.clearRect(0, 0, 128, 96);

  for (let r = 0; r < T_ROWS; r++) {
    for (let c = 0; c < T_COLS; c++) {
      let name = tileGrid[r][c];
      // Animated water: swap frame
      if (name === 'water') name = 'water_' + waterFrame;
      const data = tileData?.[name];
      if (!data) continue;

      const ox = c * T_TILE;
      const oy = r * T_TILE;
      for (let i = 0; i < 256; i++) {
        const v = data[i];
        if (v === 0) continue; // transparent
        ctx.fillStyle = PAL[v];
        ctx.fillRect(ox + (i % 16), oy + ((i / 16) | 0), 1, 1);
      }
    }
  }
}

// Check if any cell has animated tiles
function hasAnimatedTiles() {
  for (let r = 0; r < T_ROWS; r++) {
    for (let c = 0; c < T_COLS; c++) {
      if (tileGrid[r][c] === 'water') return true;
    }
  }
  return false;
}

// Animation tick — called from JScreen.tickAnimations
function tick(time) {
  // Cycle water frames
  if (hasAnimatedTiles() && time - lastWaterSwap >= WATER_INTERVAL) {
    waterFrame = 1 - waterFrame;
    lastWaterSwap = time;
    dirty = true;
  }

  if (dirty && tileData) {
    drawTileGrid();
    dirty = false;
  }
}

// Load tile data and wire everything up
async function initTiles() {
  initGrid();

  try {
    const resp = await fetch('/sprites/tiles.json');
    tileData = await resp.json();
  } catch (e) {
    console.error('[tiles] Failed to load tile data:', e);
    return;
  }

  // Register command handlers
  window.JScreen.registerHandler('SCENE', (cmd) => {
    applyScene(cmd.scene);
  });

  window.JScreen.registerHandler('TILEROW', (cmd) => {
    const row = cmd.row;
    if (row < 0 || row >= T_ROWS) return;
    const tiles = cmd.tiles; // array of tile names, length up to COLS
    if (!Array.isArray(tiles)) return;
    for (let c = 0; c < T_COLS && c < tiles.length; c++) {
      tileGrid[row][c] = tiles[c];
    }
    dirty = true;
  });

  // Chain into animation loop (preserve existing tickAnimations)
  const prevTick = window.JScreen.tickAnimations;
  window.JScreen.tickAnimations = function(time) {
    if (prevTick) prevTick(time);
    tick(time);
  };

  dirty = true;
}

// Auto-init when loaded
initTiles();

})();
