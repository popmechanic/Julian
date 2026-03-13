// ─── MASK MODULE ─────────────────────────────────────────────
// Manages blink/smile animation loops and show/hide/recede
// transitions. SVG markup lives in index.html; this module
// queries the DOM and manipulates existing elements.

const SMILE_DUR = 9000;

// ── DOM references (cached at module level) ───────────────────
const maskWrap = document.querySelector('.mask-wrap') as Element;

const smileEls = () => [
  document.getElementById('mouth-upper'),
  document.getElementById('mouth-lower'),
  document.getElementById('cheek-left'),
  document.getElementById('cheek-right'),
  document.getElementById('cheek-bottom'),
  document.getElementById('face-left'),
  document.getElementById('face-right'),
  ...Array.from(document.querySelectorAll('.eye-crinkle')),
] as Element[];

// ── Timer handles ─────────────────────────────────────────────
let blinkTimeout: ReturnType<typeof setTimeout> | null = null;
let smileTimeout: ReturnType<typeof setTimeout> | null = null;
let animationsActive = false;

// ── Blink ─────────────────────────────────────────────────────
function doBlink(): void {
  document.querySelectorAll('.eye-group').forEach(el => {
    el.classList.add('blinking');
    el.addEventListener('animationend', () => el.classList.remove('blinking'), { once: true });
  });
}

function scheduleBlink(): void {
  if (!animationsActive) return;
  const delay = 5000 + Math.random() * 9000; // 5–14s between blinks
  blinkTimeout = setTimeout(() => {
    doBlink();
    // 12% chance of a quick double-blink
    if (Math.random() < 0.12) {
      setTimeout(doBlink, 340);
    }
    scheduleBlink();
  }, delay);
}

// ── Smile ─────────────────────────────────────────────────────
function doSmile(): void {
  const els = smileEls();
  els.forEach(el => el.classList.add('smiling'));
  // Remove after known duration — do not rely on animationend
  setTimeout(() => els.forEach(el => el.classList.remove('smiling')), SMILE_DUR + 100);
}

function scheduleSmile(): void {
  if (!animationsActive) return;
  const delay = 70000 + Math.random() * 60000; // 70–130s between smiles
  smileTimeout = setTimeout(() => {
    doSmile();
    scheduleSmile();
  }, delay);
}

// ── Public API ────────────────────────────────────────────────

function startAnimations(): void {
  if (animationsActive) return;
  animationsActive = true;

  // First blink after a brief natural pause
  blinkTimeout = setTimeout(scheduleBlink, 1500 + Math.random() * 2000);

  // First smile after 30–50s, then start the recurring cycle
  smileTimeout = setTimeout(() => {
    doSmile();
    scheduleSmile();
  }, 30000 + Math.random() * 20000);
}

function stopAnimations(): void {
  animationsActive = false;
  if (blinkTimeout !== null) { clearTimeout(blinkTimeout); blinkTimeout = null; }
  if (smileTimeout !== null) { clearTimeout(smileTimeout); smileTimeout = null; }
}

/** Fade mask in and start animations. */
export function show(): void {
  maskWrap.classList.remove('mask-hidden');
  startAnimations();
}

/** Fade mask out and stop animations. */
export function hide(): void {
  maskWrap.classList.add('mask-hidden');
  stopAnimations();
}

/** Scale mask up to fill screen — used during FORTUNE state. */
export function enlarge(): void {
  maskWrap.classList.add('mask-enlarged');
}

/** Reset mask to default size. */
export function resetSize(): void {
  maskWrap.classList.remove('mask-enlarged');
}
