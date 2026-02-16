// JulianScreen — dual-size bitmap text rendering + speech bubbles
// Large font (10x14) for speech/headers, small font (7x9) for labels/menus

const FONT_LARGE = { glyphW: 10, glyphH: 14, charW: 12, charH: 16 };
const FONT_SMALL = { glyphW: 7,  glyphH: 9,  charW: 8,  charH: 11 };

let fontData = null; // { large: { A: [...], ... }, small: { A: [...], ... } }

// Load font data
fetch('/sprites/font.json')
  .then(r => r.json())
  .then(data => { fontData = data; })
  .catch(e => console.error('[text] Failed to load font:', e));

function getFontMetrics(size) {
  return size === 'small' ? FONT_SMALL : FONT_LARGE;
}

// Draw a single character at pixel position
function drawChar(ctx, ch, x, y, paletteIndex, size) {
  if (!fontData) return;
  const font = size === 'small' ? fontData.small : fontData.large;
  if (!font) return;
  const glyph = font[ch];
  if (!glyph) return;
  const metrics = getFontMetrics(size);
  const color = JScreen.PALETTE[paletteIndex] || JScreen.PALETTE[1];
  ctx.fillStyle = color;
  for (let row = 0; row < metrics.glyphH; row++) {
    for (let col = 0; col < metrics.glyphW; col++) {
      if (glyph[row * metrics.glyphW + col]) {
        ctx.fillRect(x + col, y + row, 1, 1);
      }
    }
  }
}

// Draw a string of text at pixel position
function drawText(ctx, text, x, y, paletteIndex, size) {
  const metrics = getFontMetrics(size);
  for (let i = 0; i < text.length; i++) {
    drawChar(ctx, text[i], x + i * metrics.charW, y, paletteIndex, size);
  }
}

// Word-wrap text to fit maxWidth in pixels
function wrapText(text, maxWidth, size) {
  const metrics = getFontMetrics(size);
  const maxChars = Math.floor(maxWidth / metrics.charW);
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

// Draw a speech bubble with text (always uses large font)
function drawBubble(ctx, text, targetX, targetY) {
  const PAD = 4;
  const POINTER_H = 6;
  const POINTER_W = 6;
  const MAX_BUBBLE_W = 300;
  const metrics = FONT_LARGE;

  const lines = wrapText(text, MAX_BUBBLE_W - PAD * 2, 'large');
  const textW = Math.max(...lines.map(l => l.length)) * metrics.charW;
  const textH = lines.length * metrics.charH - (metrics.charH - metrics.glyphH);

  const bubbleW = textW + PAD * 2;
  const bubbleH = textH + PAD * 2;

  // Position bubble above target, centered horizontally
  let bx = targetX - Math.floor(bubbleW / 2);
  let by = targetY - bubbleH - POINTER_H - 2;

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
  const px = targetX - Math.floor(POINTER_W / 2);
  const py = by + bubbleH;
  ctx.fillStyle = bgColor;
  for (let row = 0; row < POINTER_H; row++) {
    const halfW = Math.floor(POINTER_W / 2 - row * POINTER_W / (2 * POINTER_H));
    const cx = px + Math.floor(POINTER_W / 2);
    if (halfW > 0) {
      ctx.fillRect(cx - halfW, py + row, halfW * 2, 1);
    } else {
      ctx.fillRect(cx, py + row, 1, 1);
    }
  }
  // Pointer border edges
  ctx.fillStyle = borderColor;
  for (let row = 0; row < POINTER_H; row++) {
    const halfW = Math.floor(POINTER_W / 2 - row * POINTER_W / (2 * POINTER_H));
    const cx = px + Math.floor(POINTER_W / 2);
    ctx.fillRect(cx - halfW - 1, py + row, 1, 1);
    ctx.fillRect(cx + halfW, py + row, 1, 1);
  }

  // Draw text lines inside bubble
  for (let i = 0; i < lines.length; i++) {
    drawText(ctx, lines[i], bx + PAD, by + PAD + i * metrics.charH, 1, 'large');
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
    const ax = JScreen.avatarX != null ? JScreen.avatarX : 320;
    const ay = JScreen.avatarY != null ? JScreen.avatarY : 240;
    // Bubble targets top-center of avatar sprite
    const targetX = ax + 16;
    const targetY = ay;

    // Calculate bubble rect for later clearing
    const PAD = 4;
    const POINTER_H = 6;
    const MAX_BUBBLE_W = 300;
    const metrics = FONT_LARGE;
    const lines = wrapText(cmd.text, MAX_BUBBLE_W - PAD * 2, 'large');
    const textW = Math.max(...lines.map(l => l.length)) * metrics.charW;
    const textH = lines.length * metrics.charH - (metrics.charH - metrics.glyphH);
    const bubbleW = textW + PAD * 2;
    const bubbleH = textH + PAD * 2;
    let bx = targetX - Math.floor(bubbleW / 2);
    let by = targetY - bubbleH - POINTER_H - 2;
    if (bx < 0) bx = 0;
    if (bx + bubbleW > JScreen.SCREEN_W) bx = JScreen.SCREEN_W - bubbleW;
    if (by < 0) by = 0;
    bubbleRect = { x: bx - 1, y: by - 1, w: bubbleW + 2, h: bubbleH + POINTER_H + 8 };

    drawBubble(ctx, cmd.text, targetX, targetY);
  }

  // Re-render buttons after bubble change (they share UI layer)
  if (JScreen._renderButtons) JScreen._renderButtons();
}

JScreen.registerHandler('TEXT', handleText);
JScreen.drawText = drawText;
JScreen._fontMetrics = getFontMetrics;
