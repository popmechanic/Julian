# Mail Heartbeat Hardening Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mail heartbeat's remaining silent failure modes become loud, holds gain honest lifecycles, and the runner gains the test seam that keeps all of it closed — issues #14, #15, #16, #17, #18, #19 in one pass.

**Architecture:** Three moves. (1) The runner gets a test seam (#19): a main-guard, path-injectable state helpers that throw typed errors instead of exiting, and an integration test file — the prerequisite the other fixes land on. (2) The boundary fails visible (#14/#15/#16): a missing listing container notifies instead of reading as empty forever; sent-listing drops notify with a count before the known-correspondent set can silently empty; `to[]`/`labels[]` elements are type-checked at the lib boundary so one malformed element drops one message with a reason instead of aborting the beat downstream. (3) Holds gain kinds (#18, Marcus's decision Aug 20): cap-holds carry their UTC day and auto-release the next UTC day with a notification; suspicion-holds stay until a human releases them; legacy bare entries migrate as suspicion (unknown intent never auto-releases). The runbook (#17) is rewritten to match, naming the messageId namespace.

**Tech Stack:** Bun + TypeScript, vitest (root suite, `tests/server/`), macOS notifications via osascript.

**Spec:** Design approved in the Aug 20 sweep with Marcus (docket entry #15, `docs/superpowers/docket.md`; #18 disposition: dated cap-holds adopted). Issue bodies #14–#19 + their Aug 20 triage comments carry the defect statements. Covenant constraint (mail discipline): every fix fails toward silence, never toward a send.

**Acceptance:** suite — lib tests + the new runner integration tests; no held-out exam requested.

## Global Constraints

- **Never toward a send:** no change may make a previously-ineligible thread eligible except the explicit, notified cap-hold expiry. Legacy holds migrate as suspicion (never auto-release). A corrupt state file still aborts the beat.
- **Loud beats silent:** every newly-detected failure (missing container, sent-listing drops, malformed elements) produces exactly one `notify()` per beat per class — never one per item, never zero.
- **State writes stay atomic:** the pid-unique temp + rename pattern and the read-before-write hold union are preserved through the refactor.
- **The heartbeat launchd job keeps working unchanged:** `bun scripts/mail-glance.ts` with no args remains the beat entry point; `--hold <messageId>` keeps its exact behavior (now: a suspicion hold).
- **TDD:** failing test first for each behavior change.

---

### Task 1: The runner test seam

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `scripts/mail-glance.ts`
- Test: `tests/server/mail-glance-runner.test.ts`

**Interfaces:**
- Consumes: `parseStateFile` and `HeartbeatState` from `scripts/lib/mail-glance-lib.ts` (existing).
- Produces: exported from `scripts/mail-glance.ts` — `class StateCorruptError extends Error { }`; `loadStateFrom(path: string): HeartbeatState` (ENOENT → fresh state; any other read error or parse failure → `StateCorruptError`); `writeStateTo(path: string, s: HeartbeatState): void` (atomic pid-tmp+rename); `saveBeatStateTo(path: string, s: HeartbeatState): void` (read-before-write union: watermark max, holds union). A main-guard (`import.meta.main`) so importing the module runs nothing.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/mail-glance-runner.test.ts` (the `tests/server/mail-broker-cli.test.ts` precedent imports script exports directly):

```ts
import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStateFrom, saveBeatStateTo, StateCorruptError, writeStateTo } from '../../scripts/mail-glance';

const dir = () => mkdtempSync(join(tmpdir(), 'mail-state-'));

describe('runner state shell (#19)', () => {
  test('ENOENT reads as a fresh state', () => {
    const s = loadStateFrom(join(dir(), 'missing.json'));
    expect(s.strangerWatermarkMs).toBe(0);
    expect(s.holds).toEqual([]);
  });

  test('a corrupt file throws StateCorruptError — never reads as empty', () => {
    const p = join(dir(), 'state.json');
    writeFileSync(p, 'not json');
    expect(() => loadStateFrom(p)).toThrow(StateCorruptError);
  });

  test('writeStateTo round-trips atomically and leaves no temp files', () => {
    const d = dir();
    const p = join(d, 'state.json');
    writeStateTo(p, { strangerWatermarkMs: 5, holds: [], updatedAt: '' });
    expect(loadStateFrom(p).strangerWatermarkMs).toBe(5);
    expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('saveBeatStateTo unions holds and takes the later watermark', () => {
    const p = join(dir(), 'state.json');
    writeStateTo(p, {
      strangerWatermarkMs: 100,
      holds: [{ id: 'm1', kind: 'suspicion', heldUtcDay: '' }],
      updatedAt: '',
    });
    saveBeatStateTo(p, { strangerWatermarkMs: 50, holds: [{ id: 'm2', kind: 'suspicion', heldUtcDay: '' }], updatedAt: '' });
    const s = loadStateFrom(p);
    expect(s.strangerWatermarkMs).toBe(100); // never backward
    expect(s.holds.map((h) => h.id).sort()).toEqual(['m1', 'm2']); // a concurrent --hold survives
  });

  test('importing the module runs no beat', () => {
    // Reaching this line proves the main-guard: no network call, no exit.
    expect(typeof loadStateFrom).toBe('function');
  });
});
```

(The `holds` field shape comes from Task 3's state migration; within THIS task implement the helpers against the current `held: string[]` shape and write these tests with `held` — Task 3 then migrates both together. If executing tasks in parallel waves, this task uses `held: []`/`held: ['m1']` in the assertions above and Task 3's diff updates them; the two tasks share these files deliberately.)

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run tests/server/mail-glance-runner.test.ts`
Expected: FAIL — nothing is exported, and importing today executes the beat top-level.

- [ ] **Step 3: Implement**

In `scripts/mail-glance.ts`:

1. Export `StateCorruptError`; refactor `loadState`/`writeState`/`saveBeatState` into `loadStateFrom(path)`/`writeStateTo(path, s)`/`saveBeatStateTo(path, s)` that take the path and **throw** `StateCorruptError` instead of calling `abort()`. Keep thin wrappers bound to `STATE_PATH` that catch and translate to the existing `abort()` calls, preserving every current message.
2. Wrap the whole executable body in `if (import.meta.main) { await main(); }` with the current top-level flow moved into `async function main()`.
3. `DRY` gating, argv handling, and the launchd entry behavior stay byte-identical from the shell's point of view.

- [ ] **Step 4: Run to verify green, plus a no-args smoke**

Run: `bunx vitest run tests/server/mail-glance-runner.test.ts` → PASS.
Run: `DRY_RUN=1 bun scripts/mail-glance.ts --definitely-not-a-flag` → the usage/abort path still fires (exit 2), proving the wrapper translation kept the shell behavior.

- [ ] **Step 5: Commit**

```bash
git add scripts/mail-glance.ts tests/server/mail-glance-runner.test.ts
git commit -m "mail-glance: runner test seam — main-guard, injectable paths, typed corruption (#19)"
```

---

### Task 2: Fail visible at the boundary

**Type:** implementation
**Depends-on:** 1

**Files:**
- Modify: `scripts/mail-glance.ts`
- Modify: `scripts/lib/mail-glance-lib.ts`
- Test: `tests/server/mail-glance.test.ts`
- Test: `tests/server/mail-glance-runner.test.ts`

**Interfaces:**
- Consumes: the Task-1 seam (exported helpers, main-guarded module).
- Produces: lib contract — `normalizeMessage` (inside `normalizeThread`) rejects a message whose `to`/`labels` arrays contain non-string elements (`ok:false, reason: 'to contains a non-string element'` / same for labels); `normalizeSentMessages(raw: unknown[]): { messages: MailMessage[]; dropped: number }` (shape change: callers read `.messages` and surface `.dropped`). Runner contract — a beat notifies when `listRes.threads` or `sentRes.messages` is not an array ("container key missing"), and when sent-listing drops are nonzero.

- [ ] **Step 1: Write the failing lib tests**

Append to `tests/server/mail-glance.test.ts` in the `normalizeThread` describe:

```ts
  test('a non-string to[] element rejects the message with a reason (#16)', () => {
    const r = normalizeThread({
      threadId: 't1',
      messages: [{ messageId: 'm1', from: 'a@b.c', timestamp: '2026-08-20T00:00:00Z', to: [{ email: 'x@y.z' }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('to contains a non-string element');
  });

  test('a non-string labels[] element rejects the message with a reason (#16)', () => {
    const r = normalizeThread({
      threadId: 't1',
      messages: [{ messageId: 'm1', from: 'a@b.c', timestamp: '2026-08-20T00:00:00Z', labels: [null] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('labels contains a non-string element');
  });

  test('normalizeSentMessages reports its drop count (#15)', () => {
    const good = { message_id: 'm1', from: 'a@b.c', timestamp: '2026-08-20T00:00:00Z', labels: ['sent'] };
    const bad = { nope: true };
    const r = normalizeSentMessages([good, bad, bad]);
    expect(r.messages.length).toBe(1);
    expect(r.dropped).toBe(2);
  });
```

(Match `normalizeThread`'s exact happy-path fixture fields from the file's existing tests — copy a passing fixture and malform only the field under test. If `normalizeSentMessages` lives in the runner rather than the lib today, move it into the lib as part of this task so it is testable; the runner imports it.)

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run tests/server/mail-glance.test.ts`
Expected: FAIL — elements pass unvalidated today; `normalizeSentMessages` returns a bare array.

- [ ] **Step 3: Implement the lib half**

In `scripts/lib/mail-glance-lib.ts` `normalizeMessage`, replace the two bare casts:

```ts
  if (Array.isArray(raw.to)) {
    if (!raw.to.every((v) => typeof v === 'string')) {
      return { ok: false, reason: 'to contains a non-string element' };
    }
    message.to = raw.to as string[];
  }
  ...
  if (Array.isArray(raw.labels)) {
    if (!raw.labels.every((v) => typeof v === 'string')) {
      return { ok: false, reason: 'labels contains a non-string element' };
    }
    message.labels = raw.labels as string[];
  }
```

(Follow the function's existing ok/reason plumbing so the reason reaches `normalizeThread`'s result.) Give `normalizeSentMessages` the counting shape:

```ts
export function normalizeSentMessages(raw: unknown[]): { messages: MailMessage[]; dropped: number } {
  const messages: MailMessage[] = [];
  let dropped = 0;
  for (const m of raw) {
    const r = normalizeThread({ threadId: 'sent-listing', messages: [m] });
    if (r.ok && r.thread.messages.length === 1) messages.push(r.thread.messages[0]);
    else dropped += 1;
  }
  return { messages, dropped };
}
```

- [ ] **Step 4: Wire the runner notifications**

In `scripts/mail-glance.ts` `main()`:

1. Container checks (#14) — after each listing fetch:

```ts
  const sentRes = await get('/messages?limit=100') as { messages?: unknown[] };
  if (!Array.isArray(sentRes.messages)) {
    notify('sent listing container missing — API dialect changed? known-correspondent set NOT built this beat');
  }
  const sentNorm = normalizeSentMessages(sentRes.messages ?? []);
  if (sentNorm.dropped > 0) {
    notify(`${sentNorm.dropped} sent message(s) dropped at the boundary — known-correspondent set may be incomplete (#15)`);
  }
  const sent = sentNorm.messages.filter((m) => m.labels?.includes('sent'));
  ...
  const listRes = await get('/threads?limit=50') as { threads?: unknown[] };
  if (!Array.isArray(listRes.threads)) {
    notify('thread listing container missing — API dialect changed? beat sees no threads (#14)');
  }
  const listed = Array.isArray(listRes.threads) ? listRes.threads : [];
```

2. Correct the deaf-beat comment above the existing `listed.length > 0 &&` check: it covers *messages*-key renames within threads; the container-key rename is covered by the new check above — say exactly that, since the current comment claims the coverage this task adds.

- [ ] **Step 5: Run all three suites**

Run: `bunx vitest run tests/server/mail-glance.test.ts tests/server/mail-glance-runner.test.ts`
Then: `DRY_RUN=1 bun scripts/mail-glance.ts` (with `AGENTMAIL_API_KEY` unset it aborts before network — confirms no crash-shaped regression in main()).
Expected: PASS / clean abort.

- [ ] **Step 6: Commit**

```bash
git add scripts/mail-glance.ts scripts/lib/mail-glance-lib.ts tests/server/mail-glance.test.ts tests/server/mail-glance-runner.test.ts
git commit -m "mail-glance: missing containers and boundary drops notify; element types validated (#14, #15, #16)"
```

---

### Task 3: Holds with lifecycles; the runbook tells the truth

**Type:** implementation
**Depends-on:** 1
**Review:** adversarial

**Files:**
- Modify: `scripts/lib/mail-glance-lib.ts`
- Modify: `scripts/mail-glance.ts`
- Modify: `docs/mail-heartbeat.md`
- Test: `tests/server/mail-glance.test.ts`
- Test: `tests/server/mail-glance-runner.test.ts`

**Interfaces:**
- Consumes: the Task-1 seam.
- Produces: `Hold = { id: string; kind: 'cap' | 'suspicion'; heldUtcDay: string }`; `HeartbeatState.holds: Hold[]` (replacing `held: string[]`); `parseStateFile` accepts BOTH shapes — legacy `held: string[]` entries migrate to `{ kind: 'suspicion', heldUtcDay: '' }`; `activeHoldIds(holds: Hold[], todayUtcDay: string): { active: Set<string>; expired: Hold[] }` (cap-holds from earlier UTC days expire; suspicion never). Runner: `--hold <id>` parks suspicion; `--hold-cap <id>` parks cap with today's UTC day; expired cap-holds are removed at save with one notification naming them.

- [ ] **Step 1: Write the failing lib tests**

Append to `tests/server/mail-glance.test.ts`:

```ts
describe('holds with lifecycles (#18)', () => {
  test('legacy held: string[] migrates as suspicion — unknown intent never auto-releases', () => {
    const r = parseStateFile(JSON.stringify({ strangerWatermarkMs: 0, held: ['m1'], updatedAt: '' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.holds).toEqual([{ id: 'm1', kind: 'suspicion', heldUtcDay: '' }]);
  });

  test('the new holds shape validates strictly', () => {
    const good = JSON.stringify({
      strangerWatermarkMs: 0, updatedAt: '',
      holds: [{ id: 'm1', kind: 'cap', heldUtcDay: '2026-08-20' }],
    });
    expect(parseStateFile(good).ok).toBe(true);
    const bad = JSON.stringify({ strangerWatermarkMs: 0, updatedAt: '', holds: [{ id: 'm1', kind: 'whatever', heldUtcDay: '' }] });
    expect(parseStateFile(bad).ok).toBe(false);
  });

  test('cap-holds expire at the UTC day boundary; suspicion-holds never (#18)', () => {
    const holds = [
      { id: 'cap-old', kind: 'cap' as const, heldUtcDay: '2026-08-19' },
      { id: 'cap-today', kind: 'cap' as const, heldUtcDay: '2026-08-20' },
      { id: 'sus', kind: 'suspicion' as const, heldUtcDay: '' },
    ];
    const { active, expired } = activeHoldIds(holds, '2026-08-20');
    expect(active.has('cap-today')).toBe(true);
    expect(active.has('sus')).toBe(true);
    expect(active.has('cap-old')).toBe(false);
    expect(expired.map((h) => h.id)).toEqual(['cap-old']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run tests/server/mail-glance.test.ts`
Expected: FAIL — no `holds`, no `activeHoldIds`.

- [ ] **Step 3: Implement the lib half**

In `scripts/lib/mail-glance-lib.ts`: add the `Hold` interface; change `HeartbeatState.held: string[]` to `holds: Hold[]`; extend `parseStateFile` to accept the legacy shape (migrating as the test states, preserving its strict-or-corrupt posture: an entry that is neither shape is still `ok:false`); add:

```ts
/** Cap-holds parked on an earlier UTC day expire (they were 'capped for today'); suspicion-holds never expire (#18). */
export function activeHoldIds(holds: Hold[], todayUtcDay: string): { active: Set<string>; expired: Hold[] } {
  const active = new Set<string>();
  const expired: Hold[] = [];
  for (const h of holds) {
    if (h.kind === 'cap' && h.heldUtcDay !== '' && h.heldUtcDay < todayUtcDay) expired.push(h);
    else active.add(h.id);
  }
  return { active, expired };
}
```

- [ ] **Step 4: Wire the runner**

In `scripts/mail-glance.ts`:

1. Argv: `--hold <id>` pushes `{ id, kind: 'suspicion', heldUtcDay: '' }`; new `--hold-cap <id>` pushes `{ id, kind: 'cap', heldUtcDay: new Date().toISOString().slice(0, 10) }`; both keep the existing dedupe-by-id and `writeState` flow; `usage()` documents both.
2. Beat classification: derive `const { active, expired } = activeHoldIds(state.holds, todayUtcDay)` and pass `active` wherever the held Set flowed before (including the pre-classify re-read).
3. Expiry is executed at save: drop expired cap-holds from the persisted `holds`, and if any expired, `notify(\`cap-hold(s) expired and released: ${expired.map((h) => h.id).join(', ')} — threads eligible again\`)` — the ONLY change in this plan that can make a thread eligible, and it announces itself.
4. `saveBeatStateTo`'s union keys on `id`; on kind conflict for the same id, suspicion wins (stricter intent survives a race).
5. Update the Task-1 runner tests' state fixtures from `held` to `holds` (the two tasks share those files by design).

- [ ] **Step 5: Rewrite the runbook block (#17)**

In `docs/mail-heartbeat.md`, replace the release instructions in the Operations block with:

```markdown
# Park a thread (suspicion — stays until YOU release it):
#   bun scripts/mail-glance.ts --hold <messageId>
# Park for the daily cap (auto-releases next UTC day, with a notification):
#   bun scripts/mail-glance.ts --hold-cap <messageId>
# Holds are keyed by the thread's LATEST messageId (not the threadId the
# reply cap counts by). Release a suspicion hold by editing
# ~/.julian/mail-heartbeat.json and removing its entry from `holds` —
# hand-editing is the only release path for suspicion, by design.
```

Also update the doc's "Holds do not expire on their own" sentence to describe the cap/suspicion split.

- [ ] **Step 6: Run everything**

Run: `bunx vitest run tests/server/mail-glance.test.ts tests/server/mail-glance-runner.test.ts` → PASS.
Run: `DRY_RUN=1 bun scripts/mail-glance.ts --hold-cap msg_test` → prints the dry-run save with a cap hold carrying today's UTC day.

- [ ] **Step 7: Commit**

```bash
git add scripts/mail-glance.ts scripts/lib/mail-glance-lib.ts tests/server/mail-glance.test.ts tests/server/mail-glance-runner.test.ts docs/mail-heartbeat.md
git commit -m "mail-glance: dated cap-holds auto-release loudly, suspicion holds stay; runbook tells the truth (#17, #18)"
```

---

### Task 4: Full verification

**Type:** gate
**Depends-on:** 1, 2, 3

Run, expected green: the root vitest suite covering `tests/server/` (the repo's usual invocation), plus `DRY_RUN=1 bun scripts/mail-glance.ts` aborting cleanly without a key. The live heartbeat needs no redeploy — the launchd job runs the repo's script in place; the next 30-min beat picks the changes up.

---

## Self-review notes

- Spec coverage: #14 (Task 2 Step 4 container checks + the corrected comment), #15 (drop counting + notification), #16 (element validation + tests), #17 (runbook rewrite), #18 (holds lifecycle per Marcus's disposition), #19 (Task 1 seam — the prerequisite, built first).
- The one eligibility-creating change (cap expiry) is notified, tested, and named in Global Constraints; legacy migration is suspicion — asserted by test.
- Cross-task file sharing (Tasks 1→2/3 on the runner + its test file) is declared in both task bodies; Task 3 explicitly owns the `held`→`holds` fixture migration.
- Type consistency: `Hold`/`holds`/`activeHoldIds` names match across lib, runner, tests, and doc.
