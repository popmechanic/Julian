// JulianScreen — sprite engine + avatar + items
// Reads palette-indexed frame arrays from JSON, renders to spriteLayer

const TILE = 32;

// Sprite sheet cache
const sheetCache = {};

async function loadSpriteSheet(url) {
  if (sheetCache[url]) return sheetCache[url];
  const res = await fetch(url);
  const data = await res.json();
  sheetCache[url] = data;
  return data;
}

// Draw a palette-indexed 32x32 frame onto a canvas context at (x, y)
function renderSprite(ctx, frameData, x, y) {
  const palette = window.JScreen.PALETTE;
  for (let i = 0; i < 1024; i++) {
    const idx = frameData[i];
    if (idx === 0) continue; // transparent
    const px = x + (i % 32);
    const py = y + Math.floor(i / 32);
    ctx.fillStyle = palette[idx] || palette[1];
    ctx.fillRect(px, py, 1, 1);
  }
}

// ── Animation Player ────────────────────────────────────────────────

class AnimationPlayer {
  constructor(sheet) {
    this.sheet = sheet;        // avatar.json data
    this.state = 'idle';       // current animation state name
    this.anim = sheet.animations['idle'];
    this.frameIndex = 0;
    this.elapsed = 0;
    this.event = null;         // one-shot event playing
    this.eventIndex = 0;
    this.eventElapsed = 0;
    this.prevState = 'idle';   // state to return to after event
  }

  setState(name) {
    if (!this.sheet.animations[name]) return;
    this.state = name;
    this.anim = this.sheet.animations[name];
    this.frameIndex = 0;
    this.elapsed = 0;
    this.event = null; // cancel any running event
  }

  triggerEvent(name) {
    const ev = this.sheet.events[name];
    if (!ev) return;
    this.prevState = this.state;
    this.event = ev;
    this.eventIndex = 0;
    this.eventElapsed = 0;
  }

  // Returns the current frame name to draw
  tick(dt) {
    // One-shot event takes priority
    if (this.event) {
      this.eventElapsed += dt;
      if (this.eventElapsed >= this.event.frameDuration) {
        this.eventElapsed -= this.event.frameDuration;
        this.eventIndex++;
        if (this.eventIndex >= this.event.frames.length) {
          // Event finished — restore previous state
          this.event = null;
          this.setState(this.prevState);
        }
      }
      if (this.event) {
        return this.event.frames[this.eventIndex];
      }
    }

    // Normal animation loop
    this.elapsed += dt;
    if (this.elapsed >= this.anim.frameDuration) {
      this.elapsed -= this.anim.frameDuration;
      this.frameIndex++;
      if (this.frameIndex >= this.anim.frames.length) {
        this.frameIndex = this.anim.loop ? 0 : this.anim.frames.length - 1;
      }
    }
    return this.anim.frames[this.frameIndex];
  }
}

// ── Blink Controller ────────────────────────────────────────────────

class BlinkController {
  constructor() {
    this.blinking = false;
    this.nextBlink = this._schedule();
    this.blinkEnd = 0;
  }

  _schedule() {
    return performance.now() + 2000 + Math.random() * 3000;
  }

  update(now) {
    if (this.blinking) {
      if (now >= this.blinkEnd) {
        this.blinking = false;
        this.nextBlink = this._schedule();
      }
    } else if (now >= this.nextBlink) {
      this.blinking = true;
      this.blinkEnd = now + 120;
    }
    return this.blinking;
  }
}

// ── Module State ────────────────────────────────────────────────────

let avatarSheet = null;
let itemsSheet = null;
let player = null;
let blinker = new BlinkController();

// Avatar tile position (converted to pixels for rendering)
let avatarTX = 4;
let avatarTY = 3;

// Items on screen: [{sprite: 'star', tx, ty}]
let items = [];

let lastTimestamp = 0;

// ── Init ────────────────────────────────────────────────────────────

async function initSprites() {
  avatarSheet = await loadSpriteSheet('/sprites/avatar.json');
  itemsSheet = await loadSpriteSheet('/sprites/items.json');
  player = new AnimationPlayer(avatarSheet);

  const JS = window.JScreen;

  // Expose avatar pixel position
  JS.avatarX = avatarTX * TILE;
  JS.avatarY = avatarTY * TILE;

  // ── Register command handlers ───────────────────────────────────

  // STATE name — set looping animation
  JS.registerHandler('STATE', (cmd) => {
    if (player) player.setState(cmd.state);
  });

  // EVENT name — play one-shot event animation
  JS.registerHandler('EVENT', (cmd) => {
    if (player) player.triggerEvent(cmd.event);
  });

  // POS tx ty — move avatar to tile position
  JS.registerHandler('POS', (cmd) => {
    avatarTX = cmd.tx;
    avatarTY = cmd.ty;
    JS.avatarX = avatarTX * TILE;
    JS.avatarY = avatarTY * TILE;
  });

  // ITEM sprite tx ty — place an item
  JS.registerHandler('ITEM', (cmd) => {
    items.push({ sprite: cmd.sprite, tx: cmd.tx, ty: cmd.ty });
  });

  // CLRITM — clear all items
  JS.registerHandler('CLRITM', () => {
    items = [];
  });

  // ── Animation tick (called every frame by renderer) ─────────────
  // Chain onto existing tickAnimations (preserve tiles/effects hooks)

  const prevTick = JS.tickAnimations;
  JS.tickAnimations = function tickAnimations(timestamp) {
    if (prevTick) prevTick(timestamp);

    if (!player || !avatarSheet) return;

    const dt = lastTimestamp ? (timestamp - lastTimestamp) : 16;
    lastTimestamp = timestamp;

    const ctx = JS.spriteLayer.ctx;

    // Get current frame name from animation player
    let frameName = player.tick(dt);

    // Blink overlay: replace frame with blink if blinking and frame has eyes
    const isBlinking = blinker.update(timestamp);
    if (isBlinking && !player.event) {
      // Only overlay blink during normal idle-like states
      const blinkStates = ['idle', 'work', 'think', 'confused', 'sad'];
      if (blinkStates.includes(player.state)) {
        frameName = 'blink';
      }
    }

    // Draw avatar
    const frameData = avatarSheet.frames[frameName];
    if (frameData) {
      renderSprite(ctx, frameData, avatarTX * TILE, avatarTY * TILE);
    }

    // Draw items
    for (const item of items) {
      const itemData = itemsSheet[item.sprite];
      if (itemData) {
        renderSprite(ctx, itemData, item.tx * TILE, item.ty * TILE);
      }
    }
  };
}

// Auto-init when JScreen is ready
if (window.JScreen) {
  initSprites();
} else {
  window.addEventListener('load', initSprites);
}
