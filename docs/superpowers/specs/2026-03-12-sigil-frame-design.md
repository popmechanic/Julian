# Sigil Frame — Design Spec
*Pallid Mask installation · 2026-03-12*

## Overview

A fixed-position border of cycling sigils frames all four edges of the viewport. A displacement wave ripples clockwise around the frame; each sigil swaps to a new symbol at peak distortion. The frame sits above the page content but below the CRT scanlines layer.

---

## Layout

### DOM insertion point

The frame container is inserted as a **direct child of `<body>`**, before the existing hidden filter SVG. This is required because `.screen` has `filter: hue-rotate(15deg)`, which creates a stacking context that would flatten z-index values for any descendants — the frame must be a sibling of `.screen`, not a child.

### Container

```css
position: fixed; inset: 0; pointer-events: none; z-index: 999;
```

Below scanlines (`z-index: 1000`), above `.screen` content.

### Cell size

`CELL = 110px` — one quarter of the existing bottom sigil width (440px).

Cells have **fixed height = CELL**, **width = auto** (bounded by CELL max). The SVG inside each cell is `height: 100%; width: auto` — natural aspect ratio, consistent vertical height, x-dimension shrinks to fit.

### Four strips

- **Top:** full width, `y = 0`, owns both top corners
- **Bottom:** full width, `y = vh − CELL`, owns both bottom corners
- **Left:** `x = 0`, from `y = CELL` to `y = vh − CELL` (excludes corners), strip height = `vh − 2 * CELL`
- **Right:** `x = vw − CELL`, same height range as left

### Spacing formula

For all four strips, cells are evenly spaced with padding-inclusive gaps:

```
nCells = floor(stripLength / CELL)
gap    = (stripLength − nCells * CELL) / (nCells + 1)
```

First cell starts at `gap` from the strip origin; subsequent cells at `gap + CELL` intervals. This distributes whitespace uniformly including outer margins, fully covering the strip at any viewport size.

For top/bottom: `stripLength = vw`, cells positioned along x.
For left/right: `stripLength = vh − 2 * CELL`, cells positioned along y (offset by `CELL` from top/bottom).

### Clockwise index order

```
0 → nTop−1              top, left→right
nTop → nTop+nRight−1    right, top→bottom
nTop+nRight → …         bottom, right→left
… → N−1                 left, bottom→top
```

Total N cells determined at runtime from viewport size.

### Starting sigils

Cell `i` starts at sigil index `(i * floor(200 / N)) % 200` — distributed across the 200 available sigils so no two adjacent cells start on the same symbol.

---

## Filter Pool

### Pool structure

12 `<filter>` elements (`#wf-0` through `#wf-11`), added to the existing hidden filter `<svg>` already in `<body>`. Each filter:

```xml
<filter id="wf-N" x="-60%" y="-150%" width="220%" height="400%">
  <feTurbulence type="fractalNoise" baseFrequency="0.011 0.008"
                numOctaves="4" seed="17" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="0"
                     xChannelSelector="R" yChannelSelector="G"/>
</filter>
```

Same seed and frequency as the bottom sigil — one continuous noise character across the whole page.

### Pool management

Two structures: `available[]` (filter indices ready to assign) and `inUse` Map (cell index → filter index).

Each rAF frame:
1. Compute active band for this tick
2. For cells entering the band: pull a filter index from `available[]`, assign to cell, set `cell.style.filter = 'url(#wf-N) drop-shadow(...)'`
3. For cells leaving the band: release filter index back to `available[]`, reset `cell.style.filter` to drop-shadow only, reset `scale` to 0

Pool size (12) > max simultaneous active cells (WAVE_WIDTH = 10) — always has headroom.

If N < WAVE_WIDTH (very small viewport), all cells may be in the active band simultaneously. Pool size 12 handles this since N would also be small in that case. No special handling required; add a comment noting the degenerate case.

### `will-change` strategy

All frame cells receive `will-change: filter` at construction time. This pre-promotes them to GPU layers and avoids reactive promotion jank during rAF when cells enter the active band. The fixed overhead (one composited layer per cell, ~50 cells at 1080p) is acceptable given that the frame cells are small (110px) and their SVG content is static between swaps.

---

## Wave Logic

### Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `WAVE_PERIOD` | 20 000 ms | Time for one full clockwise lap |
| `WAVE_WIDTH` | 10 cells | Width of active displacement band |
| `SCALE_MAX` | 42 | Moderate warp — form blurs, readable |

### Per-frame computation

```js
const cursor = (elapsed / WAVE_PERIOD) * N;  // float, advances clockwise

for each cell i:
  const dist = (cursor - i + N) % N;
  // dist = 0: wavefront is exactly on cell i (leading edge, just arrived)
  // dist = WAVE_WIDTH/2: peak displacement
  // dist = WAVE_WIDTH: cell is leaving the band (trailing edge)
  // dist > WAVE_WIDTH: cell is inactive
  if (dist < WAVE_WIDTH) {
    const t = dist / WAVE_WIDTH;                          // 0→1 through band
    const scale = SCALE_MAX * Math.sin(t * Math.PI);     // bell: 0 → peak → 0
    wdEl.setAttribute('scale', scale.toFixed(2));
  }
```

### Initial-state guard

On the very first rAF frame, `cursor` is near 0, which means cells 0 through ~9 all have `dist < WAVE_WIDTH` simultaneously. Without intervention, all of them would trigger a sigil swap at peak. To prevent this burst:

**On init, mark all cells as already swapped** (`cell.swapped = true`). The wave will naturally reset each cell's `swapped` flag as it first exits the band (`dist >= WAVE_WIDTH`), then the normal swap logic applies on the second pass.

### Sigil swap

When `dist` crosses `WAVE_WIDTH / 2` for cell `i` (peak distortion), swap the cell's SVG content to a new random sigil (`pickRandom(currentSigil)`). The swap is instant — maximum displacement hides the cut.

Each cell tracks:
- `swapped: bool` — whether it has swapped this wave pass; reset when `dist >= WAVE_WIDTH`
- `currentSigil: int` — current sigil index, updated on swap

---

## Glow

Cells not in the active band:
```js
cell.style.filter = 'drop-shadow(0 0 3px var(--c5)) drop-shadow(0 0 8px var(--c1))';
```

Cells in the active band (filter assigned):
```js
cell.style.filter = `url(#wf-${filterIdx}) drop-shadow(0 0 3px var(--c5)) drop-shadow(0 0 8px var(--c1))`;
```

SVG `fill: var(--c5)` — matches the existing top sigil banner color.

---

## Integration

- Frame container inserted as direct `<body>` child, before the hidden filter SVG
- Frame init runs after `ALL_SIGILS` is defined (end of `<script>`, after bottom sigil IIFE)
- Frame rAF loop is independent from the top sigil morph loop
- On `window.resize` (debounced 200ms): remove old frame container, reinitialize cells at new viewport size. The `elapsed` timestamp continues uninterrupted, so the wave resumes from its fractional lap position. Cell indices rebuild fresh at the new N — no continuity of individual cell state across resize, which is acceptable.

---

## What Is Not In Scope

- Interaction between the frame wave and the bottom/top sigil animations
- Per-cell independent cycling (all cycling is wave-driven)
- Mobile/touch layout adjustments
