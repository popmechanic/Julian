# Sigil Frame Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fixed-position clockwise border of warp-cycling sigils around all four viewport edges, rippling as a displacement wave.

**Architecture:** Single IIFE appended to the main `<script>` block in `mockup.html`. Creates its own hidden filter SVG (12-slot pool), builds cell DOM elements as `position: absolute` children of a `position: fixed` frame container, and drives the wave via a single rAF loop. All changes are in one file.

**Tech Stack:** Vanilla JS, SVG filter primitives (feDisplacementMap), CSS custom properties, requestAnimationFrame

---

## Chunk 1: Structure, CSS, and filter pool

### Task 1: Add frame container to HTML

**Files:**
- Modify: `pallid-mask/mockup.html` — HTML body (line 440)

The frame container must be a **direct child of `<body>`** placed BEFORE `.screen`. This is required because `.screen` has `filter: hue-rotate(15deg)` which creates a stacking context — any element inside `.screen` cannot escape its z-index stack.

- [ ] **Step 1: Insert the frame div**

Find this line (line 441):
```html
<div class="screen">
```

Insert immediately before it (after `<body>` on line 440):
```html
<div id="sigil-frame"></div>
```

- [ ] **Step 2: Verify in browser**

Open `pallid-mask/mockup.html` in a browser. The page should look identical — the empty div adds nothing visible.

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/mockup.html
git commit -m "Add sigil-frame container to body"
```

---

### Task 2: Add CSS rules

**Files:**
- Modify: `pallid-mask/mockup.html` — `<style>` block (before line 438 `</style>`)

- [ ] **Step 1: Add CSS before `</style>`**

Find `</style>` (line 438) and insert immediately before it:

```css
/* ─── SIGIL FRAME ────────────────────────────────────────── */

#sigil-frame {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 999; /* below scanlines (1000), above .screen content */
}

.sf-cell {
  position: absolute;
  will-change: filter;
  filter: drop-shadow(0 0 3px var(--c5)) drop-shadow(0 0 8px var(--c1));
}

/* Override makeSVG's inline style="width:100%" for frame cells only.
   !important is necessary here because the SVG has an inline style. */
.sf-cell svg {
  height: 110px !important; /* CELL — fixed, never varies */
  width: auto !important;   /* natural aspect ratio, can be narrower */
  fill: var(--c5);
}
```

- [ ] **Step 2: Verify**

Reload the page. Still no visible change — rules apply to `.sf-cell` elements that don't exist yet.

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/mockup.html
git commit -m "Add sigil-frame CSS"
```

---

### Task 3: Inject pool filters

**Files:**
- Modify: `pallid-mask/mockup.html` — main `<script>` block (before line 907 `// prefers-reduced-motion`)

- [ ] **Step 1: Add the frame IIFE skeleton with pool filter creation**

Find the comment `// prefers-reduced-motion` (line 907) and insert immediately before it:

```js
// ─── SIGIL FRAME — fixed border with clockwise warp wave ─────
(function() {
  const NS    = 'http://www.w3.org/2000/svg';
  const CELL  = 110;           // px — 1/4 of the 440px bottom banner
  const POOL  = 12;            // filter pool size
  const WAVE_W = 10;           // cells in the active displacement band
  const SCALE  = 42;           // peak feDisplacementMap scale
  const PERIOD = 20000;        // ms for one full clockwise lap
  const GLOW   = 'drop-shadow(0 0 3px var(--c5)) drop-shadow(0 0 8px var(--c1))';

  // ── Pool filters ───────────────────────────────────────────
  // 12 filter pairs sharing the same noise character as the bottom sigil.
  // Only `scale` on each feDisplacementMap changes at runtime.
  const poolSvg = document.createElementNS(NS, 'svg');
  poolSvg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  const defs = document.createElementNS(NS, 'defs');
  const wdEls = []; // feDisplacementMap refs, indexed by filter slot

  for (let n = 0; n < POOL; n++) {
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', `wf-${n}`);
    f.setAttribute('x', '-60%');
    f.setAttribute('y', '-150%');
    f.setAttribute('width', '220%');
    f.setAttribute('height', '400%');

    const turb = document.createElementNS(NS, 'feTurbulence');
    turb.setAttribute('type', 'fractalNoise');
    turb.setAttribute('baseFrequency', '0.011 0.008'); // same as bottom sigil
    turb.setAttribute('numOctaves', '4');
    turb.setAttribute('seed', '17');                   // same noise field
    turb.setAttribute('result', 'n');

    const disp = document.createElementNS(NS, 'feDisplacementMap');
    disp.setAttribute('in', 'SourceGraphic');
    disp.setAttribute('in2', 'n');
    disp.setAttribute('scale', '0');
    disp.setAttribute('xChannelSelector', 'R');
    disp.setAttribute('yChannelSelector', 'G');

    f.appendChild(turb);
    f.appendChild(disp);
    defs.appendChild(f);
    wdEls.push(disp);
  }

  poolSvg.appendChild(defs);
  // Note: the spec suggests adding pool filters to the existing hidden filter SVG
  // from the bottom banner IIFE. We intentionally create a separate poolSvg here
  // to keep the frame IIFE self-contained and avoid cross-IIFE coupling.
  // Two hidden filter SVGs in <body> is fine — filter IDs do not conflict.
  document.body.insertBefore(poolSvg, document.body.firstChild);

  // ── State, layout, wave, and resize added in Tasks 4–6 ────
  // (Tasks 4–6 insert code here, before this closing bracket)
})();
// ─────────────────────────────────────────────────────────────
```

- [ ] **Step 2: Verify**

Reload. Open DevTools → Elements. Confirm `#wf-0` through `#wf-11` exist inside the hidden SVG at the top of `<body>`. Page still looks identical.

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/mockup.html
git commit -m "Sigil frame: inject pool filter SVG (12 wf-N filters)"
```

---

## Chunk 2: Layout builder and wave loop

### Task 4: Layout builder

**Files:**
- Modify: `pallid-mask/mockup.html` — inside the frame IIFE (replace `// remainder of IIFE in Task 4` comment)

- [ ] **Step 1: Add cell state and layout builder**

Find `// ── State, layout, wave, and resize added in Tasks 4–6 ────` and replace **only that comment line** (leave the `})();` closing bracket in place) with:

```js
  // ── State ──────────────────────────────────────────────────
  const frame   = document.getElementById('sigil-frame');
  let cells     = [];  // [{el, sigilIdx, swapped}]
  let N         = 0;
  const avail   = [];  // pool indices ready to assign
  const inUse   = new Map(); // cellIndex → filterIndex

  // ── Layout builder ─────────────────────────────────────────
  function buildLayout() {
    frame.innerHTML = '';
    cells = [];
    avail.length = 0;
    for (let i = 0; i < POOL; i++) avail.push(i);
    inUse.clear();

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // nCells and gap for a given strip length.
    // Spacing is padding-inclusive: gap also appears before first and after last cell.
    function slots(len) {
      const n   = Math.floor(len / CELL);
      const gap = (len - n * CELL) / (n + 1);
      return { n, gap };
    }

    const h = slots(vw);               // horizontal (top/bottom)
    const v = slots(vh - 2 * CELL);   // vertical (left/right, excluding corners)

    // Distribute 200 sigils across N cells — no two adjacent start the same
    N = 2 * h.n + 2 * v.n;
    const step = Math.max(1, Math.floor(200 / N));

    let seq = 0; // running cell index for sigil assignment

    function addCell(styles, sigilIdx) {
      const div = document.createElement('div');
      div.className = 'sf-cell';
      Object.assign(div.style, styles);
      div.innerHTML = makeSVG(ALL_SIGILS[sigilIdx]);
      frame.appendChild(div);
      // Start all cells swapped=true — initial-state guard prevents burst swap on first wave pass
      cells.push({ el: div, sigilIdx, swapped: true });
      seq++;
    }

    // TOP — left → right (owns top corners)
    for (let i = 0; i < h.n; i++) {
      const cx = h.gap + i * (CELL + h.gap) + CELL / 2;
      addCell({ top: '0', left: cx + 'px', transform: 'translateX(-50%)' },
              (seq * step) % 200);
    }

    // RIGHT — top → bottom (excludes corners)
    for (let i = 0; i < v.n; i++) {
      const cy = CELL + v.gap + i * (CELL + v.gap) + CELL / 2;
      addCell({ top: cy + 'px', right: '0', transform: 'translateY(-50%)' },
              (seq * step) % 200);
    }

    // BOTTOM — right → left (clockwise; owns bottom corners)
    for (let i = h.n - 1; i >= 0; i--) {
      const cx = h.gap + i * (CELL + h.gap) + CELL / 2;
      addCell({ bottom: '0', left: cx + 'px', transform: 'translateX(-50%)' },
              (seq * step) % 200);
    }

    // LEFT — bottom → top (excludes corners)
    for (let i = v.n - 1; i >= 0; i--) {
      const cy = CELL + v.gap + i * (CELL + v.gap) + CELL / 2;
      addCell({ top: cy + 'px', left: '0', transform: 'translateY(-50%)' },
              (seq * step) % 200);
    }
  }
```

- [ ] **Step 2: Add a temporary init call (before the wave loop)**

After the `buildLayout` function definition, insert `buildLayout();` immediately before the existing `})();` closing bracket. **Do not add another `})();`** — the closing bracket from Task 3 is already there.

```js
  buildLayout();
  // ← wave loop and resize handler go here in Tasks 5–6
})();   // ← already present from Task 3, do not duplicate
```

- [ ] **Step 3: Verify layout in browser**

Reload. You should see sigil cells tiled along all four edges — no animation yet, just static glowing symbols at fixed height around the viewport border. Verify:
- All four edges populated
- Cells are evenly spaced (gaps uniform including outer margins)
- All sigils are the same height (110px)
- Narrower sigils are narrower, not stretched
- Glow drop-shadow visible on each cell

- [ ] **Step 4: Commit**

```bash
git add pallid-mask/mockup.html
git commit -m "Sigil frame: layout builder — static cells on all four edges"
```

---

### Task 5: Wave rAF loop

**Files:**
- Modify: `pallid-mask/mockup.html` — inside the frame IIFE, between `buildLayout` definition and `buildLayout()` call

- [ ] **Step 1: Add the rAF loop**

Insert between the `buildLayout` function definition and the `buildLayout();` line added in Task 4:

```js
  // ── Wave loop ───────────────────────────────────────────────
  // One rAF loop drives the clockwise displacement wave.
  //
  // cursor: float cell-index advancing clockwise at PERIOD ms/lap
  // dist:   how far behind the wavefront cell i sits
  //           0   = wavefront just arrived at i (leading edge)
  //           W/2 = peak displacement (swap fires here)
  //           W   = wavefront has passed, cell exiting band
  //           >W  = cell inactive
  //
  // If N < WAVE_W (very small viewport), all cells stay in the band —
  // pool size 12 handles this since N would also be small. No special case needed.

  let startTs = null;

  function tick(ts) {
    if (!startTs) startTs = ts;
    const elapsed = ts - startTs;
    const cursor  = (elapsed / PERIOD) * N;

    for (let i = 0; i < N; i++) {
      const cell = cells[i];
      // Float-safe modulo that handles negative intermediate values
      const dist = ((cursor - i) % N + N) % N;

      if (dist < WAVE_W) {
        // ── Entering or in band ──────────────────────────────
        if (!inUse.has(i) && avail.length > 0) {
          // Assign a filter from the pool
          const fIdx = avail.pop();
          inUse.set(i, fIdx);
          cell.el.style.filter = `url(#wf-${fIdx}) ${GLOW}`;
        }

        const fIdx = inUse.get(i);
        if (fIdx !== undefined) {
          const t     = dist / WAVE_W;                        // 0→1 through band
          const scale = SCALE * Math.sin(t * Math.PI);        // bell: 0 → peak → 0
          wdEls[fIdx].setAttribute('scale', scale.toFixed(2));
        }

        // Swap at peak (dist crosses WAVE_W/2).
        // cell.swapped starts true (initial-state guard); reset only on band exit below.
        if (dist >= WAVE_W / 2 && !cell.swapped) {
          cell.sigilIdx = pickRandom(cell.sigilIdx);
          cell.el.innerHTML = makeSVG(ALL_SIGILS[cell.sigilIdx]);
          cell.swapped = true;
        }

      } else {
        // ── Outside band ────────────────────────────────────
        if (inUse.has(i)) {
          // Release filter back to pool
          const fIdx = inUse.get(i);
          wdEls[fIdx].setAttribute('scale', '0');
          inUse.delete(i);
          avail.push(fIdx);
          cell.el.style.filter = GLOW;
        }
        // Reset swap guard — next pass through the band will fire normally
        cell.swapped = false;
      }
    }

    requestAnimationFrame(tick);
  }
```

- [ ] **Step 2: Replace the temporary `buildLayout()` call with a full init**

Find the temporary `buildLayout();` line (inserted in Task 4 Step 2) and replace it with:

```js
  // ── Init ────────────────────────────────────────────────────
  buildLayout();
  requestAnimationFrame(tick);
```

The `})();` closing bracket from Task 3 remains after this block. Do not add another.

- [ ] **Step 3: Verify wave in browser**

Reload. Observe for at least 30 seconds:
- A displacement wave ripples clockwise around the frame
- Sigils warp and unrecognizably blur at peak displacement
- Sigil content changes at peak (the swap is hidden by the distortion)
- Wave is continuous — no stutter, no burst of simultaneous swaps on load
- Glow drop-shadow persists on all cells at all times

- [ ] **Step 4: Commit**

```bash
git add pallid-mask/mockup.html
git commit -m "Sigil frame: wave rAF loop with pool filter assignment"
```

---

### Task 6: Resize handler

**Files:**
- Modify: `pallid-mask/mockup.html` — inside the frame IIFE, after the `tick` function definition

- [ ] **Step 1: Add resize handler**

Find `requestAnimationFrame(tick);` (the init line) and insert immediately before it:

```js
  // ── Resize handler ──────────────────────────────────────────
  // Tears down and rebuilds cell layout. The wave timestamp (startTs)
  // continues uninterrupted — wave resumes from its fractional lap position.
  // Cell state does not survive resize; cells rebuild fresh at new N.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(buildLayout, 200);
  });
```

- [ ] **Step 2: Verify resize**

In the browser, resize the window (drag the corner). After 200ms, the frame should rebuild with new cell counts to match the new viewport size. Wave continues without restarting.

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/mockup.html
git commit -m "Sigil frame: debounced resize handler"
```

---

## Chunk 3: Tuning and completion

### Task 7: Visual tuning

The constants at the top of the IIFE are tuning knobs. After seeing the frame in motion against the full page:

| Constant | Default | Tune if… |
|----------|---------|----------|
| `SCALE` | `42` | Warp feels too strong (raise) or too subtle (lower) |
| `WAVE_W` | `10` | Wave band feels too wide/narrow |
| `PERIOD` | `20000` | Wave feels too fast (raise) or too slow (lower) |
| `CELL` | `110` | Cells feel too large (lower) or too small (raise) — also update CSS `110px` |

- [ ] **Step 1: Load the full page and watch for at least one full wave lap (~20s)**

Check:
- Does the glow intensity match the mask and top sigil? (Adjust `GLOW` drop-shadow values if not)
- Does the wave read as a single continuous ripple, not a series of independent pops?
- Do the cells feel like they belong to the same visual language as the rest of the page?

- [ ] **Step 2: Adjust constants if needed and verify again**

- [ ] **Step 3: Update CLAUDE.md with final tuned values**

In `pallid-mask/CLAUDE.md`, add a `## Sigil Frame` section documenting the IIFE constants and the filter pool pattern (following the existing `## Animations` and `## Performance Notes` sections).

- [ ] **Step 4: Commit**

```bash
git add pallid-mask/mockup.html pallid-mask/CLAUDE.md
git commit -m "Sigil frame: tuning and CLAUDE.md update"
```
