# JulianScreen 640x480 Resolution Upgrade

Upgrade the JulianScreen pixel display from 128x96 to 640x480, with 32x32 tiles on a 20x15 grid. All sprite art redrawn at native 32x32 resolution. Dual-size bitmap font system (large 10x14, small 7x9). Menu system redesigned for the extra space.

## Motivation

The 128x96 display is too crowded for the menu system — file labels truncate at 7 characters, only 9 items visible per page, and the tab bar competes with content for vertical space. 640x480 (standard VGA, same 4:3 aspect ratio) provides 25x the pixel area while evoking classic CRT displays.

## Resolution & Grid

| Property | Current | New |
|----------|---------|-----|
| Canvas | 128x96 | 640x480 |
| Tile size | 16x16 | 32x32 |
| Grid | 8x6 | 20x15 |
| Aspect ratio | 4:3 | 4:3 (unchanged) |

## Token Impact

None. The command protocol is symbolic (`S happy`, `T Hello!`, `BG home`) — resolution-independent. Sprite data is loaded by the browser from JSON files, never sent through the Claude API. Cost per display change remains 2-5 tokens.

## Constants Change Map

### renderer.js (source of truth)

```
SCREEN_W:  128 → 640
SCREEN_H:   96 → 480
TILE_SIZE:  16 →  32
COLS:        8 →  20
ROWS:        6 →  15
```

### Files with duplicated/local constants

| File | Constant | Current | New |
|------|----------|---------|-----|
| tiles.js | T_ROWS, T_COLS, T_TILE | 6, 8, 16 | 15, 20, 32 |
| sprites.js | TILE | 16 | 32 |
| index.html | canvas width/height, resize divisors | 128, 96 | 640, 480 |
| protocol.js | coordinate clamp ranges | 0-7, 0-5 | 0-19, 0-14 |

### Sprite render loop changes

`sprites.js` `renderSprite()`: iterate `i < 1024`, use `i % 32` and `Math.floor(i / 32)` instead of `i < 256`, `i % 16`, `Math.floor(i / 16)`.

## Dual Font System

| Font | Glyph size | Cell size | Array length | Use cases |
|------|-----------|-----------|-------------|-----------|
| Large | 10x14 | 12x16 | 140 per glyph | Speech bubbles, tab labels, dialog |
| Small | 7x9 | 8x11 | 63 per glyph | Item labels, breadcrumbs, status |

82 glyphs per font (A-Z, a-z, 0-9, punctuation, space).

### font.json format

```json
{
  "large": { "A": [140 values], ... },
  "small": { "A": [63 values], ... }
}
```

### text.js API change

`JScreen.drawText(ctx, text, x, y, colorIndex, size)` — `size` is `"large"` (default) or `"small"`.

Speech bubble uses large font. `MAX_BUBBLE_W` increases from 100 to 300.

## Sprite Redraw

All sprites redrawn at native 32x32 (1024-element palette-indexed arrays). Same JSON structure, same palette.

| File | Sprites | Count |
|------|---------|-------|
| avatar.json | idle, blink, talk_0/1, think_0/1/2, happy_0/1, sad_0, excited_0/1, confused, sleep_0/1, work_0/1, alert, wave_0/1, nod_0/1, shake_0/1, celebrate_0/1, flinch, shrug_0 | 28 frames |
| tiles.json | empty, floor, wall, brick, grass, sky, water_0/1, grid, dots, stars, circuit | 12 tiles |
| items.json | star, heart, lightning, music, gear, folder, file | 7 sprites |

**Total: 47 sprites to redraw at 32x32.**

## Menu Layout Redesign

```
640px wide x 480px tall

y=0-23:    TAB BAR (24px, large font)
y=24:      SEPARATOR (1px, pink)
y=25-39:   BREADCRUMB (15px, small font)
y=40-479:  CONTENT AREA (440px)
           4-column grid, 5 visible rows
           32x32 icons + small font labels
           20 items per page
           Scrollbar: x=632-639, 8px wide
```

| Property | Current | New |
|----------|---------|-----|
| Grid columns | 3 | 4 |
| Visible rows | 3 | 5 |
| Items per page | 9 | 20 |
| Label truncation | 7 chars | 14 chars |
| Row height | 25px | 80px |
| Scrollbar width | 3px | 8px |

Column width: 158px (632px content width / 4 columns).

## Effects Scaling

| Effect | Current | New |
|--------|---------|-----|
| sparkle | 30 particles | 150 |
| hearts | 5 at 25px spacing | 5 at 125px spacing |
| rain | 40 streaks | 200 |
| snow | 25 flakes | 125 |
| button height | 11px | 22px |
| progress bar height | 4px | 8px |

## Implementation Steps

1. **Constants & canvas** — Update renderer.js, index.html, tiles.js, sprites.js, protocol.js
2. **Fonts** — Create dual-size font.json, update text.js with size parameter
3. **Tile sprites** — Redraw 12 tiles at 32x32, update tiles.js render loop
4. **Avatar sprites** — Redraw 28 frames at 32x32, update sprites.js render loop
5. **Item & icon sprites** — Redraw 7 sprites at 32x32
6. **Menu layout** — Update menu.js constants for 640x480 grid
7. **Effects & polish** — Scale particle counts, button height, progress bar

### Dependency graph

```
Step 1 (constants)
  ├→ Step 2 (fonts)       ─┐
  ├→ Step 3 (tiles)        │→ Step 6 (menu) → Step 7 (polish)
  ├→ Step 4 (avatar)       │
  └→ Step 5 (items/icons) ─┘
```

Steps 2-5 are independent and can run in parallel.

## Files Changed

| File | Change |
|------|--------|
| julianscreen/client/index.html | Canvas dimensions, resize function |
| julianscreen/client/renderer.js | Core constants, clearRect calls |
| julianscreen/client/tiles.js | Local constants, render loop |
| julianscreen/client/sprites.js | TILE constant, renderSprite loop |
| julianscreen/client/text.js | Dual font support, MAX_BUBBLE_W, drawText API |
| julianscreen/client/input.js | Button height, progress bar height |
| julianscreen/client/menu.js | All layout constants, grid dimensions |
| julianscreen/client/effects.js | Particle counts, spacing values |
| julianscreen/server/protocol.js | Coordinate clamp ranges |
| julianscreen/sprites/font.json | Complete rewrite — dual size object |
| julianscreen/sprites/avatar.json | All 28 frames redrawn at 32x32 |
| julianscreen/sprites/tiles.json | All 12 tiles redrawn at 32x32 |
| julianscreen/sprites/items.json | All 7 sprites redrawn at 32x32 |
| docs/julianscreen.md | Updated dimensions, coordinate ranges, file sizes |
