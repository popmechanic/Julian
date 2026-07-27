# Sleep Presence Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When no session is active, the app says so in Julian's own ontology — sleeping pixel face, `ASLEEP` status, a quiet divider under the transcript, and a `WAKE JULIAN` button — while the synced transcript stays fully visible.

**Architecture:** Three Svelte components and one lib file, no server/store/schema changes. Logic that tests assert on is extracted as pure functions exported from `<script module>` blocks (the established pattern — see how the screen-embed component exports its parser for tests); markup binds to those functions so tests and UI cannot drift.

**Tech Stack:** Svelte 5 (runes), TypeScript, Vitest (uses `app/vite.config.ts` — the svelte plugin there is what lets tests import `.svelte` modules), Bun.

**Acceptance:** suite — small UI presence change; the committed vitest suites plus the svelte-check/build gate are the verification.

## Global Constraints

- Exact user-facing strings (copy verbatim, including case): status `ASLEEP`; button label `WAKE JULIAN`; divider text `— julian is asleep · the conversation above is remembered, not live —`.
- Behavior when `sessionActive` is true is completely unchanged (spec §1).
- No changes outside `app/` — no server, store, or schema edits (spec §1, §4).
- All commands run from `app/`: `bunx vitest run`, `bunx svelte-check --tsconfig ./tsconfig.json`, `bunx vite build`.
- Sleeping face is static — closed lids, no blink, no breathing animation (spec §1.2).
- Tests are pure-function tests in node env (no jsdom, no component mounting) per the existing codebase pattern.

---

### Task 1: Sleeping face — closed-eye pixels and the PixelFace `sleeping` prop

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `app/src/lib/faces.ts`
- Modify: `app/src/lib/faces.test.ts`
- Modify: `app/src/components/PixelFace.svelte`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `CLOSED_EYES: { left: Pixel[]; right: Pixel[] }` exported from the faces lib; `PixelFace` component prop `sleeping?: boolean` (default `false`).

- [ ] **Step 1: Write the failing tests**

Append to the `describe('faces', ...)` block in `app/src/lib/faces.test.ts` (add `CLOSED_EYES` to the existing import from `./faces`):

```ts
  test('CLOSED_EYES lids are single-row lines inside each eye span', () => {
    // Left eye occupies x 7-12, right eye x 19-23 (standard variant).
    for (const [x, y] of CLOSED_EYES.left) {
      expect(x).toBeGreaterThanOrEqual(7); expect(x).toBeLessThanOrEqual(12);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(32);
    }
    for (const [x, y] of CLOSED_EYES.right) {
      expect(x).toBeGreaterThanOrEqual(19); expect(x).toBeLessThanOrEqual(23);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(32);
    }
    // A lid is a closed line: exactly one distinct y per side.
    expect(new Set(CLOSED_EYES.left.map(([, y]) => y)).size).toBe(1);
    expect(new Set(CLOSED_EYES.right.map(([, y]) => y)).size).toBe(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && bunx vitest run src/lib/faces.test.ts`
Expected: FAIL — `CLOSED_EYES` is not exported.

- [ ] **Step 3: Implement `CLOSED_EYES` in `faces.ts`**

Add after the `EYE_VARIANTS` export:

```ts
// Closed lids for the sleeping face: a 1px line low in each eye's region
// (the right eye sits one row higher than the left, mirroring EYE_VARIANTS).
// Distinct from the blink state, which hides the eyes entirely — a sleeping
// face must read as asleep, not eyeless.
export const CLOSED_EYES: { left: Pixel[]; right: Pixel[] } = {
  left: [[7, 14], [8, 14], [9, 14], [10, 14], [11, 14], [12, 14]],
  right: [[19, 13], [20, 13], [21, 13], [22, 13], [23, 13]],
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && bunx vitest run src/lib/faces.test.ts`
Expected: PASS (all faces tests).

- [ ] **Step 5: Add the `sleeping` prop to `PixelFace.svelte`**

In `app/src/components/PixelFace.svelte`:

1. Extend the import: `import { CLOSED_EYES, EYE_VARIANTS, MOUTH_VARIANTS, ... } from '../lib/faces';`
2. Add to the props destructuring and its type:

```ts
    sleeping = false,
```
```ts
    sleeping?: boolean;
```

3. In `draw()`, replace the eye/mouth drawing lines with a sleeping branch (`sleeping` wins over `talking`, and a sleeping face never animates):

```ts
    if (sleeping) {
      drawPixels(ctx, CLOSED_EYES.left);
      drawPixels(ctx, CLOSED_EYES.right);
      drawPixels(ctx, mo.idle);
      anim = null;
      return;
    }
    if (!blinking) { drawPixels(ctx, eye.left); drawPixels(ctx, eye.right); }
    if (talking) drawPixels(ctx, Math.floor(Date.now() / 150) % 2 === 0 ? mo.talk1 : mo.talk2);
    else drawPixels(ctx, mo.idle);
    anim = talking || blinking ? requestAnimationFrame(draw) : null;
```

4. Suppress the blink scheduler while sleeping: wherever the component schedules/starts a blink (the random 2–5s timer), guard it with `if (sleeping) return;` so no blink begins while asleep, and add `void sleeping;` to the redraw `$effect`'s dependency list so a prop flip redraws immediately.

- [ ] **Step 6: Verify the component compiles**

Run: `cd app && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/faces.ts app/src/lib/faces.test.ts app/src/components/PixelFace.svelte
git commit -m "feat(app): sleeping pixel face with closed-lid eyes"
```

---

### Task 2: FaceHeader — say ASLEEP, sleep the face

**Type:** implementation
**Depends-on:** 1

**Files:**
- Modify: `app/src/components/FaceHeader.svelte`
- Create: `app/src/components/FaceHeader.test.ts`

**Interfaces:**
- Consumes: `PixelFace` prop `sleeping?: boolean` (from Task 1).
- Produces: `statusFor(sessionActive: boolean, processing: boolean): string` exported from the FaceHeader module script.

- [ ] **Step 1: Write the failing test**

Create `app/src/components/FaceHeader.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { statusFor } from './FaceHeader.svelte';

// Presence in Julian's own ontology: no session means asleep, not OFFLINE.
describe('statusFor', () => {
  test('no session → ASLEEP regardless of processing', () => {
    expect(statusFor(false, false)).toBe('ASLEEP');
    expect(statusFor(false, true)).toBe('ASLEEP');
  });
  test('active session, processing → PROCESSING...', () => {
    expect(statusFor(true, true)).toBe('PROCESSING...');
  });
  test('active session, idle → LISTENING', () => {
    expect(statusFor(true, false)).toBe('LISTENING');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && bunx vitest run src/components/FaceHeader.test.ts`
Expected: FAIL — `statusFor` is not exported.

- [ ] **Step 3: Implement in `FaceHeader.svelte`**

Add a module script above the existing instance script:

```svelte
<script module lang="ts">
  export function statusFor(sessionActive: boolean, processing: boolean): string {
    if (!sessionActive) return 'ASLEEP';
    return processing ? 'PROCESSING...' : 'LISTENING';
  }
</script>
```

In the instance script, replace the status derivation line with:

```ts
  const status = $derived(statusFor(sessionActive, processing));
```

In the markup, pass sleep state to the face:

```svelte
    <PixelFace talking={processing} sleeping={!sessionActive} size={56} />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && bunx vitest run src/components/FaceHeader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify the component compiles**

Run: `cd app && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/FaceHeader.svelte app/src/components/FaceHeader.test.ts
git commit -m "feat(app): FaceHeader reads ASLEEP and sleeps the pixel face"
```

---

### Task 3: ChatView — the asleep divider and the WAKE JULIAN button

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `app/src/components/ChatView.svelte`
- Create: `app/src/components/ChatView.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `presenceFor(sessionActive: boolean, messageCount: number): { divider: boolean; buttonLabel: string | null }` exported from the ChatView module script.

- [ ] **Step 1: Write the failing test**

Create `app/src/components/ChatView.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { presenceFor } from './ChatView.svelte';

// The transcript is the record and always renders; presence is a separate
// fact. presenceFor decides the asleep divider and the wake button.
describe('presenceFor', () => {
  test('asleep with messages → divider and WAKE JULIAN', () => {
    expect(presenceFor(false, 7)).toEqual({ divider: true, buttonLabel: 'WAKE JULIAN' });
  });
  test('asleep with empty store → button only, no divider', () => {
    expect(presenceFor(false, 0)).toEqual({ divider: false, buttonLabel: 'WAKE JULIAN' });
  });
  test('awake → neither divider nor button', () => {
    expect(presenceFor(true, 7)).toEqual({ divider: false, buttonLabel: null });
    expect(presenceFor(true, 0)).toEqual({ divider: false, buttonLabel: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && bunx vitest run src/components/ChatView.test.ts`
Expected: FAIL — `presenceFor` is not exported.

- [ ] **Step 3: Implement in `ChatView.svelte`**

Add a module script above the existing instance script:

```svelte
<script module lang="ts">
  export function presenceFor(
    sessionActive: boolean,
    messageCount: number,
  ): { divider: boolean; buttonLabel: string | null } {
    if (sessionActive) return { divider: false, buttonLabel: null };
    return { divider: messageCount > 0, buttonLabel: 'WAKE JULIAN' };
  }
</script>
```

In the instance script, derive presence:

```ts
  const presence = $derived(presenceFor(sessionActive, messages.ids.length));
```

In the markup, add the divider inside the scroller, after the `{#if processing}` block and before the closing `</div>` of `.messages`:

```svelte
      {#if presence.divider}
        <div class="asleep-divider">— julian is asleep · the conversation above is remembered, not live —</div>
      {/if}
```

Replace the footer's start button label (handler and boot SFX unchanged):

```svelte
        <button class="start" onclick={onStart}>{presence.buttonLabel}</button>
```

Add quiet CRT-idiom styling to the component's `<style>` block:

```css
  .asleep-divider {
    text-align: center;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--j-gray-555);
    padding: 14px 8px 6px;
    user-select: none;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && bunx vitest run src/components/ChatView.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify the component compiles**

Run: `cd app && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/ChatView.svelte app/src/components/ChatView.test.ts
git commit -m "feat(app): asleep divider and WAKE JULIAN button"
```

---

### Task 4: Full app verification gate

**Type:** gate
**Depends-on:** 1, 2, 3

All from `app/` on the integrated tree:

- `bunx svelte-check --tsconfig ./tsconfig.json` — 0 errors.
- `bunx vitest run` — all suites green (existing 29 + the new faces/FaceHeader/ChatView tests).
- `bunx vite build` — dist builds clean.
