# Pallid Mask — Project Notes

Sou'wester Arts Week 2026 · Ilwaco, Washington
Two-room installation. See `docs/superpowers/plans/2026-03-12-pallid-mask-installation.md` for the implementation plan.
Soul document for the entity: `pallid-mask/soul.md`.

## Typography

**Font:** Orpheus (`assets/Orpheus.otf`) — an all-caps display font.
- Uppercase letters render as full-size glyphs
- Lowercase letters render as small caps
- Mixed case produces inconsistent sizing — avoid it

**Rule:** Always write display text in **all lowercase** in the HTML source. Orpheus will render it as uniform small caps throughout. Do not use `text-transform: uppercase` or Title Case — both produce mixed or incorrect rendering.

## Colors

Defined in `assets/colors.txt`. Dominant: `oklch(52% 0.12 317)` (dusty violet).

```css
--c1: oklch(52% 0.12 317);   /* dominant line color / structural frame */
--c2: oklch(32% 0.086 287);  /* deep shadow / far-field glow */
--c3: oklch(42% 0.097 297);  /* mid tone / fortune verses */
--c4: oklch(67% 0.092 307);  /* lighter / sigils / visitor name */
--c5: oklch(77% 0.076 332);  /* pale mauve — mask face strokes / entity speech */
--c6: oklch(87% 0.065 347);  /* near-white — bloom highlight / vertex nodes */
```

## Vectrex Aesthetic

The mask uses a triple-layer SVG `feGaussianBlur` filter (stdDeviation 1.7 / 5 / 10) for bloom. CSS `drop-shadow` adds per-element colored glow. `glow-line-bright` gets two drop-shadow passes for richness; `glow-line` and `glow-line-faint` use single pass.

SVG filter region must be generous: `x="-60%" y="-40%" width="220%" height="180%"` — too tight causes hard clip edges on the glow.

## The Mask Face

Built in `mockup.html`. SVG `viewBox="230 75 350 505"`, displayed at `height: 85vh`.

**Artistic references:**
- Commedia dell'arte — elongated oval, wearable mask shape with concave brow notch (V-curve at top)
- The expression is NOT comedy or tragedy — it is the face of something that has just finished processing you and not yet decided whether to speak
- The smile references the John the Baptist painting attributed to da Vinci — corners curl asymmetrically, the right higher than the left, center anchored

**Key element IDs** (animation targets):
```
#face-left / #face-right   — face outline curves (cheek bulge during smile)
#eye-left / #eye-right      — eye groups (blink via scaleY)
#mouth-upper / #mouth-lower — lip paths (smile via CSS d-property)
#cheek-left / #cheek-right / #cheek-bottom — cheek structure lines
.eye-crinkle                — outer eye corner lines (fade in during smile)
```

**Mouth geometry:**
- Upper: `M 363 452 C 375 444 390 443 400 447 C 410 443 425 444 439 449`
- Lower: `M 363 452 Q 400 463 439 449`
- Right corner always sits 3 units higher than left — that asymmetry is the expression

## Animations

**Blink:** CSS `scaleY(0.04)` on `.eye-group` from center (whole eye flattens to line). 5–14s between blinks. 12% chance of double-blink. Cartoonish snap, not anatomical.

**Knowing smile:** CSS `d` property morph, 9 seconds. Fires every 70–130s; first smile at 30–50s after load.
- Lower lip center fixed at (400, 463) — does not move
- Corners curl up ~20 SVG units; right corner higher
- Cheeks push diagonally outward-upward
- Face outline bulges slightly at malar level
- Cleanup via `setTimeout(SMILE_DUR + 100)` — do NOT rely on `animationend` (unreliable)

**Sigil morph (top banner):** rAF loop at 30fps cycles through all 200 sigils sequentially. Data inlined in mockup.html (258KB). Easing: `1 - Math.pow(1-t, 4.5)` — hard deceleration landing. 1500ms morph, 600ms hold.

## Performance Notes

- **Scanlines:** use `transform: translateY(4px)` not `background-position` — GPU-composited
- **`glow-pulse`:** animates CSS `filter` — CPU-bound but isolated via `will-change` and `translateZ(0)` on mask SVG
- **`filter` on `.screen`:** restored to `hue-rotate(15deg)` — creates compositing barrier but is visually essential; accept the cost
- **`will-change: transform`** on `.eye-group` and `.mask-wrap` for GPU layer hints
- **Do not** apply `filter: blur()` to `.screen` — destroys GPU compositing for entire page (learned the hard way)
- **Do not** use 4+ `drop-shadow` passes on elements inside an SVG filter group — redundant and expensive

## Sigil Frame

A fixed-position border of sigil cells frames all four viewport edges. A displacement wave ripples clockwise; each sigil swaps at peak distortion.

**Constants (tuning knobs — top of IIFE):**
```
CELL   = 110   // px cell height (1/4 of bottom banner); update CSS `110px` too if changed
POOL   = 12    // filter pool size; must exceed WAVE_W
WAVE_W = 10    // cells in active displacement band simultaneously
SCALE  = 42    // peak feDisplacementMap scale — form blurs, stays readable
PERIOD = 20000 // ms per clockwise lap
GLOW   = 'drop-shadow(0 0 3px var(--c5)) drop-shadow(0 0 8px var(--c1))'
```

**Filter pool:** 12 `<filter>` elements (`#wf-0` through `#wf-11`) in a separate hidden SVG (not the bottom sigil's SVG). Only the cells currently in the active wave band have a filter assigned. Cells entering the band pull from `avail[]`; cells exiting release back to it.

**Wave dist formula:** `dist = ((cursor - i) % N + N) % N` — float-safe modulo. `dist = 0` = wavefront just arrived. Peak at `dist = WAVE_W / 2`. Band exits at `dist >= WAVE_W`.

**Initial-state guard:** All cells start with `swapped: true`. Prevents a burst of simultaneous swaps when the wave first passes cells 0–9 at load. Resets to `false` when a cell exits the band.

**Layout:** Top/bottom strips own both corners. Left/right strips span `CELL` to `vh − CELL`. Spacing formula: `gap = (stripLength − n * CELL) / (n + 1)` (padding-inclusive).

## Sigils

200 SVG files in `assets/Cyber Sigils Vectors - Fox Rockett Studio/SVG/`.
All path data extracted into `data/sigils.json`, served at `/data/sigils.json` and fetched by `client/sigils.ts` at runtime.
Color: fill `var(--c5)` for banners and frame, `var(--c6)` for morph display.

## Source Texts

Both in `pallid-mask/data/`, tab-indexed (`index\ttext`):
- `king-in-yellow.txt` — 1,662 passages
- `king-james-bible.txt` — 31,102 verses

Stichomancy seed: sum of inter-keystroke timing intervals (ms).
```
king_yellow_index = seed % 1662
bible_index = Math.floor(seed / 1662) % 31102
```

## Architecture

**Server** (`server/`): Bun server with pre-fetched greeting, stichomancy engine, Claude fortune generation, ElevenLabs TTS, QR code generation, and self-contained fortune page output.

**Client** (`client/`): Modular TypeScript — `ceremony.ts` (state machine), `mask.ts` (blink/smile), `sigils.ts` (morph/frame/spinner), `display.ts` (text overlays), `input.ts` (keystroke capture with timing), `api.ts` (server endpoints).

**Ceremony flow:** `WELCOME → SUMMON → NAME → INPUT → DIVINE → FORTUNE → QR_DISPLAY → (reset)`.

**Reference:** `mockup.html` is the original monolithic prototype, kept for visual debugging without running the server.

## Fortune Data Safety

**Fortune HTML files in `fortunes/` are irreplaceable artifacts.** Each is a unique Claude-generated fortune tied to a real visitor. Never overwrite, regenerate, or batch-modify existing fortune files. Template or style changes must only affect newly generated fortunes. If existing fortunes need visual updates, copy them first and verify no content is lost before replacing. We lost fortune data during a batch regeneration (2026-03-13) when a regex truncated content at a nested `</div>` — do not repeat this.
