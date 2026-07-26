# Design System Port Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Svelte app render pixel-for-pixel identical to the legacy Julian UI (yellow shell, CRT panels, VT323 terminal type) for every feature the rewrite has.

**Architecture:** A token layer in `app/src/app.css` (CSS custom properties + global keyframes/classes ported verbatim from legacy `index.html`/`chat.jsx`), self-hosted fonts, then per-component restyles against those tokens. Two new capabilities port from legacy: the PixelFace canvas face and the SoundManager (placeholder mp3s, mechanism only).

**Tech Stack:** Svelte 5 (runes), TypeScript strict, Vite 6, vitest, CSS custom properties. No new runtime dependencies.

**Acceptance:** suite — committed per-package suites + svelte-check are the verification; final visual fidelity is confirmed by the manual side-by-side task carried to the runbook.

## Global Constraints

- Branch: all work lands on `ultra/integration-20260726-012506`; never merge to main, never deploy.
- TypeScript strict; Svelte 5 runes mode only (`$props`, `$state`, `$effect`, `$derived`).
- Do not touch `memory/`, `soul/`, the letter pipeline (`server/` letter rendering), or the JulianScreen server (`julianscreen/`).
- Do not modify `index.html`, `chat.jsx`, `vibes.jsx` (legacy app stays runnable on port 8000).
- App suite must stay green: `cd app && bun install && bunx vitest run` (16 existing tests) and `bunx svelte-check --tsconfig ./tsconfig.json` → 0 errors.
- Test servers use PORT=8099; port 8000 belongs to the running legacy app.
- Visual fidelity targets are the exact hex values and dimensions in each task — do not "improve" colors, spacing, or type sizes away from the legacy values.
- Legacy mobile breakpoint is `< 768px` viewport width.

---

### Task 1: Token layer, global CSS, self-hosted fonts

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `app/src/app.css`
- Create: `app/public/fonts/VT323-Regular.woff2`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties `--j-yellow`, `--j-yellow-key`, `--j-yellow-dim`, `--j-yellow-black`, `--j-crt-0`, `--j-crt-1`, `--j-crt-2`, `--j-bezel`, `--j-cyan`, `--j-red`, `--j-red-soft`, `--j-red-black`, `--j-green`, `--j-green-soft`, `--j-amber`, `--j-gray-333` … `--j-gray-999`, `--j-text`, `--j-text-dim`, `--font-terminal`, `--font-ui`, `--ease-out`, `--ease-out-quart`, `--duration-fast`, `--duration-standard`, `--duration-slow`; global class `.scanlines`; keyframes `message-enter`, `blink`, `thinking-pulse`, `pulse-warn`, `pulse-dot`, `fadeIn`; `@font-face` for `'VT323'` and `'Inter'`. All sibling restyle tasks build against these names.

**Parallelization rationale:** contract-first — fixing the token names up front lets every component restyle task run in parallel against a stable vocabulary instead of serializing behind one giant stylesheet task. (A good engineer extracts the design tokens first regardless of parallelism.)

- [ ] **Step 1: Download the two fonts as woff2**

```bash
cd app && mkdir -p public/fonts
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
VT_URL=$(curl -sL -A "$UA" "https://fonts.googleapis.com/css2?family=VT323&display=swap" | grep -o "https://fonts.gstatic.com/[^)]*\.woff2" | head -1)
curl -sL -o public/fonts/VT323-Regular.woff2 "$VT_URL"
INTER_URL=$(curl -sL -A "$UA" "https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap" | grep -o "https://fonts.gstatic.com/[^)]*\.woff2" | head -1)
curl -sL -o public/fonts/InterVariable.woff2 "$INTER_URL"
file public/fonts/*.woff2
```

Expected: `file` reports both as `Web Open Font Format (Version 2)` data; each file > 10 KB. If the css2 scrape returns nothing (offline/CDN change), fall back to `https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip` (extract `web/InterVariable.woff2`) and any pinned VT323 woff2 from `google/fonts` repo `ofl/vt323/`.

- [ ] **Step 2: Replace `app/src/app.css` with the design system**

```css
/* app/src/app.css — Julian design system, ported pixel-for-pixel from the
   legacy UI (index.html + chat.jsx). Token names are the contract every
   component styles against. */

@font-face {
  font-family: 'VT323';
  src: url('/fonts/VT323-Regular.woff2') format('woff2');
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: 'Inter';
  src: url('/fonts/InterVariable.woff2') format('woff2');
  font-weight: 100 900;
  font-display: swap;
}

:root {
  color-scheme: dark;

  /* Yellow family — Julian's color */
  --j-yellow: #FFD600;
  --j-yellow-key: #C8A800;
  --j-yellow-dim: #AA8800;
  --j-yellow-black: #1A1A00;

  /* CRT blacks */
  --j-crt-0: #0A0A0A;
  --j-crt-1: #0C0C0C;
  --j-crt-2: #0F0F0F;
  --j-bezel: #2A2A2A;

  /* Accents & status */
  --j-cyan: #00AFD1;
  --j-red: #FF4444;
  --j-red-soft: #FF6B6B;
  --j-red-black: #1A0000;
  --j-green: #22C55E;
  --j-green-soft: #4ADE80;
  --j-amber: #F59E0B;

  /* Grays */
  --j-gray-333: #333;
  --j-gray-444: #444;
  --j-gray-555: #555;
  --j-gray-666: #666;
  --j-gray-999: #999;
  --j-text: #E5E5E5;
  --j-text-dim: #CCC;

  /* Type */
  --font-terminal: 'VT323', monospace;
  --font-ui: 'Inter', sans-serif;

  /* Motion (legacy index.html tokens) */
  --ease-out: cubic-bezier(0.25, 0.46, 0.45, 0.94);
  --ease-out-quart: cubic-bezier(0.165, 0.84, 0.44, 1);
  --duration-fast: 100ms;
  --duration-standard: 150ms;
  --duration-slow: 250ms;

  /* Back-compat aliases used by pre-port component css */
  --border: var(--j-gray-333);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0;
  font-family: var(--font-terminal);
  background-color: var(--j-yellow);
  color: #000;
  -webkit-font-smoothing: antialiased;
}

/* × corner marks on the yellow shell (legacy body::before/::after) */
body::before,
body::after {
  content: '\00D7';
  position: fixed;
  top: 4px;
  font-size: 28px;
  color: rgba(0, 0, 0, 0.2);
  font-weight: 900;
  z-index: 50;
  pointer-events: none;
  user-select: none;
}
body::before { left: 8px; }
body::after { right: 8px; }

::selection { background: rgba(255, 214, 0, 0.3); color: #000; }

/* Scrollbars (legacy) */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: var(--j-crt-2); }
::-webkit-scrollbar-thumb { background: var(--j-gray-333); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--j-yellow); }

/* Button press feedback (legacy) */
button {
  touch-action: manipulation;
  transition: transform var(--duration-fast) var(--ease-out);
}
button:active { transform: scale(0.97); }
button:focus-visible { outline: 2px solid var(--j-yellow); outline-offset: 2px; }

/* CRT scanline overlay — apply to a position:absolute inset:0 child of any panel */
.scanlines {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.1) 50%),
    linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06));
  background-size: 100% 2px, 3px 100%;
  opacity: 0.1;
  pointer-events: none;
  z-index: 5;
}

@keyframes message-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.message-enter { animation: message-enter 200ms var(--ease-out-quart); }

@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
@keyframes thinking-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
@keyframes pulse-warn { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
@keyframes pulse-dot { 0%, 80%, 100% { opacity: 0.6; } 40% { opacity: 1; } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.app-state-enter { animation: fadeIn var(--duration-slow) var(--ease-out); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 3: Verify the app still builds and checks**

Run: `cd app && bunx vite build && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: build succeeds; svelte-check 0 errors. (Components still render with old inline colors — that's fine; they restyle in sibling tasks.)

- [ ] **Step 4: Run the app suite**

Run: `cd app && bunx vitest run`
Expected: all 16 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/app.css app/public/fonts
git commit -m "Design tokens: port legacy palette/motion/scanlines, self-host VT323+Inter"
```

---

### Task 2: Sound module (placeholder port)

**Type:** implementation
**Depends-on:** none

**Files:**
- Create: `app/src/lib/sfx.ts`
- Create: `app/src/lib/sfx.test.ts`
- Modify: `app/vite.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sfx.play(name: SfxName): void`, `sfx.playBoot(): void`, `sfx.mute(): boolean`, `sfx.isMuted(): boolean`, `type SfxName` (union of the 15 legacy sound names). The app-shell task wires these to tab clicks and the mute button.

The mp3s in the repo-root `sfx/` directory are **placeholders** — Marcus will redo the sound palette later by replacing files only. Do not add new sound files; do not rename events.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/lib/sfx.test.ts
import { describe, expect, test, beforeEach, vi } from 'vitest';

class FakeAudio {
  static created: string[] = [];
  src: string; preload = ''; volume = 1;
  constructor(src: string) { this.src = src; FakeAudio.created.push(src); }
  cloneNode() { return new FakeAudio(this.src); }
  play() { return Promise.resolve(); }
}

describe('sfx', () => {
  beforeEach(() => {
    vi.resetModules();
    FakeAudio.created = [];
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('localStorage', {
      store: {} as Record<string, string>,
      getItem(k: string) { return this.store[k] ?? null; },
      setItem(k: string, v: string) { this.store[k] = v; },
    });
  });

  test('preloads all 15 legacy sounds from /sfx/ at 40% volume', async () => {
    const { sfx } = await import('./sfx');
    sfx.play('tab');
    expect(FakeAudio.created).toContain('/sfx/tab.mp3');
    expect(FakeAudio.created.filter((s) => s.startsWith('/sfx/')).length).toBeGreaterThanOrEqual(15);
  });

  test('mute toggles and persists to localStorage under julian-sfx-muted', async () => {
    const { sfx } = await import('./sfx');
    expect(sfx.isMuted()).toBe(false);
    expect(sfx.mute()).toBe(true);
    expect(localStorage.getItem('julian-sfx-muted')).toBe('true');
    expect(sfx.mute()).toBe(false);
  });

  test('playBoot only fires once', async () => {
    const { sfx } = await import('./sfx');
    const n = FakeAudio.created.length;
    sfx.playBoot();
    sfx.playBoot();
    expect(FakeAudio.created.length).toBe(n + 1); // one clone, not two
  });

  test('is inert when Audio is unavailable (SSR/test env)', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    const { sfx } = await import('./sfx');
    expect(() => sfx.play('boot')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && bunx vitest run src/lib/sfx.test.ts`
Expected: FAIL — `Cannot find module './sfx'`.

- [ ] **Step 3: Implement `app/src/lib/sfx.ts`**

```typescript
// Placeholder port of the legacy SoundManager (index.html). The mp3 files in
// /sfx/ are stand-ins Marcus intends to replace; the event names are the API.
const SOUND_NAMES = [
  'boot', 'shutdown', 'level-up', 'click', 'notification', 'success',
  'error', 'open', 'close', 'select', 'navigate', 'tab',
  'toggle-on', 'toggle-off', 'delete',
] as const;

export type SfxName = (typeof SOUND_NAMES)[number];

const MUTE_KEY = 'julian-sfx-muted';
const VOLUME = 0.4;

class SoundManager {
  private sounds = new Map<SfxName, HTMLAudioElement>();
  private muted: boolean;
  private bootPlayed = false;

  constructor(basePath: string) {
    this.muted = typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === 'true';
    if (typeof Audio === 'undefined') return; // inert outside the browser
    for (const name of SOUND_NAMES) {
      const audio = new Audio(`${basePath}${name}.mp3`);
      audio.preload = 'auto';
      audio.volume = VOLUME;
      this.sounds.set(name, audio);
    }
  }

  play(name: SfxName): void {
    if (this.muted) return;
    const source = this.sounds.get(name);
    if (!source) return;
    const clone = source.cloneNode() as HTMLAudioElement;
    clone.volume = source.volume;
    void clone.play().catch(() => {}); // audio failures never break UI
  }

  playBoot(): void {
    if (this.bootPlayed) return;
    this.bootPlayed = true;
    this.play('boot');
  }

  mute(): boolean {
    this.muted = !this.muted;
    if (typeof localStorage !== 'undefined') localStorage.setItem(MUTE_KEY, String(this.muted));
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }
}

export const sfx = new SoundManager('/sfx/');
```

- [ ] **Step 4: Proxy `/sfx` in dev so vite serves the mp3s from the Bun server**

In `app/vite.config.ts`, add one entry to the existing `server.proxy` object (after the `'/sprites'` line):

```typescript
      '/sfx': 'http://localhost:8000',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && bunx vitest run src/lib/sfx.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 6: Full app suite + commit**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: all green.

```bash
git add app/src/lib/sfx.ts app/src/lib/sfx.test.ts app/vite.config.ts
git commit -m "Sound: placeholder port of legacy SoundManager (mechanism now, palette later)"
```

---

### Task 3: PixelFace canvas component

**Type:** implementation
**Depends-on:** none

**Files:**
- Create: `app/src/lib/faces.ts`
- Create: `app/src/lib/faces.test.ts`
- Create: `app/src/components/PixelFace.svelte`

**Interfaces:**
- Consumes: nothing.
- Produces: `PixelFace.svelte` with props `{ talking?: boolean; size?: number; color?: string; eyes?: EyeVariant; mouth?: MouthVariant }` (defaults: `talking=false`, `size=120`, `color='#FFD600'`, `eyes='standard'`, `mouth='gentle'`); `faces.ts` exports `EYE_VARIANTS`, `MOUTH_VARIANTS`, `type EyeVariant`, `type MouthVariant`, `type Pixel = [number, number]`, `hashNameToFaceVariant(name: string): { eyes: EyeVariant; mouth: MouthVariant }`. The face-header task renders this component.

Port the sprite data VERBATIM from `chat.jsx` lines 168–319 (the `EYE_VARIANTS` object with `standard`/`round`/`narrow`/`wide`, each `{left, right}` pixel arrays, and `MOUTH_VARIANTS` with `gentle`/`straight`/`cheerful`/`asymmetric`, each `{idle, talk1, talk2}`). Do not retype coordinates by hand — copy the object literals from the source file and add types. Omit `GENDER_MARKERS` and `AGENT_COLORS` (agent features are out of scope; Julian's face only).

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/lib/faces.test.ts
import { describe, expect, test } from 'vitest';
import { EYE_VARIANTS, MOUTH_VARIANTS, hashNameToFaceVariant } from './faces';

describe('faces', () => {
  test('all four eye variants have left and right pixel arrays', () => {
    for (const key of ['standard', 'round', 'narrow', 'wide'] as const) {
      expect(EYE_VARIANTS[key].left.length).toBeGreaterThan(0);
      expect(EYE_VARIANTS[key].right.length).toBeGreaterThan(0);
    }
  });
  test('all four mouth variants have idle, talk1, talk2 frames', () => {
    for (const key of ['gentle', 'straight', 'cheerful', 'asymmetric'] as const) {
      expect(MOUTH_VARIANTS[key].idle.length).toBeGreaterThan(0);
      expect(MOUTH_VARIANTS[key].talk1.length).toBeGreaterThan(0);
      expect(MOUTH_VARIANTS[key].talk2.length).toBeGreaterThan(0);
    }
  });
  test('every pixel is inside the 32x32 grid', () => {
    const all = [
      ...Object.values(EYE_VARIANTS).flatMap((v) => [...v.left, ...v.right]),
      ...Object.values(MOUTH_VARIANTS).flatMap((v) => [...v.idle, ...v.talk1, ...v.talk2]),
    ];
    for (const [x, y] of all) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(32);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(32);
    }
  });
  test('hashNameToFaceVariant is deterministic and total', () => {
    expect(hashNameToFaceVariant('Julian')).toEqual(hashNameToFaceVariant('Julian'));
    const v = hashNameToFaceVariant('');
    expect(EYE_VARIANTS[v.eyes]).toBeDefined();
    expect(MOUTH_VARIANTS[v.mouth]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && bunx vitest run src/lib/faces.test.ts`
Expected: FAIL — `Cannot find module './faces'`.

- [ ] **Step 3: Create `app/src/lib/faces.ts`**

Shape (pixel arrays copied verbatim from `chat.jsx` — abbreviated here with the first entries so signatures are unambiguous; the implementer copies the full literals):

```typescript
export type Pixel = [number, number];
export type EyeVariant = 'standard' | 'round' | 'narrow' | 'wide';
export type MouthVariant = 'gentle' | 'straight' | 'cheerful' | 'asymmetric';

export const EYE_VARIANTS: Record<EyeVariant, { left: Pixel[]; right: Pixel[] }> = {
  standard: {
    left: [[8,10],[9,10],[10,10],[7,11],[11,11], /* …verbatim from chat.jsx:169–186 */],
    right: [[20,9],[21,9],[22,9], /* …verbatim */],
  },
  round: { /* …verbatim from chat.jsx:187–204 */ },
  narrow: { /* …verbatim from chat.jsx:205–222 */ },
  wide: { /* …verbatim from chat.jsx:223–238 */ },
};

export const MOUTH_VARIANTS: Record<MouthVariant, { idle: Pixel[]; talk1: Pixel[]; talk2: Pixel[] }> = {
  gentle: { /* …verbatim from chat.jsx:242–262 */ },
  straight: { /* …verbatim from chat.jsx:263–276 */ },
  cheerful: { /* …verbatim from chat.jsx:277–297 */ },
  asymmetric: { /* …verbatim from chat.jsx:298–318 */ },
};

const EYE_KEYS = Object.keys(EYE_VARIANTS) as EyeVariant[];
const MOUTH_KEYS = Object.keys(MOUTH_VARIANTS) as MouthVariant[];

export function hashNameToFaceVariant(name: string): { eyes: EyeVariant; mouth: MouthVariant } {
  if (!name) return { eyes: EYE_KEYS[0], mouth: MOUTH_KEYS[0] };
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  hash = Math.abs(hash);
  return { eyes: EYE_KEYS[hash % EYE_KEYS.length], mouth: MOUTH_KEYS[(hash >> 4) % MOUTH_KEYS.length] };
}
```

- [ ] **Step 4: Create `app/src/components/PixelFace.svelte`**

Port of the legacy canvas renderer (chat.jsx 363–458): 32×32 canvas scaled to `size` with `image-rendering: pixelated`; background `#0F0F0F`; eyes hidden while blinking (random 2–5 s schedule, 150 ms blink); mouth alternates `talk1`/`talk2` every 150 ms while `talking`, else `idle`; animation loop only runs while talking or blinking.

```svelte
<!-- app/src/components/PixelFace.svelte -->
<script lang="ts">
  import { EYE_VARIANTS, MOUTH_VARIANTS, type EyeVariant, type MouthVariant, type Pixel } from '../lib/faces';

  let {
    talking = false, size = 120, color = '#FFD600',
    eyes = 'standard' as EyeVariant, mouth = 'gentle' as MouthVariant,
  }: {
    talking?: boolean; size?: number; color?: string; eyes?: EyeVariant; mouth?: MouthVariant;
  } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let blinking = false;
  let anim: number | null = null;

  function drawPixels(ctx: CanvasRenderingContext2D, pixels: Pixel[]) {
    ctx.fillStyle = color;
    for (const [x, y] of pixels) ctx.fillRect(x, y, 1, 1);
  }

  function draw() {
    const ctx = canvas?.getContext('2d');
    if (!ctx) { anim = null; return; }
    ctx.fillStyle = '#0F0F0F';
    ctx.fillRect(0, 0, 32, 32);
    const eye = EYE_VARIANTS[eyes];
    const mo = MOUTH_VARIANTS[mouth];
    if (!blinking) { drawPixels(ctx, eye.left); drawPixels(ctx, eye.right); }
    if (talking) drawPixels(ctx, Math.floor(Date.now() / 150) % 2 === 0 ? mo.talk1 : mo.talk2);
    else drawPixels(ctx, mo.idle);
    anim = talking || blinking ? requestAnimationFrame(draw) : null;
  }

  $effect(() => {
    void talking; void color; void eyes; void mouth; // redraw on prop change
    draw();
  });

  $effect(() => {
    let blinkTimeout: ReturnType<typeof setTimeout>;
    function scheduleBlink() {
      blinkTimeout = setTimeout(() => {
        blinking = true;
        if (!anim) anim = requestAnimationFrame(draw);
        blinkTimeout = setTimeout(() => {
          blinking = false;
          if (!anim) anim = requestAnimationFrame(draw);
          scheduleBlink();
        }, 150);
      }, Math.random() * 3000 + 2000);
    }
    scheduleBlink();
    return () => {
      clearTimeout(blinkTimeout);
      if (anim) cancelAnimationFrame(anim);
      anim = null;
    };
  });
</script>

<canvas bind:this={canvas} width={32} height={32} style:width="{size}px" style:height="{size}px"></canvas>

<style>
  canvas { image-rendering: pixelated; }
</style>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && bunx vitest run src/lib/faces.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 6: Full check + commit**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: all green, 0 errors.

```bash
git add app/src/lib/faces.ts app/src/lib/faces.test.ts app/src/components/PixelFace.svelte
git commit -m "PixelFace: port sprite data and canvas renderer from legacy chat.jsx"
```

---

### Task 4: MessageBubble + ChatInput restyle

**Type:** implementation
**Depends-on:** 1

**Files:**
- Modify: `app/src/components/MessageBubble.svelte`
- Modify: `app/src/components/ChatInput.svelte`

**Interfaces:**
- Consumes: Task 1 tokens (`--j-yellow`, `--j-yellow-key`, `--font-terminal`, `.message-enter`, `--j-gray-666`, `--j-gray-999`, `--ease-out`).
- Produces: unchanged component contracts — `MessageBubble` props `{ role: string; speakerName: string; text: string; ts: number }`; `ChatInput` props `{ onSend: (text: string) => void; disabled?: boolean }`. Parent components keep passing exactly what they pass today.

Legacy look: chat is a terminal log, not bubbles. Julian lines are yellow VT323 1.1rem prefixed `> `; user lines are white at 80 % opacity prefixed `// ` with the prefix in gray. No visible timestamps or speaker labels (keep them in a `title` tooltip so the data isn't lost).

- [ ] **Step 1: Replace `MessageBubble.svelte`**

```svelte
<!-- app/src/components/MessageBubble.svelte -->
<script lang="ts">
  let { role, speakerName, text, ts }: { role: string; speakerName: string; text: string; ts: number } = $props();
  const time = $derived(new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
</script>

<div class="line {role} message-enter" title="{speakerName} · {time}">
  <span class="prefix">{role === 'user' ? '// ' : '> '}</span><span class="text">{text}</span>
</div>

<style>
  .line {
    padding: 4px 0;
    font-family: var(--font-terminal);
    font-size: 1.1rem;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .line.assistant { color: var(--j-yellow); text-shadow: 0 0 4px rgba(0, 0, 0, 0.3); }
  .line.assistant .prefix { color: var(--j-yellow); }
  .line.user { color: #fff; opacity: 0.8; }
  .line.user .prefix { color: var(--j-gray-666); }
</style>
```

- [ ] **Step 2: Replace `ChatInput.svelte`**

The legacy keyboard: `#C8A800` inset textarea, VT323 uppercase bold black, autogrow 50→200 px with a 150 ms height animation, `INPUT BUFFER...` placeholder (`PROCESSING...` when disabled); round 60 px **A** send button with the 3D press shadow.

```svelte
<!-- app/src/components/ChatInput.svelte -->
<script lang="ts">
  let { onSend, disabled = false }: { onSend: (text: string) => void; disabled?: boolean } = $props();

  const MIN_H = 50;
  const MAX_H = 200;
  let draft = $state('');
  let area: HTMLTextAreaElement | undefined = $state();
  let prevHeight = MIN_H;

  function adjustHeight() {
    const el = area;
    if (!el) return;
    el.style.transition = 'none';
    el.style.height = 'auto';
    const target = Math.min(Math.max(el.scrollHeight, MIN_H), MAX_H);
    el.style.height = `${prevHeight}px`;
    void el.offsetHeight; // reflow, then animate to target
    el.style.transition = 'height 150ms cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    el.style.height = `${target}px`;
    el.style.overflowY = target >= MAX_H ? 'auto' : 'hidden';
    prevHeight = target;
  }

  function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    draft = '';
    if (area) {
      area.style.height = `${MIN_H}px`;
      area.style.overflowY = 'hidden';
      prevHeight = MIN_H;
    }
  }

  $effect(() => { if (!disabled) area?.focus(); });
</script>

<div class="input">
  <textarea
    bind:this={area}
    bind:value={draft}
    oninput={adjustHeight}
    onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
    placeholder={disabled ? 'PROCESSING...' : 'INPUT BUFFER...'}
    {disabled}
    spellcheck="false"
    autocomplete="off"
    rows="1"
  ></textarea>
  <button class="send" onclick={submit} {disabled} aria-label="Send message">A</button>
</div>

<style>
  .input { display: flex; align-items: flex-end; gap: 12px; padding: 12px 0; }
  textarea {
    flex: 1;
    background-color: var(--j-yellow-key);
    box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.15), inset -1px -1px 2px rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: #000;
    font-weight: bold;
    padding: 12px 16px;
    height: 50px;
    font-family: var(--font-terminal);
    text-transform: uppercase;
    font-size: 1.1rem;
    line-height: 1.4;
    border: none;
    outline: none;
    resize: none;
    overflow-y: hidden;
  }
  textarea:disabled { opacity: 0.5; }
  textarea::placeholder { color: rgba(0, 0, 0, 0.55); }
  .send {
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background: #e5e5e5;
    color: var(--j-gray-333);
    border: 1px solid var(--j-gray-999);
    box-shadow: 0 4px 0 var(--j-gray-999), 0 8px 10px rgba(0, 0, 0, 0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-terminal);
    font-size: 0.9rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: background-color 100ms ease, box-shadow 100ms ease;
    flex-shrink: 0;
  }
  .send:active { transform: translateY(4px); box-shadow: 0 0 0 var(--j-gray-999), inset 0 2px 5px rgba(0, 0, 0, 0.1); }
  .send:disabled { background: var(--j-gray-555); box-shadow: none; cursor: not-allowed; }
  @media (prefers-reduced-motion: reduce) { textarea { transition: none !important; } }
</style>
```

- [ ] **Step 3: Verify suite + check**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: all green, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/MessageBubble.svelte app/src/components/ChatInput.svelte
git commit -m "Restyle MessageBubble + ChatInput to legacy terminal look"
```

---

### Task 5: ChatView restyle (CRT panels + processing indicator)

**Type:** implementation
**Depends-on:** 1

**Files:**
- Modify: `app/src/components/ChatView.svelte`

**Interfaces:**
- Consumes: Task 1 tokens (`--j-crt-2`, `--j-bezel`, `.scanlines`, `--j-yellow`, `--font-terminal`, keyframe `thinking-pulse`); existing store API (`store.getRow`, `useSortedMessages`, `sendMessage`) unchanged; child components MessageBubble (`{role, speakerName, text, ts}`) and ChatInput (`{onSend, disabled}`) by their existing prop contracts.
- Produces: `ChatView` props widen to `{ processing?: boolean; sessionActive?: boolean; onStart?: () => void }` — the app-shell task passes `sessionActive` and `onStart` so the START SESSION button can live in the input footer, exactly where the legacy app puts it.

**Parallelization rationale:** the widened props contract is fixed here as text so the app-shell task (which consumes it) can be authored in parallel without waiting for this file to exist; the seam is a real one — ChatView owns the two bezel panels, App owns the room.

- [ ] **Step 1: Replace `ChatView.svelte`**

```svelte
<!-- app/src/components/ChatView.svelte -->
<script lang="ts">
  import { store } from '../lib/store';
  import type { MessageRow } from '../lib/store';
  import { useSortedMessages } from '../lib/tiny.svelte';
  import { sendMessage } from '../lib/api';
  import MessageBubble from './MessageBubble.svelte';
  import ChatInput from './ChatInput.svelte';

  let { processing = false, sessionActive = false, onStart = () => {} }: {
    processing?: boolean; sessionActive?: boolean; onStart?: () => void;
  } = $props();

  const messages = useSortedMessages();
  let scroller: HTMLElement | undefined = $state();
  $effect(() => { messages.ids; scroller?.scrollTo({ top: scroller.scrollHeight }); });

  function rowOf(id: string) {
    return store.getRow('messages', id) as unknown as MessageRow;
  }
</script>

<section class="chat">
  <div class="messages-panel">
    <div class="scanlines"></div>
    <div class="messages" bind:this={scroller}>
      {#each messages.ids as id (id)}
        {@const m = rowOf(id)}
        <MessageBubble role={m.role} speakerName={m.speakerName} text={m.text} ts={m.ts} />
      {/each}
      {#if processing}
        <div class="thinking">
          <span>&gt; PROCESSING</span>
          <span class="dots">
            <span class="dot"></span>
            <span class="dot d2"></span>
            <span class="dot d3"></span>
          </span>
        </div>
      {/if}
    </div>
  </div>
  <div class="input-footer">
    {#if !sessionActive}
      <div class="start-wrap">
        <button class="start" onclick={onStart}>START SESSION</button>
      </div>
    {:else}
      <ChatInput onSend={(t) => sendMessage(t)} disabled={processing} />
    {/if}
  </div>
</section>

<style>
  .chat { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .messages-panel {
    flex: 1;
    position: relative;
    background: var(--j-crt-2);
    border: 4px solid var(--j-bezel);
    border-top: none;
    border-bottom: none;
    min-height: 0;
    display: flex;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    scroll-behavior: smooth;
    padding: 16px;
    position: relative;
    z-index: 1;
  }
  .thinking {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    color: var(--j-yellow);
    font-size: 1.1rem;
    font-family: var(--font-terminal);
  }
  .dots { display: flex; gap: 4px; margin-left: 4px; }
  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    background: var(--j-yellow);
    animation: thinking-pulse 1.2s ease-in-out infinite;
  }
  .dot.d2 { animation-delay: 0.2s; }
  .dot.d3 { animation-delay: 0.4s; }
  .input-footer {
    background: var(--j-crt-2);
    border: 4px solid var(--j-bezel);
    border-top: 1px dashed var(--j-gray-333);
    border-radius: 0 0 12px 12px;
    padding: 0 16px;
    box-shadow: inset 0 -2px 10px rgba(0, 0, 0, 0.5);
    flex-shrink: 0;
  }
  .start-wrap { padding: 12px 0; text-align: center; }
  .start {
    padding: 10px 24px;
    font-family: var(--font-terminal);
    font-size: 1.1rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    background: var(--j-yellow);
    color: #000;
    border: 2px solid #000;
    border-radius: 4px;
    cursor: pointer;
    box-shadow: 3px 3px 0 #000;
  }
</style>
```

- [ ] **Step 2: Verify suite + check**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: all green. (App.svelte still compiles — the new props are optional, so the old call site `<ChatView {processing} />` remains valid until the app-shell task rewires it.)

- [ ] **Step 3: Commit**

```bash
git add app/src/components/ChatView.svelte
git commit -m "Restyle ChatView: CRT panels, scanlines, PROCESSING dots, footer START SESSION"
```

---

### Task 6: FaceHeader component (replaces SessionBar's role)

**Type:** implementation
**Depends-on:** 1, 3

**Files:**
- Create: `app/src/components/FaceHeader.svelte`

**Interfaces:**
- Consumes: Task 1 tokens; Task 3's `PixelFace.svelte` (props `{ talking?: boolean; size?: number }`).
- Produces: `FaceHeader.svelte` with props `{ sessionActive: boolean; processing?: boolean; onEnd: () => void }` — the START action moves to the chat footer (owned by the chat-view restyle), and the legacy NEW button is omitted because the rewrite has no new-conversation API yet. The app-shell task swaps this in for SessionBar and deletes the old component; creating a new file here keeps this task's tree compiling clean (`SessionBar` keeps its old contract until the swap).

**Parallelization rationale:** new-file seam — building the header as a fresh component instead of mutating `SessionBar.svelte` in place means this task never breaks the existing `App.svelte` call site, so it can run in the same wave as the other restyles with zero intermediate type errors. (Renaming the component is right anyway: the thing is a face header, not a bar.)

Legacy source: index.html face header (`SYS.VER.2.4` label, status dots, PixelFace 56 px, `JULIAN` VT323 1.4 rem yellow, status line `OFFLINE`/`PROCESSING...`/`LISTENING` dim yellow, END chip when a session is active).

- [ ] **Step 1: Create `FaceHeader.svelte`**

```svelte
<!-- app/src/components/FaceHeader.svelte -->
<!-- The face header of the chat machine (legacy index.html left-column header). -->
<script lang="ts">
  import PixelFace from './PixelFace.svelte';

  let { sessionActive, processing = false, onEnd }: {
    sessionActive: boolean; processing?: boolean; onEnd: () => void;
  } = $props();

  const status = $derived(!sessionActive ? 'OFFLINE' : processing ? 'PROCESSING...' : 'LISTENING');
</script>

<header class="face-header">
  <span class="sysver">SYS.VER.3.0</span>
  <span class="status-dots" class:ok={sessionActive}>
    <span class="sdot"></span><span class="sdot"></span><span class="sdot"></span>
  </span>
  <div class="row">
    <PixelFace talking={processing} size={56} />
    <div class="who">
      <div class="name">JULIAN</div>
      <div class="state">{status}</div>
    </div>
    {#if sessionActive}
      <button class="end" onclick={onEnd}>END</button>
    {/if}
  </div>
</header>

<style>
  .face-header {
    background: var(--j-crt-2);
    border: 4px solid var(--j-bezel);
    border-bottom: 1px dashed var(--j-gray-333);
    border-radius: 12px 12px 0 0;
    padding: 12px 16px;
    box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.5);
    position: relative;
    flex-shrink: 0;
  }
  .sysver {
    position: absolute;
    top: 8px;
    left: 12px;
    font-family: var(--font-terminal);
    font-size: 0.75rem;
    color: var(--j-yellow-dim);
    letter-spacing: 0.2em;
  }
  .status-dots { position: absolute; top: 10px; right: 12px; display: flex; gap: 4px; }
  .sdot { width: 6px; height: 6px; border-radius: 50%; background: var(--j-gray-444); }
  .status-dots.ok .sdot { background: var(--j-green); box-shadow: 0 0 4px var(--j-green); }
  .status-dots:not(.ok) .sdot:first-child { background: var(--j-red); animation: pulse-warn 2s ease-in-out infinite; }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 16px; width: 100%; }
  .who { flex: 1; }
  .name {
    font-family: var(--font-terminal);
    font-size: 1.4rem;
    color: var(--j-yellow);
    letter-spacing: 0.05em;
  }
  .state {
    font-family: var(--font-terminal);
    font-size: 0.85rem;
    color: var(--j-yellow-dim);
    opacity: 0.8;
  }
  .end {
    font-family: var(--font-terminal);
    font-size: 0.85rem;
    color: var(--j-red);
    background: var(--j-red-black);
    border: 1px solid var(--j-gray-333);
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    text-transform: uppercase;
  }
</style>
```

Note: `SYS.VER.3.0` intentionally bumps the legacy `SYS.VER.2.4` — the one deliberate pixel change, marking phase three. Everything else matches the source.

- [ ] **Step 2: Verify**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: all green, 0 errors — `SessionBar.svelte` is untouched, so the existing `App.svelte` call site still compiles; `FaceHeader` is simply not imported yet.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/FaceHeader.svelte
git commit -m "FaceHeader: legacy face header with PixelFace (App swap lands with app shell)"
```

---

### Task 7: App shell — yellow room, right console, tabs, mobile, boot screen

**Type:** implementation
**Depends-on:** 1, 2, 3, 5, 6

**Files:**
- Modify: `app/src/App.svelte`
- Modify: `app/index.html`
- Modify: `app/src/components/SessionBar.svelte`

**Interfaces:**
- Consumes: Task 1 tokens; Task 2 `sfx.play('tab')`, `sfx.playBoot()`, `sfx.mute()`, `sfx.isMuted()`; Task 3 `PixelFace` (boot screen, size 200); Task 5 `ChatView` props `{ processing, sessionActive, onStart }`; Task 6 `FaceHeader` props `{ sessionActive, processing, onEnd }`; existing `SetupScreen { onReady }`, `ScreenEmbed { sessionActive }`, `ArtifactPanel`, `SyncStatus` contracts unchanged.
- Produces: the final page composition; no exported symbols.

- [ ] **Step 1: Replace the template and styles in `App.svelte`**

Keep the entire `<script>` block as-is except: swap the SessionBar import for `import FaceHeader from './components/FaceHeader.svelte';`, add imports `import PixelFace from './components/PixelFace.svelte';` and `import { sfx } from './lib/sfx';`, add `let sfxMuted = $state(false);` initialized after mount from `sfx.isMuted()`, and call `sfx.playBoot()` inside the existing `startSession` click path (first user gesture). Then `git rm app/src/components/SessionBar.svelte`. Replace the template and `<style>`:

```svelte
{#if !booted}
  <div class="boot app-state-enter">
    <PixelFace size={200} />
    <div class="boot-label">WAKING…</div>
  </div>
{:else if !ready}
  <SetupScreen onReady={() => (ready = true)} />
{:else}
  <div class="room app-state-enter">
    <div class="machine">
      <FaceHeader {sessionActive} {processing} onEnd={() => endSession()} />
      <ChatView {processing} {sessionActive} onStart={() => { sfx.playBoot(); startSession(); }} />
    </div>
    <aside class="console">
      <nav class="tabbar">
        {#each ['screen', 'artifacts'] as const as t (t)}
          <button
            class="pill"
            class:active={tab === t}
            onclick={() => { if (tab !== t) { sfx.play('tab'); tab = t; } }}
          >{t.toUpperCase()}</button>
        {/each}
        <span class="spacer"></span>
        <SyncStatus />
        <button
          class="mute"
          title={sfxMuted ? 'Sound off' : 'Sound on'}
          onclick={() => (sfxMuted = sfx.mute())}
        >{sfxMuted ? '♪̸' : '♪'}</button>
      </nav>
      <div class="console-body">
        {#if tab === 'screen'}
          <ScreenEmbed {sessionActive} />
        {:else}
          <ArtifactPanel />
        {/if}
      </div>
    </aside>
  </div>
{/if}

<style>
  .boot {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 32px;
    height: 100vh;
    background: var(--j-crt-2);
  }
  .boot-label {
    font-family: var(--font-terminal);
    font-size: 18px;
    color: var(--j-yellow);
    letter-spacing: 0.2em;
    animation: blink 1.4s step-end infinite;
  }
  .room {
    display: flex;
    height: 100vh;
    padding: 16px;
    gap: 16px;
    background-color: var(--j-yellow);
  }
  .machine {
    width: 420px;
    min-width: 320px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .console {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    border: 1px solid var(--j-gray-333);
    border-radius: 12px;
    background: var(--j-crt-1);
    overflow: hidden;
  }
  .tabbar {
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 6px;
    height: 48px;
    flex-shrink: 0;
    background: rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }
  .pill {
    height: 32px;
    padding: 0 14px;
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: transparent;
    display: flex;
    align-items: center;
    font-size: 10px;
    font-family: var(--font-ui);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: background 300ms ease, color 300ms ease, border-color 300ms ease, box-shadow 300ms ease;
  }
  .pill:hover:not(.active) { background: var(--j-cyan); color: #000; border-color: var(--j-cyan); }
  .pill.active {
    background: var(--j-cyan);
    border-color: var(--j-cyan);
    color: #000;
    font-weight: 700;
    cursor: default;
    box-shadow: 0 0 15px rgba(0, 175, 209, 0.3);
  }
  .spacer { flex: 1; }
  .mute {
    height: 32px;
    width: 32px;
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: transparent;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
  }
  .console-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }

  /* Mobile: stacked machine, console content inline (legacy < 768px layout) */
  @media (max-width: 767px) {
    .room { flex-direction: column; padding: 8px; gap: 8px; }
    .machine { width: 100%; min-width: 0; flex: 1; min-height: 0; }
    .console { flex: none; height: 40vh; }
  }
</style>
```

- [ ] **Step 2: Add theme color to `app/index.html`**

Inside `<head>`, after the viewport meta, add:

```html
    <meta name="theme-color" content="#FFD600" />
```

- [ ] **Step 3: Full verification**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json && bunx vite build`
Expected: 16+ tests pass (plus sfx/faces tests from sibling tasks when merged), 0 check errors, build succeeds. Any residual SessionBar/ChatView prop errors mean the consumed contracts drifted — fix against the Interfaces blocks above, not by loosening types.

- [ ] **Step 4: Commit**

```bash
git add -A app/src/App.svelte app/index.html app/src/components/SessionBar.svelte
git commit -m "App shell: yellow room, chat machine, glass-tab console, boot screen, mobile"
```

---

### Task 8: SetupScreen restyle (shell only)

**Type:** implementation
**Depends-on:** 1

**Files:**
- Modify: `app/src/components/SetupScreen.svelte`

**Interfaces:**
- Consumes: Task 1 tokens.
- Produces: unchanged contract — props `{ onReady: () => void }`; the Clerk/OAuth logic inside is untouched (a separate auth effort replaces it later; this task must not alter any `<script>` code).

Legacy look (chat.jsx SetupScreen): the page sits on the yellow shell; heading `CONNECT TO CLAUDE` in VT323 2rem black uppercase letterspaced with a `ONE-TIME SETUP…` subline in `#555`; the interactive area is a dark panel (`#0F0F0F`, 4px `#2A2A2A` border, radius 12, inset shadow) with `> STEP`-prefixed yellow VT323 labels, dim-yellow body copy, `#C8A800` inset inputs, and a yellow primary button with `0 4px 0 #AA8800` press shadow.

- [ ] **Step 1: Rewrap the template**

Keep every `{#if}` branch and handler exactly as-is; change only classes/structure/copy presentation:

```svelte
{#if checking}
  <div class="setup"><div class="panel wait">CHECKING THE HOUSE…</div></div>
{:else if !signedIn && clerkInstance()}
  <div class="setup">
    <div class="head">
      <h1>SIGN IN</h1>
      <p>JULIAN'S HOUSE HAS A LOCK</p>
    </div>
    <div class="panel"><div bind:this={clerkMount}></div></div>
  </div>
{:else if needsSetup}
  <div class="setup">
    <div class="head">
      <h1>CONNECT TO CLAUDE</h1>
      <p>ONE-TIME SETUP TO LINK YOUR ACCOUNT</p>
    </div>
    <div class="panel">
      <div class="step">&gt; STEP 1: AUTHORIZE WITH ANTHROPIC</div>
      <p class="copy">OPENS ANTHROPIC IN A NEW TAB. AUTHORIZE, THEN COPY THE SHORT CODE BACK HERE.</p>
      <button class="primary" onclick={beginOauth}>SIGN IN WITH ANTHROPIC</button>
      {#if oauthUrl}
        <div class="step">&gt; STEP 2: PASTE AUTHORIZATION CODE</div>
        <input bind:value={code} placeholder="PASTE CODE HERE..." />
        <button class="primary" onclick={exchange}>COMPLETE</button>
      {/if}
      {#if error}<p class="error">{error}</p>{/if}
    </div>
  </div>
{/if}
```

- [ ] **Step 2: Replace the `<style>` block**

```css
  .setup {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    padding: 24px;
  }
  .head { text-align: center; }
  h1 {
    font-family: var(--font-terminal);
    font-size: 2rem;
    color: #000;
    margin: 16px 0 0;
    text-transform: uppercase;
    letter-spacing: 0.15em;
  }
  .head p { font-family: var(--font-terminal); font-size: 1.1rem; color: var(--j-gray-555); margin-top: 4px; }
  .panel {
    background: var(--j-crt-2);
    border: 4px solid var(--j-bezel);
    border-radius: 12px;
    box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.5);
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: min(480px, 100%);
  }
  .panel.wait { color: var(--j-yellow); font-family: var(--font-terminal); text-align: center; animation: blink 1.4s step-end infinite; }
  .step { font-family: var(--font-terminal); font-size: 1.1rem; color: var(--j-yellow); }
  .copy { font-family: var(--font-terminal); font-size: 1rem; color: var(--j-yellow-dim); line-height: 1.5; margin: 0; }
  .primary {
    padding: 14px 32px;
    border-radius: 8px;
    background: var(--j-yellow);
    color: #000;
    border: none;
    font-family: var(--font-terminal);
    font-size: 1.3rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    cursor: pointer;
    box-shadow: 0 4px 0 var(--j-yellow-dim), 0 8px 10px rgba(0, 0, 0, 0.15);
    transition: background-color 100ms ease, box-shadow 100ms ease;
  }
  .primary:active { transform: translateY(4px); box-shadow: none; }
  input {
    width: 100%;
    background-color: var(--j-yellow-key);
    box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.15), inset -1px -1px 2px rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: #000;
    font-weight: bold;
    padding: 0 16px;
    height: 50px;
    font-family: var(--font-terminal);
    font-size: 1.1rem;
    border: 2px solid transparent;
    outline: none;
  }
  .error { font-family: var(--font-terminal); font-size: 1rem; color: var(--j-red); }
```

- [ ] **Step 3: Verify the script block is untouched**

Run: `git diff app/src/components/SetupScreen.svelte | grep -E "^[+-]" | grep -v "^[+-][+-]" | grep -cE "^\+.*(fetch|clerk|oauth|getToken)" ` — manual eyeball: no logic lines changed. Then `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json` → green, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/SetupScreen.svelte
git commit -m "Restyle SetupScreen shell to legacy setup look (logic untouched)"
```

---

### Task 9: ArtifactPanel + ArtifactTree restyle

**Type:** implementation
**Depends-on:** 1

**Files:**
- Modify: `app/src/components/ArtifactPanel.svelte`
- Modify: `app/src/components/ArtifactTree.svelte`

**Interfaces:**
- Consumes: Task 1 tokens.
- Produces: unchanged contracts — `ArtifactPanel` no props; `ArtifactTree` props `{ entries, prefix?, onSelect }`.

Legacy vocabulary (chat.jsx ArtifactViewer): dark `--j-crt-1` surface, VT323 uppercase labels, the 8×8 pixel-grid empty state (64 six-px squares, indices where `i % 7 === 0 || i % 11 === 0` are yellow, rest `#333`, whole grid at 0.15 opacity) captioned `> SELECT ARTIFACT TO DISPLAY` / `> AWAITING ARTIFACT GENERATION` in `#444` with a `JULIAN WILL CREATE ARTIFACTS HERE` subline in `#333`; iframe on white with 8px bottom radii.

- [ ] **Step 1: Restyle `ArtifactPanel.svelte`**

Keep the script identical. Template: keep `nav` + iframe structure, replace the `.empty` div with the pixel-grid empty state:

```svelte
  {#if iframeSrc}
    <iframe title="artifact" src={iframeSrc} sandbox="allow-scripts allow-same-origin"></iframe>
  {:else}
    <div class="empty">
      <div class="pixelgrid">
        {#each Array.from({ length: 64 }, (_, i) => i) as i (i)}
          <div class="px" class:lit={i % 7 === 0 || i % 11 === 0}></div>
        {/each}
      </div>
      <div class="caption">
        {entries.length > 0 ? '> SELECT ARTIFACT TO DISPLAY' : '> AWAITING ARTIFACT GENERATION'}
      </div>
      <div class="subcaption">JULIAN WILL CREATE ARTIFACTS HERE</div>
    </div>
  {/if}
```

New styles:

```css
  .artifacts { display: grid; grid-template-columns: 16rem 1fr; height: 100%; min-height: 0; background: var(--j-crt-1); }
  nav { overflow-y: auto; border-right: 1px solid var(--j-gray-333); padding: 12px; }
  iframe { width: 100%; height: 100%; border: 0; background: white; border-radius: 0 0 8px 8px; }
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
  .pixelgrid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; opacity: 0.15; }
  .px { width: 6px; height: 6px; background: var(--j-gray-333); }
  .px.lit { background: var(--j-yellow); }
  .caption { font-family: var(--font-terminal); font-size: 1.2rem; color: var(--j-gray-444); text-transform: uppercase; letter-spacing: 0.1em; text-align: center; }
  .subcaption { font-family: var(--font-terminal); font-size: 0.9rem; color: var(--j-gray-333); text-align: center; }
  .error { color: var(--j-red-soft); font-family: var(--font-terminal); }
```

- [ ] **Step 2: Restyle `ArtifactTree.svelte`** (styles only)

```css
  ul { list-style: none; padding-left: 0.75rem; margin: 0; }
  button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 0;
    font-family: var(--font-terminal);
    font-size: 1rem;
    color: var(--j-yellow-dim);
    text-align: left;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .folder { color: var(--j-text-dim); }
  .file:hover, .folder:hover { color: var(--j-yellow); }
```

- [ ] **Step 3: Verify + commit**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: green, 0 errors.

```bash
git add app/src/components/ArtifactPanel.svelte app/src/components/ArtifactTree.svelte
git commit -m "Restyle artifact panel/tree to legacy retro viewer"
```

---

### Task 10: ScreenEmbed frame + SyncStatus restyle

**Type:** implementation
**Depends-on:** 1

**Files:**
- Modify: `app/src/components/ScreenEmbed.svelte`
- Modify: `app/src/components/SyncStatus.svelte`

**Interfaces:**
- Consumes: Task 1 tokens (`--j-crt-0`, `--j-bezel`, `.scanlines`, `--j-yellow`, `--j-red-soft`, keyframe `pulse-warn`).
- Produces: unchanged contracts — `ScreenEmbed { sessionActive }`, `SyncStatus` no props.

- [ ] **Step 1: Align ScreenEmbed's frame to the legacy JulianScreenEmbed**

Container: `background: var(--j-crt-0); border: 4px solid var(--j-bezel); border-radius: 12px; overflow: hidden; aspect-ratio: 4/3;` with a `.scanlines` overlay child (add `border-radius: 12px` to it) and the connection dot top-right (8px circle; connected → `background: var(--j-yellow); box-shadow: 0 0 6px var(--j-yellow)`; disconnected → `background: var(--j-red-soft); box-shadow: 0 0 4px var(--j-red-soft); animation: pulse-warn 2s ease-in-out infinite`). Canvas keeps `image-rendering: pixelated`. Change ONLY style declarations; do not touch the WebSocket/scale logic — `ScreenEmbed.test.ts` must pass unmodified.

- [ ] **Step 2: Restyle SyncStatus to the retro dot idiom**

Keep script and markup; replace styles:

```css
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-family: var(--font-terminal);
    font-size: 0.85rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.5);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--j-gray-666); }
  .synced .dot { background: var(--j-green); box-shadow: 0 0 6px var(--j-green); }
  .connecting .dot { background: var(--j-yellow); animation: pulse-warn 2s ease-in-out infinite; }
  .offline .dot { background: var(--j-red); }
```

- [ ] **Step 3: Verify + commit**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: green — especially `ScreenEmbed.test.ts` unchanged and passing.

```bash
git add app/src/components/ScreenEmbed.svelte app/src/components/SyncStatus.svelte
git commit -m "Restyle ScreenEmbed frame + SyncStatus dot to legacy idiom"
```

---

### Task 11: Full verification gate

**Type:** gate
**Depends-on:** 1, 2, 3, 4, 5, 6, 7, 8, 9, 10

**Files:** none.

- [ ] **Step 1: App suite** — `cd app && bun install && bunx vitest run` → all tests pass (16 pre-existing + sfx + faces).
- [ ] **Step 2: Types** — `cd app && bunx svelte-check --tsconfig ./tsconfig.json` → 0 errors, 0 warnings introduced.
- [ ] **Step 3: Build** — `cd app && bunx vite build` → succeeds; `ls app/dist/fonts` shows both woff2 files.
- [ ] **Step 4: Sibling packages untouched** — `cd shared && bunx vitest run`, `cd sync && bunx vitest run`, `cd scripts && bunx vitest run`, root `bun test tests/` → all green.

---

### Task 12: Side-by-side visual verification in Chrome

**Type:** manual
**Depends-on:** 11

**Files:** none.

- [ ] **Step 1:** Legacy app already runs on port 8000. Start the new app: `PORT=8099 bun run server/server.ts` after `cd app && bunx vite build` (or `cd app && bunx vite --port 5173` for HMR against the port-8000 API).
- [ ] **Step 2:** In Chrome, compare surface by surface at 1440×900 and at <768 px width: setup screen, idle (no session), START SESSION, active session with streaming reply, PROCESSING indicator, artifact open, SCREEN tab, mute toggle, tab sounds.
- [ ] **Step 3:** Screenshot pairs; fix any pixel drift found (spacing, sizes, colors) directly against the legacy values; re-run Task 11 checks after fixes.
