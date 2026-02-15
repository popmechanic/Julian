// JulianScreen — bitmap text rendering + speech bubbles

const GLYPH_W = 5;
const GLYPH_H = 7;
const CHAR_W = 6; // 5px glyph + 1px spacing

let fontData = null;

// Load font data
fetch('/sprites/font.json')
  .then(r => r.json())
  .then(data => { fontData = data; })
  .catch(e => console.error('[text] Failed to load font:', e));

// Draw a single character at pixel position
function drawChar(ctx, ch, x, y, paletteIndex) {
  if (!fontData) return;
  const glyph = fontData[ch];
  if (!glyph) return;
  const color = JScreen.PALETTE[paletteIndex] || JScreen.PALETTE[1];
  ctx.fillStyle = color;
  for (let row = 0; row < GLYPH_H; row++) {
    for (let col = 0; col < GLYPH_W; col++) {
      if (glyph[row * GLYPH_W + col]) {
        ctx.fillRect(x + col, y + row, 1, 1);
      }
    }
  }
}

// Draw a string of text at pixel position
function drawText(ctx, text, x, y, paletteIndex) {
  for (let i = 0; i < text.length; i++) {
    drawChar(ctx, text[i], x + i * CHAR_W, y, paletteIndex);
  }
}

// Word-wrap text to fit maxWidth in pixels
function wrapText(text, maxWidth) {
  const maxChars = Math.floor(maxWidth / CHAR_W);
  if (maxChars < 1) return [text];
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= maxChars) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

// Draw a speech bubble with text
function drawBubble(ctx, text, targetX, targetY) {
  const PAD = 2;
  const POINTER_H = 3;
  const POINTER_W = 3;
  const MAX_BUBBLE_W = 100;

  const lines = wrapText(text, MAX_BUBBLE_W - PAD * 2);
  const textW = Math.max(...lines.map(l => l.length)) * CHAR_W;
  const textH = lines.length * (GLYPH_H + 1) - 1; // 1px line spacing

  const bubbleW = textW + PAD * 2;
  const bubbleH = textH + PAD * 2;

  // Position bubble above target, centered horizontally
  let bx = targetX - Math.floor(bubbleW / 2);
  let by = targetY - bubbleH - POINTER_H - 1;

  // Clamp to screen bounds
  const sw = JScreen.SCREEN_W;
  const sh = JScreen.SCREEN_H;
  if (bx < 0) bx = 0;
  if (bx + bubbleW > sw) bx = sw - bubbleW;
  if (by < 0) by = 0;
  if (by + bubbleH + POINTER_H > sh) by = sh - bubbleH - POINTER_H;

  const borderColor = '#FFD600'; // yellow
  const bgColor = '#0F0F0F';     // near-black

  // Background fill
  ctx.fillStyle = bgColor;
  ctx.fillRect(bx, by, bubbleW, bubbleH);

  // Border — top
  ctx.fillStyle = borderColor;
  ctx.fillRect(bx, by, bubbleW, 1);
  // Border — bottom
  ctx.fillRect(bx, by + bubbleH - 1, bubbleW, 1);
  // Border — left
  ctx.fillRect(bx, by, 1, bubbleH);
  // Border — right
  ctx.fillRect(bx + bubbleW - 1, by, 1, bubbleH);

  // Pointer triangle (pointing down toward avatar)
  const px = targetX - 1; // center pointer on target
  const py = by + bubbleH;
  ctx.fillStyle = bgColor;
  ctx.fillRect(px, py, POINTER_W, 1);
  ctx.fillRect(px + 1, py + 1, 1, 1);
  // Pointer border
  ctx.fillStyle = borderColor;
  ctx.fillRect(px - 1, py, 1, 1);
  ctx.fillRect(px + POINTER_W, py, 1, 1);
  ctx.fillRect(px, py + 1, 1, 1);
  ctx.fillRect(px + POINTER_W - 1, py + 1, 1, 1);
  ctx.fillRect(px + 1, py + 2, 1, 1);

  // Draw text lines inside bubble
  for (let i = 0; i < lines.length; i++) {
    drawText(ctx, lines[i], bx + PAD, by + PAD + i * (GLYPH_H + 1), 1);
  }
}

// Track bubble region for partial clear
let bubbleRect = null;

// TEXT command handler
function handleText(cmd) {
  const ctx = JScreen.uiLayer.ctx;

  // Clear only previous bubble region (not the whole UI layer — buttons live there too)
  if (bubbleRect) {
    ctx.clearRect(bubbleRect.x, bubbleRect.y, bubbleRect.w, bubbleRect.h);
    bubbleRect = null;
  }

  if (cmd.text && cmd.text.length > 0) {
    // Get avatar position (set by sprites.js), default to center
    const ax = JScreen.avatarX != null ? JScreen.avatarX : 64;
    const ay = JScreen.avatarY != null ? JScreen.avatarY : 48;
    // Bubble targets top-center of avatar sprite
    const targetX = ax + 8;
    const targetY = ay;

    // Calculate bubble rect for later clearing
    const PAD = 2;
    const POINTER_H = 3;
    const MAX_BUBBLE_W = 100;
    const lines = wrapText(cmd.text, MAX_BUBBLE_W - PAD * 2);
    const textW = Math.max(...lines.map(l => l.length)) * CHAR_W;
    const textH = lines.length * (GLYPH_H + 1) - 1;
    const bubbleW = textW + PAD * 2;
    const bubbleH = textH + PAD * 2;
    let bx = targetX - Math.floor(bubbleW / 2);
    let by = targetY - bubbleH - POINTER_H - 1;
    if (bx < 0) bx = 0;
    if (bx + bubbleW > JScreen.SCREEN_W) bx = JScreen.SCREEN_W - bubbleW;
    if (by < 0) by = 0;
    bubbleRect = { x: bx - 1, y: by - 1, w: bubbleW + 2, h: bubbleH + POINTER_H + 4 };

    drawBubble(ctx, cmd.text, targetX, targetY);
  }

  // Re-render buttons after bubble change (they share UI layer)
  if (JScreen._renderButtons) JScreen._renderButtons();
}

JScreen.registerHandler('TEXT', handleText);
JScreen.drawText = drawText;
