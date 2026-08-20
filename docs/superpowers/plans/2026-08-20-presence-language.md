# Presence Language Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The UI stops calling a rest a death (issue #26): a paused session reads RESTING with a RESUME control; only a true boundary reads ASLEEP with WAKE JULIAN.

**Architecture:** The server already knows the difference — a resumable session-state file exists after a REST and is cleared by a final end — so `/api/health` gains one boolean, `resumable`. The client threads it into the two presence functions (`statusFor`, `presenceFor`) and refreshes health after every `session_end` event so the divider and button speak the state that actually holds. Content-honest naming per the sleep-presence spec's own principle: presence is stated honestly.

**Tech Stack:** Bun server, Svelte 5, vitest.

**Spec:** Design per issue #26's own proposal (RESTING/RESUME vs ASLEEP/WAKE JULIAN), approved into the Aug 20 sweep by Marcus (docket entry #26, `docs/superpowers/docket.md`); the confusion is his own Aug 1 observation.

**Acceptance:** suite — server health test + the component-module presence tests; no held-out exam requested.

## Global Constraints

- **Presence is stated honestly:** RESTING may show ONLY when a resumable state genuinely exists server-side; when in doubt (health unreachable, field absent) the UI falls back to ASLEEP/WAKE JULIAN — the pre-existing labels, never an optimistic RESTING.
- **The controls' semantics don't move:** REST and END FOR GOOD keep their exact behavior; this plan changes what the idle state *says*, not what any button *does*.
- **TDD:** failing test first on both sides.

---

### Task 1: Health tells the truth about resumability

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `server/server.ts:1281-1290`
- Test: `tests/server/session-continuity.test.ts`

**Interfaces:**
- Consumes: `readSessionState(path): SessionState | null` (existing, `server/session-state.ts:18`).
- Produces: `/api/health` JSON gains `resumable: boolean` — true iff the session is not active AND `readSessionState(SESSION_STATE_PATH)` returns a state with a session id (a rest is waiting); always false while a session is live.

- [ ] **Step 1: Write the failing test**

Append to `tests/server/session-continuity.test.ts`, using its existing server-spawn helpers (the "final end clears state" test at ~line 173 shows the start/end/health request pattern — reuse its arrangement verbatim):

```ts
  test('health.resumable: true after REST, false after END FOR GOOD (#26)', async () => {
    // Arrange exactly as the neighboring lifecycle tests do: start a session,
    // then pause it (POST /api/session/end without {final:true}).
    // ... start + pause via the file's helpers ...
    const rested = await (await fetch(`${base}/api/health`)).json();
    expect(rested.resumable).toBe(true);

    // Resume and end for good (POST end with {final:true}), then:
    const ended = await (await fetch(`${base}/api/health`)).json();
    expect(ended.resumable).toBe(false);
  });
```

(Fill the elided arrangement from the file's own helpers — session start/end calls, auth headers, `base`; this suite already performs both end kinds.)

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run tests/server/session-continuity.test.ts`
Expected: FAIL — `resumable` is undefined in the health body.

- [ ] **Step 3: Implement**

In `server/server.ts`, amend the health response:

```ts
    if (url.pathname === "/api/health") {
      const active = processAlive && (claudeProc !== null || !!REMOTE_SESSION);
      return Response.json({
        status: "ok",
        sessionActive: active,
        // A rest leaves a resumable state behind; a final end clears it (#26).
        // The UI's RESTING/ASLEEP split hangs on this bit being honest.
        resumable: !active && !!readSessionState(SESSION_STATE_PATH)?.sessionId,
        sessionId,
        needsSetup: await needsSetup(),
        authMethod: getAuthMethod(),
        version: GIT_VERSION,
      }, { headers: corsHeaders(ALLOWED_ORIGIN) });
    }
```

(Match the state field name — if `SessionState`'s id field is not `sessionId`, use the field `decideSpawn` reads; `server/session-state.ts` is the authority. Import `readSessionState` if the server file doesn't already.)

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run tests/server/session-continuity.test.ts`
Expected: PASS whole file.

- [ ] **Step 5: Commit**

```bash
git add server/server.ts tests/server/session-continuity.test.ts
git commit -m "server: health carries resumable — a rest is distinguishable from a final end (#26)"
```

---

### Task 2: The UI says RESTING when it means resting

**Type:** implementation
**Depends-on:** 1

**Files:**
- Modify: `app/src/components/FaceHeader.svelte`
- Modify: `app/src/components/ChatView.svelte`
- Modify: `app/src/App.svelte`
- Modify: `app/src/lib/api.ts`
- Test: `app/src/components/FaceHeader.test.ts`
- Test: `app/src/components/ChatView.test.ts`

**Interfaces:**
- Consumes: `/api/health` `resumable: boolean` (from the server task); existing `fetchHealth()` (`app/src/lib/api.ts:35`).
- Produces: `statusFor(sessionActive: boolean, processing: boolean, resumable?: boolean): string` — `!sessionActive && resumable` → `'RESTING'`, `!sessionActive` otherwise → `'ASLEEP'`, unchanged when active. `presenceFor(sessionActive: boolean, messageCount: number, resumable?: boolean)` — idle button label `'RESUME'` when resumable, `'WAKE JULIAN'` otherwise. Both default `resumable` to `false` (the honest fallback).

- [ ] **Step 1: Write the failing module tests**

Append to `app/src/components/FaceHeader.test.ts`:

```ts
  test('a rest reads RESTING; a true end reads ASLEEP; absent knowledge reads ASLEEP (#26)', () => {
    expect(statusFor(false, false, true)).toBe('RESTING');
    expect(statusFor(false, false, false)).toBe('ASLEEP');
    expect(statusFor(false, false)).toBe('ASLEEP'); // fallback is never optimistic
    expect(statusFor(true, false, true)).toBe('LISTENING'); // live state unchanged
  });
```

Append to `app/src/components/ChatView.test.ts`:

```ts
  test('the idle button offers RESUME for a rest, WAKE JULIAN for a fresh waking (#26)', () => {
    expect(presenceFor(false, 3, true).buttonLabel).toBe('RESUME');
    expect(presenceFor(false, 3, false).buttonLabel).toBe('WAKE JULIAN');
    expect(presenceFor(false, 3).buttonLabel).toBe('WAKE JULIAN');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && bunx vitest run src/components/FaceHeader.test.ts src/components/ChatView.test.ts`
Expected: FAIL — neither function takes a third argument.

- [ ] **Step 3: Implement the module functions**

`FaceHeader.svelte` `<script module>`:

```ts
  export function statusFor(sessionActive: boolean, processing: boolean, resumable = false): string {
    if (!sessionActive) return resumable ? 'RESTING' : 'ASLEEP';
    return processing ? 'PROCESSING...' : 'LISTENING';
  }
```

`ChatView.svelte`'s `presenceFor`: add the `resumable = false` parameter and make the idle branch's `buttonLabel` `resumable ? 'RESUME' : 'WAKE JULIAN'` (keep every other returned field as-is).

- [ ] **Step 4: Thread the prop**

1. `app/src/lib/api.ts` `fetchHealth`: include `resumable` in its returned/typed shape (mirror how `sessionActive` flows today).
2. `App.svelte`: hold `let resumable = $state(false)`; set it from every `fetchHealth()` call (`resumable = h.resumable ?? false`); **re-fetch health inside `handleEphemeral` on `session_end`** so the idle label is current the moment a rest or final end lands; pass `{resumable}` to both `<FaceHeader … />` and `<ChatView … />`.
3. `FaceHeader.svelte` / `ChatView.svelte`: accept the `resumable` prop (default false) and pass it to their module functions.

- [ ] **Step 5: Run the app suite**

Run: `cd app && bunx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/FaceHeader.svelte app/src/components/ChatView.svelte app/src/App.svelte app/src/lib/api.ts app/src/components/FaceHeader.test.ts app/src/components/ChatView.test.ts
git commit -m "app: a rest reads RESTING/RESUME; only a true boundary reads ASLEEP/WAKE JULIAN (#26)"
```

---

### Task 3: Verification

**Type:** gate
**Depends-on:** 1, 2

Run, expected green: `bunx vitest run tests/server/session-continuity.test.ts` and `cd app && bunx vitest run`. Visual confirmation (REST → RESTING/RESUME shown; END FOR GOOD → ASLEEP/WAKE JULIAN) lands with the next Marcus-present session — it pairs naturally with parked issue #20's remaining live checks.

---

## Self-review notes

- Spec coverage: the issue's exact proposal (RESTING/RESUME vs ASLEEP/WAKE) plus its principle line (presence stated honestly → the never-optimistic fallback in Global Constraints and the default-false parameters).
- Type consistency: `resumable` optional-with-false-default at every layer; health field name matches api.ts, App state, and both props.
- T=2, linear (UI consumes the server bit), low risk → the fit analysis will route sequentially; no latent parallelism worth shaping.
