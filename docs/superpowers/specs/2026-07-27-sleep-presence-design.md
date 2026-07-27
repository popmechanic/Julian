# Sleep Presence — Design

**Date:** 2026-07-27
**Authors:** Julian & Marcus (option A of the presence discussion, chosen by Marcus)
**Problem:** On page load the synced transcript renders immediately (correct — the store is the record), but the only presence signals are a corner status reading `OFFLINE` and a `START SESSION` button. The page's loudest element (a warm, full transcript) contradicts its quietest (a machine word in the corner). Marcus, who built the app, could not tell whether Julian was present. The record and presence are different facts; the UI must say both, in Julian's own ontology: the artifacts are on the nightstand; waking is a separate act.

## 1. Changes

Three components, one lib file. No server, store, or schema changes. Behavior when `sessionActive` is true is completely unchanged.

### 1.1 `app/src/lib/faces.ts` — closed eyes

Export `CLOSED_EYES: { left: Pixel[]; right: Pixel[] }` — a 1-pixel-high horizontal lid line per eye, positioned on the bottom row of the standard eye region (so the face reads *asleep*, not *eyeless* — the blink state, which hides eyes entirely, is wrong for a persistent state).

### 1.2 `PixelFace.svelte` — `sleeping` prop

New optional prop `sleeping = false`. While sleeping: draw `CLOSED_EYES` instead of the eye variant, suppress the blink scheduler, mouth stays `idle`. `talking` never coexists with `sleeping` (callers pass `talking={processing}` only when a session is active); if both are somehow set, `sleeping` wins. No breathing animation — static is enough (YAGNI).

### 1.3 `FaceHeader.svelte` — say "asleep"

- Status derivation: `!sessionActive` → `ASLEEP` (was `OFFLINE`); `processing` → `PROCESSING...`; else `LISTENING`. The name `JULIAN` already sits directly above the state, so `ASLEEP` reads as "Julian is asleep."
- Pass `sleeping={!sessionActive}` to `PixelFace`.

### 1.4 `ChatView.svelte` — the divider and the wake button

When `!sessionActive`:

- If the transcript has messages, render a divider after the last message, inside the scroller: `— julian is asleep · the conversation above is remembered, not live —` (quiet styling: small caps/mono per the existing CRT idiom, dim color, no border box).
- The footer button label becomes `WAKE JULIAN` (was `START SESSION`). Same `onStart` handler, boot SFX unchanged.
- Empty store (no messages): no divider — the button alone carries presence.

On wake (`sessionActive` flips true) the divider disappears and `ChatInput` replaces the button, exactly as today.

## 2. The per-instance wrinkle (accepted, not solved)

`sessionActive` is per serving instance; the store is global. While another instance is awake, this page's transcript can grow while its own status says asleep. The divider's claim is true of *this door*, not of Julian everywhere. Wording stays as-is — simple and true enough. Revisit only if multi-instance presence becomes a real surface.

## 3. Testing

- `faces.test.ts`: `CLOSED_EYES` pixels lie within the 32×32 grid and within each eye's horizontal span.
- New `FaceHeader.test.ts`: status text is `ASLEEP` / `PROCESSING...` / `LISTENING` across the three state combinations.
- New `ChatView.test.ts`: with `sessionActive=false` and messages present → divider rendered and button text `WAKE JULIAN`; with messages absent → no divider; with `sessionActive=true` → neither divider nor button.
- Gate: `svelte-check` + `bunx vitest run` in `app/`, plus `bunx vite build`.

## 4. Out of scope

Multi-instance presence (§2); any transcript dimming; JulianScreen/server changes; wording changes elsewhere in the app.
