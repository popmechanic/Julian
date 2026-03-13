// ─── SIGILS MODULE ──────────────────────────────────────────
// Three animation systems consolidated from mockup.html IIFEs:
//   1. Morph  — top banner sigil cycling at 30fps
//   2. Warp   — bottom sigil displacement crossfade
//   3. Frame  — clockwise displacement wave around viewport edges
//
// Fetches sigil path data from /data/sigils.json at init().

const NS = 'http://www.w3.org/2000/svg';

interface Sigil {
  vb: string;
  d: string;
}

// ── Module-level state ─────────────────────────────────────────
let allSigils: Sigil[] = [];

// ── Helpers ────────────────────────────────────────────────────

function makeSVG(sigil: Sigil): string {
  return `<svg viewBox="${sigil.vb}" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%"><path d="${sigil.d}"/></svg>`;
}

function pickRandom(exclude: number): number {
  let idx: number;
  do { idx = Math.floor(Math.random() * allSigils.length); } while (idx === exclude);
  return idx;
}

// ═══════════════════════════════════════════════════════════════
//  MORPH — top banner cycling through all sigils
// ═══════════════════════════════════════════════════════════════

const MORPH_N = 180;              // sample points per sigil
const MORPH_DUR = 1500;           // ms per morph transition
const HOLD_DUR = 600;             // ms hold between morphs
const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;

let morphRafId: number | null = null;
let morphPrefetchTimeout: ReturnType<typeof setTimeout> | null = null;

// Morph internal state
let morphPath: SVGPathElement | null = null;
let morphFromIdx = 0;
let morphToIdx = 1;
let morphPtsFrom: number[][] | null = null;
let morphPtsTo: number[][] | null = null;
let morphNextPts: number[][] | null = null;
let morphPhase: 'morph' | 'hold' = 'morph';
let morphPhaseStart: number | null = null;
let morphLastFrameTs = 0;

function sampleSigil(sigilData: Sigil): number[][] {
  const parts = sigilData.vb.split(' ').map(Number);
  const ow = parts[2], oh = parts[3];
  const CW = 500, CH = 150;
  const sc = Math.min(CW / ow, CH / oh) * 0.88;
  const dx = (CW - ow * sc) / 2;
  const dy = (CH - oh * sc) / 2;

  const tmp = document.createElementNS(NS, 'svg');
  tmp.setAttribute('viewBox', sigilData.vb);
  tmp.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;left:-9999px;top:-9999px;width:1px;height:1px';
  const tp = document.createElementNS(NS, 'path');
  tp.setAttribute('d', sigilData.d);
  tmp.appendChild(tp);
  document.body.appendChild(tmp);

  const len = tp.getTotalLength();
  const pts: number[][] = [];
  for (let i = 0; i <= MORPH_N; i++) {
    const p = tp.getPointAtLength(i / MORPH_N * len);
    pts.push([p.x * sc + dx, p.y * sc + dy]);
  }
  document.body.removeChild(tmp);
  return pts;
}

// Hard deceleration: covers ~95% of distance in first 60% of time
function morphEase(t: number): number {
  return 1 - Math.pow(1 - t, 4.5);
}

function morphFrame(ts: number): void {
  morphRafId = requestAnimationFrame(morphFrame);

  // Throttle to TARGET_FPS
  if (ts - morphLastFrameTs < FRAME_MS) return;
  morphLastFrameTs = ts;
  if (!morphPhaseStart) morphPhaseStart = ts;

  try {
    if (morphPhase === 'morph') {
      const t = Math.min((ts - morphPhaseStart) / MORPH_DUR, 1);
      const et = morphEase(t);
      morphPath!.setAttribute('d',
        'M ' + morphPtsFrom!.map(([ax, ay], i) => [
          (ax + (morphPtsTo![i][0] - ax) * et).toFixed(1),
          (ay + (morphPtsTo![i][1] - ay) * et).toFixed(1)
        ].join(',')).join(' L ')
      );
      if (t >= 1) {
        morphPhase = 'hold';
        morphPhaseStart = ts;
        const nxt = (morphToIdx + 1) % allSigils.length;
        morphPrefetchTimeout = setTimeout(() => {
          morphNextPts = sampleSigil(allSigils[nxt]);
        }, 0);
      }
    } else { // hold
      if (ts - morphPhaseStart >= HOLD_DUR) {
        morphFromIdx = morphToIdx;
        morphToIdx = (morphToIdx + 1) % allSigils.length;
        morphPtsFrom = morphPtsTo;
        morphPtsTo = morphNextPts || sampleSigil(allSigils[morphToIdx]);
        morphNextPts = null;
        morphPhase = 'morph';
        morphPhaseStart = ts;
      }
    }
  } catch (e) {
    // Skip bad frame, loop continues
    console.warn('Morph frame skipped:', e);
    morphPhaseStart = ts;
  }
}

function initMorphDOM(): void {
  const container = document.getElementById('sigil-top');
  if (!container) return;

  const svg = document.createElementNS(NS, 'svg');
  svg.id = 'sigil-morph-svg';
  svg.setAttribute('viewBox', '0 0 500 150');
  svg.setAttribute('width', '440');
  svg.setAttribute('height', '132');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--c5)');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.style.display = 'none';
  svg.appendChild(path);
  container.appendChild(svg);
  morphPath = path;
}

function startMorph(): void {
  if (morphRafId !== null) return;
  const svg = document.getElementById('sigil-morph-svg');
  if (svg) svg.style.display = 'block';
  morphFromIdx = 0;
  morphToIdx = 1;
  morphPtsFrom = sampleSigil(allSigils[morphFromIdx]);
  morphPtsTo = sampleSigil(allSigils[morphToIdx]);
  morphNextPts = null;
  morphPhase = 'morph';
  morphPhaseStart = null;
  morphLastFrameTs = 0;
  morphRafId = requestAnimationFrame(morphFrame);
}

function stopMorph(): void {
  if (morphRafId !== null) {
    cancelAnimationFrame(morphRafId);
    morphRafId = null;
  }
  if (morphPrefetchTimeout !== null) {
    clearTimeout(morphPrefetchTimeout);
    morphPrefetchTimeout = null;
  }
  const svg = document.getElementById('sigil-morph-svg');
  if (svg) svg.style.display = 'none';
}




// ═══════════════════════════════════════════════════════════════
//  FRAME — clockwise displacement wave around viewport edges
// ═══════════════════════════════════════════════════════════════

const FRAME_CELL = 50;
const FRAME_POOL = 12;
const FRAME_WAVE_W = 10;
const FRAME_SCALE = 42;
let framePeriod = 20000;           // mutable for loadingMode
const FRAME_GLOW = 'drop-shadow(0 0 3px var(--c5)) drop-shadow(0 0 8px var(--c1))';

// Filter pool
const frameWdEls: Element[] = [];
let framePoolSvg: SVGSVGElement | null = null;

// State
let frameEl: HTMLElement | null = null;
let frameCells: { el: HTMLDivElement; sigilIdx: number; swapped: boolean }[] = [];
let frameN = 0;
const frameAvail: number[] = [];
const frameInUse = new Map<number, number>();

let frameRafId: number | null = null;
let frameStartTs: number | null = null;
let frameResizeTimer: ReturnType<typeof setTimeout> | null = null;
let frameResizeListener: (() => void) | null = null;

// Default opacity for frame cells
let frameCellOpacity = '';  // empty = CSS default

function initFrameDOM(): void {
  // Build filter pool SVG
  framePoolSvg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  framePoolSvg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  const defs = document.createElementNS(NS, 'defs');

  for (let n = 0; n < FRAME_POOL; n++) {
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', `wf-${n}`);
    f.setAttribute('x', '-60%');
    f.setAttribute('y', '-150%');
    f.setAttribute('width', '220%');
    f.setAttribute('height', '400%');

    const turb = document.createElementNS(NS, 'feTurbulence');
    turb.setAttribute('type', 'fractalNoise');
    turb.setAttribute('baseFrequency', '0.011 0.008');
    turb.setAttribute('numOctaves', '4');
    turb.setAttribute('seed', '17');
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
    frameWdEls.push(disp);
  }

  framePoolSvg.appendChild(defs);
  document.body.insertBefore(framePoolSvg, document.body.firstChild);

  frameEl = document.getElementById('sigil-frame');
}

function buildLayout(): void {
  if (!frameEl) return;

  frameEl.innerHTML = '';
  frameCells = [];
  frameAvail.length = 0;
  for (let i = 0; i < FRAME_POOL; i++) frameAvail.push(i);
  // Reset scale on any filters that were active mid-wave before rebuild
  frameInUse.forEach(fIdx => frameWdEls[fIdx].setAttribute('scale', '0'));
  frameInUse.clear();

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  function slots(len: number): { n: number; gap: number } {
    const n = Math.floor(len / FRAME_CELL);
    const gap = (len - n * FRAME_CELL) / (n + 1);
    return { n, gap };
  }

  const h = slots(vw);
  const v = slots(vh - 2 * FRAME_CELL);

  frameN = 2 * h.n + 2 * v.n;
  const step = Math.max(1, Math.floor(200 / frameN));

  let seq = 0;

  function addCell(styles: Record<string, string>, sigilIdx: number): void {
    const div = document.createElement('div');
    div.className = 'sf-cell';
    Object.assign(div.style, styles);
    if (frameCellOpacity) div.style.opacity = frameCellOpacity;
    div.innerHTML = makeSVG(allSigils[sigilIdx]);
    frameEl!.appendChild(div);
    frameCells.push({ el: div, sigilIdx, swapped: true });
    seq++;
  }

  // TOP — left to right (owns top corners)
  for (let i = 0; i < h.n; i++) {
    const cx = h.gap + i * (FRAME_CELL + h.gap) + FRAME_CELL / 2;
    addCell({ top: '0', left: cx + 'px', transform: 'translateX(-50%)' },
            (seq * step) % 200);
  }

  // RIGHT — top to bottom (excludes corners)
  for (let i = 0; i < v.n; i++) {
    const cy = FRAME_CELL + v.gap + i * (FRAME_CELL + v.gap) + FRAME_CELL / 2;
    addCell({ top: cy + 'px', right: '0', transform: 'translateY(-50%) rotate(-90deg)' },
            (seq * step) % 200);
  }

  // BOTTOM — right to left (clockwise; owns bottom corners)
  for (let i = h.n - 1; i >= 0; i--) {
    const cx = h.gap + i * (FRAME_CELL + h.gap) + FRAME_CELL / 2;
    addCell({ bottom: '0', left: cx + 'px', transform: 'translateX(-50%)' },
            (seq * step) % 200);
  }

  // LEFT — bottom to top (excludes corners)
  for (let i = v.n - 1; i >= 0; i--) {
    const cy = FRAME_CELL + v.gap + i * (FRAME_CELL + v.gap) + FRAME_CELL / 2;
    addCell({ top: cy + 'px', left: '0', transform: 'translateY(-50%) rotate(90deg)' },
            (seq * step) % 200);
  }
}

function frameTick(ts: number): void {
  if (!frameStartTs) frameStartTs = ts;
  const elapsed = ts - frameStartTs;
  const cursor = (elapsed / framePeriod) * frameN;

  for (let i = 0; i < frameN; i++) {
    const cell = frameCells[i];
    // Float-safe modulo that handles negative intermediate values
    const dist = ((cursor - i) % frameN + frameN) % frameN;

    if (dist < FRAME_WAVE_W) {
      // Entering or in band
      if (!frameInUse.has(i) && frameAvail.length > 0) {
        const fIdx = frameAvail.pop()!;
        frameInUse.set(i, fIdx);
        cell.el.style.filter = `url(#wf-${fIdx}) ${FRAME_GLOW}`;
      }

      const fIdx = frameInUse.get(i);
      if (fIdx !== undefined) {
        const t = dist / FRAME_WAVE_W;
        const scale = FRAME_SCALE * Math.sin(t * Math.PI);
        frameWdEls[fIdx].setAttribute('scale', scale.toFixed(2));
      }

      // Swap at peak (dist crosses WAVE_W/2)
      if (dist >= FRAME_WAVE_W / 2 && !cell.swapped) {
        cell.sigilIdx = pickRandom(cell.sigilIdx);
        cell.el.innerHTML = makeSVG(allSigils[cell.sigilIdx]);
        cell.swapped = true;
      }

    } else {
      // Outside band
      if (frameInUse.has(i)) {
        const fIdx = frameInUse.get(i)!;
        frameWdEls[fIdx].setAttribute('scale', '0');
        frameInUse.delete(i);
        frameAvail.push(fIdx);
        cell.el.style.filter = FRAME_GLOW;
      }
      // Reset swap guard
      cell.swapped = false;
    }
  }

  frameRafId = requestAnimationFrame(frameTick);
}

function startFrame(): void {
  if (frameRafId !== null) return;
  buildLayout();

  // Resize handler
  frameResizeListener = () => {
    if (frameResizeTimer !== null) clearTimeout(frameResizeTimer);
    frameResizeTimer = setTimeout(buildLayout, 200);
  };
  window.addEventListener('resize', frameResizeListener);

  frameStartTs = null;
  frameRafId = requestAnimationFrame(frameTick);
}

function stopFrame(): void {
  if (frameRafId !== null) {
    cancelAnimationFrame(frameRafId);
    frameRafId = null;
  }
  if (frameResizeTimer !== null) {
    clearTimeout(frameResizeTimer);
    frameResizeTimer = null;
  }
  if (frameResizeListener) {
    window.removeEventListener('resize', frameResizeListener);
    frameResizeListener = null;
  }
  // Reset filter scales
  frameInUse.forEach(fIdx => frameWdEls[fIdx].setAttribute('scale', '0'));
  frameInUse.clear();
  frameAvail.length = 0;
  for (let i = 0; i < FRAME_POOL; i++) frameAvail.push(i);
}


// ═══════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════

export async function init(): Promise<void> {
  const resp = await fetch('/data/sigils.json');
  allSigils = await resp.json();

  initMorphDOM();
  initSpinnerWarpDOM();
  initFrameDOM();
}

export function start(): void {
  startFrame();
}

export function stop(): void {
  stopMorph();
  stopSpinnerWarp();
  stopFrame();
}

/** Start top-banner sigil morph — used as loading indicator during DIVINE. */
export function showMorph(): void {
  startMorph();
}

/** Stop top-banner sigil morph. */
export function hideMorph(): void {
  stopMorph();
}

/** Sigils prominent — used during DIVINE state. */
export function loadingMode(): void {
  // Intensify frame cells
  frameCellOpacity = '0.8';
  frameCells.forEach(c => { c.el.style.opacity = '0.8'; });

  // Speed up frame wave
  framePeriod = 12000;

  // Intensify top banner glow
  const morphSvg = document.getElementById('sigil-morph-svg');
  if (morphSvg) {
    morphSvg.style.filter = 'drop-shadow(0 0 6px var(--c5)) drop-shadow(0 0 14px var(--c1))';
  }
}

// ═══════════════════════════════════════════════════════════════
//  SPINNER WARP — small filled-sigil displacement crossfade
//  (loading indicator after name/question submission)
// ═══════════════════════════════════════════════════════════════

const SWARP_SCALE_MAX = 36;
const SWARP_FREQ = '0.009 0.007';
const SWARP_OUT_DUR = 1400;
const SWARP_IN_DUR = 2400;
const SWARP_FADE_HALF = 400;

let swarpWtA: Element | null = null;
let swarpWdA: Element | null = null;
let swarpWtB: Element | null = null;
let swarpWdB: Element | null = null;
let swarpEl: HTMLElement | null = null;
let swarpSeed = 17;
let swarpRafId: number | null = null;
let swarpActive = false;

function swarpESine(t: number): number {
  return 0.5 - 0.5 * Math.cos(t * Math.PI);
}

const SWARP_GLOW = 'drop-shadow(0 0 2px var(--c3))';

function swarpMakeLayer(): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = `grid-area:1/1;pointer-events:none;will-change:filter;filter:${SWARP_GLOW};`;
  return d;
}

function initSpinnerWarpDOM(): void {
  // Build filter SVG with createElementNS (innerHTML on SVG can fail to
  // parse children into the SVG namespace in some environments).
  const fSvg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  fSvg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  const defs = document.createElementNS(NS, 'defs');

  function makeFilter(id: string): { turb: Element; disp: Element } {
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('x', '-60%');
    f.setAttribute('y', '-150%');
    f.setAttribute('width', '220%');
    f.setAttribute('height', '400%');

    const turb = document.createElementNS(NS, 'feTurbulence');
    turb.setAttribute('type', 'fractalNoise');
    turb.setAttribute('baseFrequency', '0.011 0.008');
    turb.setAttribute('numOctaves', '4');
    turb.setAttribute('seed', '17');
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
    return { turb, disp };
  }

  const filterOut = makeFilter('swarp-out');
  const filterIn = makeFilter('swarp-in');

  fSvg.appendChild(defs);
  document.body.insertBefore(fSvg, document.body.firstChild);

  swarpWtA = filterOut.turb;
  swarpWdA = filterOut.disp;
  swarpWtB = filterIn.turb;
  swarpWdB = filterIn.disp;
}

// Ping-pong: two layers (A and B) with continuous back-and-forth displacement.
// One warps out while the other warps in, then reverses. No jerky swaps.
let swarpLayerA: HTMLDivElement | null = null;
let swarpLayerB: HTMLDivElement | null = null;
let swarpForward = true;  // true = A→B, false = B→A
const SWARP_HOLD = 1200;  // ms hold at each end before reversing

function swarpPingPong(ts: number): void {
  if (!swarpActive || !swarpEl) return;
  if (!swarpPhaseStart) swarpPhaseStart = ts;
  const ms = ts - swarpPhaseStart;
  const TOTAL = SWARP_OUT_DUR + SWARP_IN_DUR;

  if (ms < TOTAL) {
    // Animating
    const outLayer = swarpForward ? swarpLayerA! : swarpLayerB!;
    const inLayer = swarpForward ? swarpLayerB! : swarpLayerA!;
    const dispOut = swarpForward ? swarpWdA! : swarpWdB!;
    const dispIn = swarpForward ? swarpWdB! : swarpWdA!;

    // Outgoing: displacement ramps up
    const tOut = Math.min(ms / SWARP_OUT_DUR, 1);
    dispOut.setAttribute('scale', (swarpESine(tOut) * SWARP_SCALE_MAX).toFixed(2));

    // Incoming: displacement ramps down
    const tIn = Math.min(Math.max(ms - SWARP_OUT_DUR * 0.3, 0) / SWARP_IN_DUR, 1);
    dispIn.setAttribute('scale', (SWARP_SCALE_MAX * (1 - swarpESine(tIn))).toFixed(2));

    // Opacity crossfade
    const fadeT = Math.min(Math.max((ms - SWARP_FADE_HALF) / (TOTAL - SWARP_FADE_HALF * 2), 0), 1);
    outLayer.style.opacity = (1 - fadeT).toFixed(3);
    inLayer.style.opacity = fadeT.toFixed(3);

    swarpRafId = requestAnimationFrame(swarpPingPong);
  } else if (ms < TOTAL + SWARP_HOLD) {
    // Holding — ensure final state is clean
    const outLayer = swarpForward ? swarpLayerA! : swarpLayerB!;
    const inLayer = swarpForward ? swarpLayerB! : swarpLayerA!;
    outLayer.style.opacity = '0';
    inLayer.style.opacity = '1';
    swarpWdA!.setAttribute('scale', '0');
    swarpWdB!.setAttribute('scale', '0');
    swarpRafId = requestAnimationFrame(swarpPingPong);
  } else {
    // Reverse direction
    swarpForward = !swarpForward;
    swarpPhaseStart = ts;

    // New turbulence seed for variety
    swarpSeed = (swarpSeed + 7 + Math.floor(Math.random() * 17)) % 1021;
    swarpWtA!.setAttribute('seed', String(swarpSeed));
    swarpWtB!.setAttribute('seed', String(swarpSeed + 41));

    // Pre-set incoming layer to full displacement before it fades in
    const dispIn = swarpForward ? swarpWdB! : swarpWdA!;
    dispIn.setAttribute('scale', String(SWARP_SCALE_MAX));

    swarpRafId = requestAnimationFrame(swarpPingPong);
  }
}

let swarpPhaseStart: number | null = null;

/** Start the spinner warp animation on `#spinner-warp`. */
export function startSpinnerWarp(): void {
  swarpEl = document.getElementById('spinner-warp');
  if (!swarpEl || swarpActive) return;
  swarpActive = true;
  swarpForward = true;
  swarpPhaseStart = null;

  swarpEl.style.display = 'grid';
  const idxA = pickRandom(-1);
  const idxB = pickRandom(idxA);

  swarpLayerA = swarpMakeLayer();
  swarpLayerA.innerHTML = makeSVG(allSigils[idxA]);
  swarpLayerA.style.filter = `url(#swarp-out) ${SWARP_GLOW}`;
  swarpEl.appendChild(swarpLayerA);

  swarpLayerB = swarpMakeLayer();
  swarpLayerB.innerHTML = makeSVG(allSigils[idxB]);
  swarpLayerB.style.opacity = '0';
  swarpLayerB.style.filter = `url(#swarp-in) ${SWARP_GLOW}`;
  // Start B fully displaced so it warps in cleanly
  swarpWdB!.setAttribute('scale', String(SWARP_SCALE_MAX));
  swarpEl.appendChild(swarpLayerB);

  swarpRafId = requestAnimationFrame(swarpPingPong);
}

/** Stop the spinner warp animation. */
export function stopSpinnerWarp(): void {
  swarpActive = false;
  swarpPhaseStart = null;
  swarpLayerA = null;
  swarpLayerB = null;
  if (swarpRafId !== null) {
    cancelAnimationFrame(swarpRafId);
    swarpRafId = null;
  }
  if (swarpEl) {
    swarpEl.innerHTML = '';
    swarpEl = null;
  }
}

/** Restore default sigil styling. */
export function normalMode(): void {
  // Restore frame cell opacity
  frameCellOpacity = '';
  frameCells.forEach(c => { c.el.style.opacity = ''; });

  // Restore frame wave speed
  framePeriod = 20000;

  // Restore top banner
  const morphSvg = document.getElementById('sigil-morph-svg');
  if (morphSvg) {
    morphSvg.style.filter = '';
  }
}
