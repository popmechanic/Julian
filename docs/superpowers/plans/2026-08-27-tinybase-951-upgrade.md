# TinyBase 9.5.1 Upgrade Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align every workspace to tinybase `^9.5.1` (curing the U+2028/U+2029-eating fragmenter), pin the cure with a regression test, close the last on-faith sync path (#12 offline-compose→reconnect), and give the sync DO visibility into malformed-traffic disconnects via `onIgnoredError`.

**Architecture:** A single aligned version bump across five `package.json` files, verified by the regression net that already exists (the #53 middleware repro, the #48 codec suite, the export integration test, all suites), plus three additive pieces: a fragmenter regression test and a reconnect-convergence test (both using the loopback `createWsServer` pattern already proven in `scripts/fireproof-write.test.ts`), an offline-compose persistence test in the app (using the existing `memHandle` fake), and a class-only-logging `onIgnoredError` override on `JulianSyncDO`.

**Tech Stack:** TinyBase 9.5.1 (MergeableStore, ws synchronizers, DO SQLite persister), Bun workspaces, vitest (+ workerd pool for sync), bun:test (scripts, root), ws (loopback servers in tests).

**Spec:** No spec file — bounded work approved in-chat 2026-08-27 (Marcus). The evidence base is `docs/research/2026-08-27-tinybase-9.2-to-9.5.md` (release-span research, empirically verified; §8 is the bump checklist this plan implements). Issues: #44 (the bump), #12 (reconnect rider), #52/#53 context (the middleware hazard is NOT fixed in 9.5.1 — the lazy-guards architecture must survive intact).

**Acceptance:** suite — the committed suites plus the three new tests are the verification; the DO's on-disk layout is byte-identical between versions (research §5), so no migration machinery exists to examine.

## Global Constraints

- Every workspace that depends on tinybase pins `"tinybase": "^9.5.1"`: root, `app/`, `shared/`, `sync/`, `scripts/` — and every lockfile resolves to one single version ≥ 9.5.1. No workspace may remain on 9.2.x/9.3.x.
- Never downgrade tinybase below 9 — the DO SQLite `fragmented` layout is breaking below 9 (standing warning in `sync/src/do.ts:createPersister`).
- The lazy-guards architecture in `sync/src/do.ts` is load-bearing and must not be reordered: the store stays UNWRAPPED by middleware through construction, persister load, and restore; `ensureGuards()` wraps only at the first live-merge surface. 9.5.1 still reproduces the #53 stamp-flattening hazard (research §3) — `sync/test/restore.test.ts` must stay green unmodified.
- Logs and ledger rows carry error CLASSES only (e.g. `SyntaxError`), never message content, payload text, tokens, or record content — the standing ledger discipline.
- `FRAGMENT_SIZE` stays `262144` on both client (`app/src/lib/store.ts`) and DO (`sync/src/do.ts`); in 9.5.1 it counts wire bytes (research §2), which is the intended meaning.
- Tests must be concurrency-safe: every loopback WebSocketServer binds `port: 0` (OS-assigned); no shared on-disk fixtures.

---

### Task 1: The aligned bump — five pins to ^9.5.1, resolved and proven

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `package.json`
- Modify: `app/package.json`
- Modify: `shared/package.json`
- Modify: `sync/package.json`
- Modify: `scripts/package.json`
- Modify: `bun.lock`
- Modify: `app/bun.lock`
- Modify: `shared/bun.lock`
- Modify: `sync/bun.lock`
- Modify: `scripts/bun.lock`

**Interfaces:**
- Consumes: nothing
- Produces: a tree where `tinybase` resolves to exactly one installed version ≥ 9.5.1 in every workspace — the precondition every other task's `Depends-on: 1` encodes

- [ ] **Step 1: Edit the five pins**

In each of the five `package.json` files listed above, change the tinybase entry to exactly:

```json
"tinybase": "^9.5.1"
```

No other dependency changes.

- [ ] **Step 2: Regenerate installs**

Run, from the repo root (each workspace installs its own nested copy):

```bash
bun install
(cd app && bun install)
(cd shared && bun install)
(cd sync && bun install)
(cd scripts && bun install)
```

- [ ] **Step 3: Prove single-version resolution**

```bash
grep -rh '"version"' node_modules/tinybase/package.json app/node_modules/tinybase/package.json shared/node_modules/tinybase/package.json sync/node_modules/tinybase/package.json scripts/node_modules/tinybase/package.json 2>/dev/null | sort -u
```

Expected: exactly one line, version `9.5.1` (or a later 9.5.x). A missing path means that workspace deduped to a parent copy — acceptable only if the resolved parent copy is 9.5.x; two distinct versions is a FAILURE — stop and reconcile before proceeding.

- [ ] **Step 4: Run the record-integrity net — the #53 repro must survive unmodified**

```bash
(cd sync && bunx vitest run test/restore.test.ts)
(cd shared && bun test export-codec.test.ts) || (cd shared && bunx vitest run export-codec.test.ts) || bun test shared/export-codec.test.ts
```

(The shared codec suite runs under whichever runner the repo already uses for `shared/*.test.ts` — discover with `git grep -l export-codec` in CI config or run it the way the root suite does; the requirement is that it RUNS and PASSES, not which runner.)

Expected: all green, `sync/test/restore.test.ts` UNMODIFIED (its array-cell fixture is the pinned #53 hazard proof — research §3 verified 9.5.1 behaves identically, so a red here means the bump did something the research didn't predict: STOP and report, do not patch the test).

- [ ] **Step 5: Run every full suite**

```bash
bun test tests/
(cd app && bunx vitest run && bun run check)
(cd sync && bunx vitest run)
(cd broker && bunx vitest run --dir test)
(cd scripts && bun test .)
```

Expected: all green. Known pre-existing exception: `broker/test-mcp-client/harness.test.ts` load-fails on an ajv CJS shim (#54, verified at BASE) — that one suite contributing 0 tests is NOT a bump regression; every other count must match pre-bump.

- [ ] **Step 6: Commit**

```bash
git add package.json app/package.json shared/package.json sync/package.json scripts/package.json bun.lock app/bun.lock shared/bun.lock sync/bun.lock scripts/bun.lock
git commit -m "deps: align tinybase to ^9.5.1 across all five workspaces (#44)

Cures the 9.2.0 fragmenter's U+2028/U+2029 deletion (research §2) and the
bytes-vs-chars FRAGMENT_SIZE ambiguity. DO on-disk layout byte-identical
(research §5) — no migration. The #53 middleware hazard is NOT fixed
upstream; restore.test.ts green unmodified proves the lazy guards survive."
```

(Only add the lockfiles that actually exist; `git status` is the authority.)

### Task 2: Fragmenter regression test — U+2028/U+2029 survive a fragmented sync

**Type:** implementation
**Depends-on:** 1

**Files:**
- Test: `scripts/fragmenter-regression.test.ts`

**Interfaces:**
- Consumes: `createStreamStore(id?)` from `julian-shared/schema` (existing); the loopback pattern from `scripts/fireproof-write.test.ts` (reference only — copy, don't import)
- Produces: nothing consumed by other tasks

**Parallelization rationale:** pure test addition against Task 1's tree; shares no file with Tasks 3/4.

- [ ] **Step 1: Write the test**

Create `scripts/fragmenter-regression.test.ts`. The scenario: two clients joined by a relay server; client A sends a cell LARGER than `FRAGMENT_SIZE` containing U+2028/U+2029; client B must receive it byte-identical. On tinybase 9.2.0 the `.{1,N}` regex fragmenter deleted those code points in transit (research §2, the defect that motivated #44's re-triage); 9.3.0+ walks code points. This test pins the cure.

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createWsServer } from 'tinybase/synchronizers/synchronizer-ws-server';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { createStreamStore } from 'julian-shared/schema';

const FRAGMENT_SIZE = 262144; // must match app/src/lib/store.ts and sync/src/do.ts

const wss = new WebSocketServer({ port: 0 });
const port = (wss.address() as { port: number }).port;
const srv = createWsServer(wss);
const url = `ws://127.0.0.1:${port}/julian/chat`;
afterAll(() => srv.destroy());

async function connect(store: ReturnType<typeof createStreamStore>) {
  const sync = await createWsSynchronizer(
    store,
    new WebSocket(url) as unknown as globalThis.WebSocket,
    5,
    undefined,
    undefined,
    undefined,
    FRAGMENT_SIZE,
  );
  await sync.startSync();
  return sync;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('fragmenter (9.5.1): separators survive fragmentation', () => {
  test('a >FRAGMENT_SIZE cell carrying U+2028/U+2029 arrives byte-identical', async () => {
    const a = createStreamStore('frag-a');
    const b = createStreamStore('frag-b');
    const sa = await connect(a);
    const sb = await connect(b);

    // Larger than one fragment, separators placed either side of the boundary.
    const text = 'x'.repeat(FRAGMENT_SIZE - 4) + '\u2028 mid \u2029' + 'y'.repeat(4096); // escapes, never literals: the defect under test is these code points vanishing silently
    a.setRow('messages', 'frag-1', {
      sessionId: 's', role: 'user', speakerName: 'test', text, ts: 1, kind: 'chat',
    });

    await until(() => b.getCell('messages', 'frag-1', 'text') === text);
    const received = b.getCell('messages', 'frag-1', 'text') as string;
    expect(received.length).toBe(text.length); // 9.2.0 deleted the separators: length shrank by 2
    expect(received.includes('\u2028')).toBe(true);
    expect(received.includes('\u2029')).toBe(true);

    sa.destroy();
    sb.destroy();
  });
});
```

(If the schema rejects an unknown cell or `createStreamStore`'s messages table differs, read `shared/schema.ts` and use its exact `messages` cell set — the row above matches `MessageRow` in `app/src/lib/store.ts`.)

- [ ] **Step 2: Run it**

```bash
(cd scripts && bun test fragmenter-regression.test.ts)
```

Expected: PASS. (Fail-first note: this test's red state is tinybase 9.2.0, which Task 1 already removed — its regression value is pinning the cure so a future downgrade or fragmenter change screams. Do NOT reinstall 9.2.0 to watch it fail; the research verified the 9.2.0 defect empirically.)

- [ ] **Step 3: Commit**

```bash
git add scripts/fragmenter-regression.test.ts
git commit -m "test: pin the fragmenter separator cure — U+2028/U+2029 survive fragmented sync (#44)"
```

### Task 3: The #12 proof — offline compose, reconnect, converge without duplication

**Type:** implementation
**Depends-on:** 1

**Files:**
- Test: `scripts/reconnect.test.ts`
- Test: `app/src/lib/store.test.ts`

**Commutes:** `app/src/lib/store.test.ts`

**Interfaces:**
- Consumes: `createStreamStore` from `julian-shared/schema`; in the app test: `startPersistence(handle)`, `writeMessage(id, row)` and the existing `memHandle()` helper, all already present in `app/src/lib/store.test.ts`
- Produces: nothing consumed by other tasks

**Parallelization rationale:** test-only additions on two suites Tasks 2/4 don't own; the app-test append is declared commuting.

- [ ] **Step 1: Write the reconnect-convergence test**

Create `scripts/reconnect.test.ts` — the wire half of #12: a client that composes while its socket is DOWN and then reconnects must converge its offline row to the other side exactly once, and receive what it missed.

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createWsServer } from 'tinybase/synchronizers/synchronizer-ws-server';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { createStreamStore } from 'julian-shared/schema';

const wss = new WebSocketServer({ port: 0 });
const port = (wss.address() as { port: number }).port;
const srv = createWsServer(wss);
const url = `ws://127.0.0.1:${port}/julian/chat`;
afterAll(() => srv.destroy());

async function connect(store: ReturnType<typeof createStreamStore>) {
  const sync = await createWsSynchronizer(
    store,
    new WebSocket(url) as unknown as globalThis.WebSocket,
    5,
  );
  await sync.startSync();
  return sync;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const row = (text: string, ts: number) =>
  ({ sessionId: 's', role: 'user', speakerName: 'test', text, ts, kind: 'chat' });

describe('offline-compose → reconnect (#12)', () => {
  test('a row composed offline lands exactly once after reconnect, and the missed row arrives', async () => {
    const device = createStreamStore('dev');
    const peer = createStreamStore('peer');

    // Phase 1: both online, agree on a baseline row.
    let deviceSync = await connect(device);
    const peerSync = await connect(peer);
    device.setRow('messages', 'base-1', row('baseline', 1));
    await until(() => peer.getCell('messages', 'base-1', 'text') === 'baseline');

    // Phase 2: device goes OFFLINE (socket torn down), composes; peer also writes.
    deviceSync.destroy();
    device.setRow('messages', 'offline-1', row('written while down', 2));
    peer.setRow('messages', 'missed-1', row('written while device was away', 3));
    expect(peer.getRowIds('messages').includes('offline-1')).toBe(false); // truly offline

    // Phase 3: device reconnects on a FRESH socket+synchronizer (what a reload does).
    deviceSync = await connect(device);
    await until(
      () =>
        peer.getCell('messages', 'offline-1', 'text') === 'written while down' &&
        device.getCell('messages', 'missed-1', 'text') === 'written while device was away',
    );

    // No duplication in either direction: exactly the three rows, each once.
    expect(peer.getRowIds('messages').sort()).toEqual(['base-1', 'missed-1', 'offline-1']);
    expect(device.getRowIds('messages').sort()).toEqual(['base-1', 'missed-1', 'offline-1']);

    deviceSync.destroy();
    peerSync.destroy();
  });
});
```

- [ ] **Step 2: Run it**

```bash
(cd scripts && bun test reconnect.test.ts)
```

Expected: PASS.

- [ ] **Step 3: Append the OPFS half to the app suite**

In `app/src/lib/store.test.ts`, inside the existing `describe('client store', …)` block (append after the `'reload preserves CRDT stamps…'` test, which ends near line 137), add — reusing the file's existing `memHandle()` helper and imports:

```ts
  test('#12: a row composed offline lands in the persister file and survives reload', async () => {
    // No synchronizer exists in this test at all — that IS the offline state.
    const handle = memHandle();
    const persister = await startPersistence(handle);
    expect(persister).not.toBeNull();
    writeMessage('offline-evt', {
      sessionId: 's', role: 'user', speakerName: 'Marcus', text: 'composed offline', ts: 9,
    });
    await persister!.save();
    await persister!.destroy();

    // Reload: a fresh store over the same file — stamps included, so a later
    // reconnect syncs this as ONE stamped write, never a re-stamped fresh one.
    const reloaded = createStreamStore('reloaded-offline');
    const p2 = createOpfsPersister(reloaded, handle);
    await p2.load();
    expect(reloaded.getCell('messages', 'offline-evt', 'text')).toBe('composed offline');
    await p2.destroy();
  });
```

- [ ] **Step 4: Run the app suite**

```bash
(cd app && bunx vitest run src/lib/store.test.ts)
```

Expected: PASS, including the new test.

- [ ] **Step 5: Commit**

```bash
git add scripts/reconnect.test.ts app/src/lib/store.test.ts
git commit -m "test: witness the last on-faith path — offline compose survives reload and reconnects without duplication (#12)"
```

### Task 4: onIgnoredError on the DO — malformed traffic becomes visible, class-only

**Type:** implementation
**Depends-on:** 1
**Review:** adversarial

**Files:**
- Modify: `sync/src/do.ts`
- Test: `sync/test/do.test.ts`

**Commutes:** `sync/test/do.test.ts`

**Interfaces:**
- Consumes: `JulianSyncDO` (existing class), `runInDurableObject` + `env` from `cloudflare:test` (pattern in `sync/test/do-sweep.test.ts:16,100`)
- Produces: `JulianSyncDO.onIgnoredError(error: unknown): void`

- [ ] **Step 1: Write the failing test**

Append to `sync/test/do.test.ts` (its existing imports already include `runInDurableObject`-compatible machinery — follow `do-sweep.test.ts`'s stub pattern if `do.test.ts` builds stubs differently):

```ts
describe('onIgnoredError — malformed sync traffic is visible, class-only (9.5.1)', () => {
  test('logs the error class and never the content', async () => {
    const id = env.JULIAN_SYNC_DO.idFromName('/julian/chat');
    const stub = env.JULIAN_SYNC_DO.get(id);
    await runInDurableObject(stub, async (instance: JulianSyncDO) => {
      const logged: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        instance.onIgnoredError(new SyntaxError('SECRET-PAYLOAD-CONTENT jla_token123'));
      } finally {
        console.warn = orig;
      }
      const line = logged.find((l) => l.includes('[sync-do] ignored protocol error'));
      expect(line).toBeDefined();
      expect(line).toContain('SyntaxError');           // the class travels
      expect(line).not.toContain('SECRET-PAYLOAD');    // the content never does
      expect(line).not.toContain('jla_');              // nor anything token-shaped
    });
  });

  test('a non-Error value logs a class name, not its stringified content', async () => {
    const id = env.JULIAN_SYNC_DO.idFromName('/julian/chat');
    const stub = env.JULIAN_SYNC_DO.get(id);
    await runInDurableObject(stub, async (instance: JulianSyncDO) => {
      const logged: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        instance.onIgnoredError('raw-string-with-content');
      } finally {
        console.warn = orig;
      }
      const line = logged.find((l) => l.includes('[sync-do] ignored protocol error'));
      expect(line).toBeDefined();
      expect(line).toContain('string');
      expect(line).not.toContain('raw-string-with-content');
    });
  });
});
```

(Adopt `do.test.ts`'s actual DO-binding name and path constants if they differ from `JULIAN_SYNC_DO` / `/julian/chat` — read the file's existing tests first and match them exactly; the assertions above are the contract.)

- [ ] **Step 2: Run to verify it fails**

```bash
(cd sync && bunx vitest run test/do.test.ts)
```

Expected: FAIL — `onIgnoredError` is not overridden, so either nothing is logged with the `[sync-do]` prefix or the type refuses the call.

- [ ] **Step 3: Implement the override**

In `sync/src/do.ts`, inside `JulianSyncDO`, immediately after `getFragmentSize()` (~line 256), add:

```ts
  // 9.3.0+: called when the DO receives an invalid synchronization protocol
  // message; the sending client is disconnected after this returns. The
  // callback carries no socket reference, so there is no lease to attribute a
  // ledger row to — this is observability plumbing beneath the ledger, and it
  // speaks in classes only: never the message, never the payload, never
  // anything that could carry record content or a token (ledger discipline).
  onIgnoredError(error: unknown): void {
    const cls = error instanceof Error ? error.name : typeof error;
    console.warn('[sync-do] ignored protocol error', cls);
  }
```

- [ ] **Step 4: Run to verify it passes**

```bash
(cd sync && bunx vitest run test/do.test.ts)
```

Expected: PASS (both new tests, and every pre-existing test in the file untouched-green).

- [ ] **Step 5: Run the whole sync suite**

```bash
(cd sync && bunx vitest run)
```

Expected: all green — the override must not perturb restore, sweep, scope, or routing behavior.

- [ ] **Step 6: Commit**

```bash
git add sync/src/do.ts sync/test/do.test.ts
git commit -m "feat(sync): onIgnoredError override — malformed sync traffic logged class-only (#44, research §7)"
```

### Task 5: Full battery

**Type:** gate
**Depends-on:** 1, 2, 3, 4

**Files:**
- Test: all suites (no writes)

Run, each green:

```bash
bun test tests/
(cd app && bunx vitest run && bun run check)
(cd sync && bunx vitest run)
(cd broker && bunx vitest run --dir test)
(cd scripts && bun test .)
```

Expectations: every suite green at its pre-bump count or higher (Tasks 2–4 added tests); `sync/test/restore.test.ts` green and UNMODIFIED (`git diff --stat main -- sync/test/restore.test.ts` shows no change); the only permitted red is #54's pre-existing harness load failure in broker's `test-mcp-client` (0-test suite, verified at BASE).

### Task 6: Paired deploy and live smoke — Marcus's word required

**Type:** manual
**Depends-on:** 5

**Files:** none (runbook)

The research (§8) confirms the wire is compatible both ways during a rolling window, but the fragmenter cure only protects legs where the SENDER is upgraded — so sync and app deploy in ONE sitting, never straddling a day.

1. On Marcus's word: `(cd sync && bunx wrangler deploy)`, then deploy the app per the `deploy` skill (Update path; heed #55 — verify `.env` VALUES point at `*.julian.soul.store` / `souls.exe.xyz` before any build).
2. Live smoke, Marcus present: two browser tabs on the app, compose in each, watch both trios converge; pill reaches `synced` in both.
3. Export-hash eyeball (research §8 item 3): run the standing export read and compare `contentHash` against the most recent pre-bump export — stamps and hashes are version-stable (research §4), so the hash must be unchanged if no rows changed in between, or explainable by exactly the rows that did.
4. Offline-compose spot check (the #12 live twin, cheap while both tabs are open): dev-tools → Network offline in one tab, compose, restore network, watch the row arrive in the other tab exactly once.

### Task 7: Bookkeeping — the record closes its loops

**Type:** release
**Depends-on:** 6

**Files:**
- Modify: `docs/superpowers/docket.md`

1. Comment + close #44: cured by this plan's merge commit — cite the fragmenter regression test and the single-version resolution proof.
2. Comment + close #12: cite `scripts/reconnect.test.ts`, the app OPFS test, and the live spot check from Task 6.
3. Comment #52: reaffirm items 1+2 still live at 9.5.1 (research already noted on the issue).
4. `git push` (memory/docs commits ride along per house practice).

---

## Operator smoke

- do: open the app in two browser tabs, type a message in each
- see: both messages appear in both tabs within seconds; the pill reads SYNCED in both

- do: in one tab, dev-tools → Network → Offline; type a message; go back online
- see: the message appears in the OTHER tab exactly once — never twice, never lost

- do: paste a long text containing a U+2028 character (copy one from https://unicode-explorer.com/c/2028) into a message, send, reload the other tab
- see: the character survives — the message renders whole on both sides after reload

- do: from the Mac, run the standing export read against the deployed sync worker
- see: `contentHash` present and the export completes — no error, no hash surprise beyond rows written since the last export
