# Sigil Frame — Design Spec
*Pallid Mask installation · 2026-03-12*

## Overview

A fixed-position border of cycling sigils frames all four edges of the viewport. A displacement wave ripples clockwise around the frame; each sigil swaps to a new symbol at peak distortion. The frame sits above the page content but below the CRT scanlines layer.

---

## Layout

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
- **Left:** `x = 0`, from `CELL` to `vh − CELL` (excludes corners)
- **Right:** `x = vw − CELL`, from `CELL` to `vh − CELL` (excludes corners)

Top and bottom cells are **evenly spaced** across the strip width (gap distributed uniformly, strip always fully covered regardless of aspect ratio).

Left and right cells are **evenly spaced** across the strip height.

### Clockwise index order

```
0 → nTop−1          top, left→right
nTop → nTop+nRight−1    right, top→bottom
nTop+nRight → …         bottom, right→left
… → N−1             left, bottom→top
```

Total N cells determined at runtime from viewport size.

### Starting sigils

Cell `i` starts at sigil index `(i * floor(200 / N)) % 200` — evenly distributed across the 200 available sigils so no two adjacent cells start on the same symbol.

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

Two arrays: `available[]` (filter indices ready to assign) and `inUse` map (cell → filter index).

Each rAF frame:
1. Compute active band for this tick
2. For cells entering the band: pull a filter index from `available[]`, assign to cell, set `cell.style.filter = 'url(#wf-N) drop-shadow(...)'`
3. For cells leaving the band: release filter index back to `available[]`, reset `cell.style.filter` to drop-shadow only, reset `scale` to 0

Pool size (12) > max simultaneous active cells (WAVE_WIDTH = 10) — always has headroom.

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
  const dist = (cursor - i + N) % N;         // how far behind the wavefront
  if (dist < WAVE_WIDTH) {
    const t = dist / WAVE_WIDTH;              // 0 at leading edge, 1 at trailing
    const scale = SCALE_MAX * Math.sin(t * Math.PI);  // bell: 0 → peak → 0
    wdEl.setAttribute('scale', scale.toFixed(2));
  }
```

### Sigil swap

When `dist` crosses `WAVE_WIDTH / 2` for cell `i` (peak distortion), swap the cell's SVG content to a new random sigil (`pickRandom(current)`). The swap is instant — maximum displacement hides the cut.

Each cell tracks a `swapped` boolean per wave pass, reset when `dist >= WAVE_WIDTH`.

---

## Glow

Cells not in the active band:
```css
filter: drop-shadow(0 0 3px var(--c5)) drop-shadow(0 0 8px var(--c1));
```

Cells in the active band (filter assigned):
```js
cell.style.filter = `url(#wf-${filterIdx}) drop-shadow(0 0 3px var(--c5)) drop-shadow(0 0 8px var(--c1))`;
```

SVG `fill: var(--c5)` — matches the existing top sigil banner color.

---

## Integration

- Frame init runs after `ALL_SIGILS` is defined (end of `<script>`, after bottom sigil IIFE)
- Frame rAF loop is independent from the top sigil morph loop
- Frame recomputes cell layout on `window.resize` (debounced 200ms) — reinitializes cells, preserves wave cursor position

---

## What Is Not In Scope

- Interaction between the frame wave and the bottom/top sigil animations
- Per-cell independent cycling (all cycling is wave-driven)
- Mobile/touch layout adjustments
