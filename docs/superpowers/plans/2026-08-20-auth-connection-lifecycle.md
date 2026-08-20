# Auth & Connection Lifecycle Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app one owned connection lifecycle — real token renewal, a logout that actually closes and clears, honest terminal states for deterministic failures — closing issue #4's residual plus #34, #43, and #5's teardown remainder.

**Architecture:** A new `app/src/lib/connection.ts` module acquires and owns every connection resource (OPFS persister, sync socket + Synchronizer + ExchangeClient, SSE reader) and releases them all in one idempotent `stop()`. Logout stops the connection, deletes the OPFS cache file, and hard-reloads the page — never wiping the live CRDT store in memory, because deleting rows in a MergeableStore writes tombstones that would sync as mass deletions; the reload kills the in-memory store without it ever syncing again. The OIDC scope gains `offline_access` with automatic silent renew. The exchange client counts the revoked latch once; the ticket provider counts consecutive *throws* and flips the pill to the existing `stale` phase after three, so a shipped-bundle defect surfaces in seconds instead of looping silently at `connecting`.

**Tech Stack:** Svelte 5 (runes), TinyBase MergeableStore + OPFS persister, oidc-client-ts, reconnecting-websocket, vitest.

**Spec:** Design approved in-chat by Marcus, 2026-08-20 (docket entry #4, `docs/superpowers/docket.md`; clear-on-logout decided: yes, full clear). Issue bodies #4/#5/#34/#43 + their Aug 20 triage comments carry the defect statements.

**Acceptance:** suite — the app vitest suite covers every behavior change; the live issuer half is an explicitly-manual runbook task.

## Global Constraints

- **Never wipe the in-memory MergeableStore while it can ever sync again:** local clearing is file-deletion + page reload only. `store.delTables()`/`delValues()` on logout is forbidden — tombstones would replicate as deletions of the record.
- **Providers stay TOTAL:** the ticket URL provider must never reject or throw (a rejecting provider holds ReconnectingWebSocket's `_connectLock` forever). All new logic in it stays inside the existing try/catch shape.
- **`stop()` is idempotent:** calling it twice, or calling it while startup is still in flight, must not throw.
- **Local mode keeps working:** with no `VITE_OIDC_ISSUER` the app runs unauthenticated; every lifecycle change must be a no-op-safe path there (no auth, sync offline, events still connect).
- **TDD:** every behavior change lands test-first; run the failing test before the implementation.

---

### Task 1: Exchange client — count the revoked latch once

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `app/src/lib/exchange.ts:185-190`
- Test: `app/src/lib/exchange.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: unchanged public API; behavior contract: `terminalCount()` increases by exactly 1 when the client latches revoked, and repeated `access()` calls on an already-latched client do not increase it further (issue #34 — the counter counts consecutive terminal outcomes, not reads of one latched state).

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/exchange.test.ts` (reuse the file's existing helpers for constructing a client whose fetch returns a revoked exchange response — the revoked-latch test at ~line 53 shows the pattern):

```ts
  test('terminalCount: the revoked latch counts once, not once per read (#34)', async () => {
    const client = revokedClient(); // build exactly as the existing revoked-latch test builds its client
    await client.access(); // latches: terminal 0 → 1
    expect(client.terminalCount()).toBe(1);
    await client.access(); // latched reads must not inflate
    await client.access();
    expect(client.terminalCount()).toBe(1);
    client.reset();
    expect(client.terminalCount()).toBe(0);
  });
```

(If the file has no shared `revokedClient()` helper, inline the same `new ExchangeClient({...fetchImpl})` construction its existing revoked test uses; do not invent a new response shape.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && bunx vitest run src/lib/exchange.test.ts`
Expected: FAIL — today every latched `access()` re-increments, so the count reads 3.

- [ ] **Step 3: Implement**

In `app/src/lib/exchange.ts`, replace `revokedState()`:

```ts
  private revokedState(): ExchangeStateNonOk {
    if (!this.isRevoked) this.terminal += 1; // count the latch itself once — reads of a latched state are not new outcomes (#34)
    this.isRevoked = true;
    this.cached = null;
    return { kind: 'revoked' };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd app && bunx vitest run src/lib/exchange.test.ts`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/exchange.ts app/src/lib/exchange.test.ts
git commit -m "exchange: revoked latch counts once toward terminalCount (#34)"
```

---

### Task 2: Events — an abortable SSE reader

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `app/src/lib/events.ts`
- Test: `app/src/lib/events.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `connectEvents(handlers?: { onEphemeral?: (e: ServerEvent) => void }, fetchImpl?: typeof fetch): { stop(): void }` — `stop()` aborts the in-flight fetch/read immediately via AbortController (no more leaked reader parked in `read()`), is idempotent, and the loop exits without scheduling further reconnects.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/events.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import { connectEvents } from './events';

vi.mock('./auth', () => ({ getToken: async () => null }));
vi.mock('./store', () => ({ writeMessage: vi.fn(), store: { hasRow: () => false, setPartialRow: vi.fn() } }));
vi.mock('./jobs', () => ({ applyJobsAction: () => undefined }));

function hangingFetch(onAbort: () => void): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        onAbort();
        reject(new DOMException('aborted', 'AbortError'));
      });
    })) as typeof fetch;
}

describe('connectEvents stop (#4d)', () => {
  test('stop() aborts the in-flight request instead of leaking it', async () => {
    let aborted = false;
    const conn = connectEvents({}, hangingFetch(() => { aborted = true; }));
    await new Promise((r) => setTimeout(r, 10)); // let the loop reach the fetch
    conn.stop();
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
  });

  test('stop() is idempotent', async () => {
    const conn = connectEvents({}, hangingFetch(() => {}));
    await new Promise((r) => setTimeout(r, 10));
    conn.stop();
    expect(() => conn.stop()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && bunx vitest run src/lib/events.test.ts`
Expected: FAIL — `connectEvents` takes no `fetchImpl` today and `stop()` only flips a flag, so `aborted` stays false.

- [ ] **Step 3: Implement**

In `app/src/lib/events.ts`, replace `connectEvents` with:

```ts
export function connectEvents(
  handlers: { onEphemeral?: (e: ServerEvent) => void } = {},
  fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args),
): { stop(): void } {
  let stopped = false;
  let lastId = -1;
  const controller = new AbortController();
  (async function loop() {
    while (!stopped) {
      try {
        const t = await getToken();
        const res = await fetchImpl(`/api/events?after=${lastId}`, {
          headers: t ? { 'X-Authorization': `Bearer ${t}` } : {},
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events → ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
            if (!data) continue;
            const e = JSON.parse(data) as ServerEvent;
            lastId = Math.max(lastId, e.id);
            applyServerEvent(e);
            handlers.onEphemeral?.(e);
          }
        }
      } catch {
        if (stopped) return; // an abort is a stop, not a reconnectable failure
        await new Promise((r) => setTimeout(r, 2000)); // reconnect with delay
      }
    }
  })();
  return {
    stop() {
      stopped = true;
      controller.abort(); // rejects the pending fetch AND any parked reader.read()
    },
  };
}
```

(The bare-global-fetch lambda default follows the `exchange.ts` brand-check lesson: never store the raw `fetch` reference.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd app && bunx vitest run src/lib/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/events.ts app/src/lib/events.test.ts
git commit -m "events: stop() aborts the SSE reader instead of leaking it (#4)"
```

---

### Task 3: Store — sync returns a handle; provider goes stale on consecutive throws

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `app/src/lib/store.ts`
- Test: `app/src/lib/store.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `startSync(getJwt, client?): Promise<SyncHandle | null>` where `SyncHandle = { sync: Synchronizer; ws: ReconnectingWebSocket; client: ExchangeClient }` (null when sync env vars are absent, as today). `createTicketUrlProvider(client, base, closeSocket)` keeps its signature; new behavior contract: three consecutive *thrown* provider iterations flip the phase to `'stale'` (issue #43); any successfully-resolved `ticket()` call resets the throw count.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/store.test.ts` (following its existing provider-test pattern at ~line 134, which drives `createTicketUrlProvider` with a mock client):

```ts
  test('three consecutive provider throws reach stale — a deterministic defect is not an eternal connecting (#43)', async () => {
    vi.useFakeTimers();
    const client = {
      ticket: vi.fn().mockRejectedValue(new TypeError('Illegal invocation')),
      terminalCount: () => 0,
    } as unknown as ExchangeClient;
    const provide = createTicketUrlProvider(client, 'wss://sync.example', () => {});
    const pending = provide('wss://sync.example'); // never resolves in this scenario; we watch the phase
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(31_000); // step through backoff sleeps
    expect(syncPhase()).toBe('stale');
    vi.useRealTimers();
    void pending;
  });

  test('a successful ticket resolution resets the throw count', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = {
      ticket: vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls <= 2) throw new TypeError('flaky');
        return { ticket: 'jst_ok' };
      }),
      terminalCount: () => 0,
    } as unknown as ExchangeClient;
    const provide = createTicketUrlProvider(client, 'wss://sync.example', () => {});
    const url = provide('wss://sync.example');
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(31_000);
    expect(await url).toContain('ticket=jst_ok');
    expect(syncPhase()).not.toBe('stale'); // two throws then success: no false stale
    vi.useRealTimers();
  });
```

(Match the provider's actual call signature from the existing tests — if `provideUrl` takes no argument in this codebase, drop the argument; the existing test at ~line 134 is the authority. Import `syncPhase` and `createTicketUrlProvider` as the existing tests do.)

- [ ] **Step 2: Run to verify the first test fails**

Run: `cd app && bunx vitest run src/lib/store.test.ts`
Expected: the stale test FAILS (phase stays `connecting` forever today); the reset test also fails until implementation.

- [ ] **Step 3: Implement the provider throw counter**

In `app/src/lib/store.ts`, inside `createTicketUrlProvider`, add a counter and amend the loop:

```ts
  const STALE_THROW_LIMIT = 3;
  let consecutiveThrows = 0;
```

and change the `for (;;)` body's try/catch:

```ts
      try {
        const t = await client.ticket();
        consecutiveThrows = 0; // the client resolved — whatever the outcome, the bundle can run it
        // ... existing resolution handling unchanged ...
      } catch {
        // A throw here is exactly the class most likely to be a shipped-bundle
        // defect (#43: the fetch-binding bug looped silently at 'connecting'
        // for a forensic hour). Three in a row → say so on the pill.
        consecutiveThrows += 1;
        if (consecutiveThrows >= STALE_THROW_LIMIT) setPhase('stale');
        await sleep(backoff()); // belt over braces: nothing escapes
      }
```

(The provider stays TOTAL — the counter lives entirely inside the existing try/catch; no new exit path.)

- [ ] **Step 4: Write the failing handle test**

Append to `app/src/lib/store.test.ts`:

```ts
  test('startSync returns a handle carrying sync, ws, and client (#4)', async () => {
    // Follow the existing startSync test's env/mocking setup (VITE_SYNC_URL /
    // VITE_GATE_URL seams and injected ExchangeClient) — same arrangement,
    // new assertions:
    const handle = await startSyncUnderTest(); // however the existing test invokes it
    expect(handle).not.toBeNull();
    expect(typeof handle!.sync.destroy).toBe('function');
    expect(typeof handle!.ws.close).toBe('function');
    expect(typeof handle!.client.reset).toBe('function');
  });
```

(If no existing test invokes `startSync` end-to-end — the suite may only test the provider — write this test with the same injected-client seam `startSync(getJwt, client)` already exposes, and a mock WebSocket via the module's existing test seams; if the file genuinely has no seam for the WebSocket constructor, assert the handle shape by type-only compilation instead and note it in the commit message.)

- [ ] **Step 5: Implement the handle**

In `app/src/lib/store.ts`:

```ts
export interface SyncHandle {
  sync: Synchronizer;
  ws: ReconnectingWebSocket;
  client: ExchangeClient;
}
```

Change `startSync`'s signature to `Promise<SyncHandle | null>` and its tail to:

```ts
  await sync.startSync();
  return { sync, ws, client: exchangeClient };
```

Update every in-repo caller and test that consumed the old `Synchronizer` return (App.svelte currently discards it — the connection-module task rewires that caller; within this task, fix only `store.test.ts` usages).

- [ ] **Step 6: Run the suite**

Run: `cd app && bunx vitest run src/lib/store.test.ts`
Expected: PASS whole file.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/store.ts app/src/lib/store.test.ts
git commit -m "store: startSync returns a stoppable handle; provider flips stale on consecutive throws (#4, #43)"
```

---

### Task 4: Connection module, logout that clears, offline_access

**Type:** implementation
**Depends-on:** 1, 2, 3
**Review:** adversarial

**Files:**
- Create: `app/src/lib/connection.ts`
- Create: `app/src/lib/connection.test.ts`
- Modify: `app/src/lib/auth.ts`
- Modify: `app/src/App.svelte`

**Interfaces:**
- Consumes: `SyncHandle` and `startSync(getJwt, client?): Promise<SyncHandle | null>` (from the store task); abortable `connectEvents(handlers?, fetchImpl?): { stop(): void }` (from the events task); once-counting `ExchangeClient.reset()` semantics (from the exchange task); `startPersistence(handle?): Promise<Persister | null>` (existing).
- Produces: `startConnection(getJwt: () => Promise<string | null>, opts?: { onEphemeral?: (e: ServerEvent) => void }): Promise<ConnectionHandle>`; `stopConnection(): Promise<void>` (module-level, idempotent, stops the current handle if any); `clearLocalRecord(dir?: FileSystemDirectoryHandle): Promise<void>` (deletes the OPFS cache file; missing file is fine). `ConnectionHandle = { stop(): Promise<void> }`.

**Parallelization rationale:** none needed — this is the fan-in task; the three wave-1 tasks each produce one leg of the handle it composes.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/connection.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';

const persister = { destroy: vi.fn() };
const syncHandle = {
  sync: { destroy: vi.fn() },
  ws: { close: vi.fn() },
  client: { reset: vi.fn() },
};
const events = { stop: vi.fn() };

vi.mock('./store', () => ({
  startPersistence: vi.fn(async () => persister),
  startSync: vi.fn(async () => syncHandle),
}));
vi.mock('./events', () => ({ connectEvents: vi.fn(() => events) }));

import { clearLocalRecord, startConnection, stopConnection } from './connection';

beforeEach(() => vi.clearAllMocks());

describe('connection lifecycle (#4)', () => {
  test('stop releases every acquired resource', async () => {
    const conn = await startConnection(async () => null);
    await conn.stop();
    expect(syncHandle.sync.destroy).toHaveBeenCalled();
    expect(syncHandle.ws.close).toHaveBeenCalled();
    expect(syncHandle.client.reset).toHaveBeenCalled(); // post-logout ticket minting dies here
    expect(events.stop).toHaveBeenCalled();
    expect(persister.destroy).toHaveBeenCalled();
  });

  test('stop is idempotent and stopConnection stops the current handle', async () => {
    await startConnection(async () => null);
    await stopConnection();
    await stopConnection(); // second call: no throw, no double-release
    expect(syncHandle.sync.destroy).toHaveBeenCalledTimes(1);
  });

  test('clearLocalRecord deletes the OPFS cache file and tolerates absence', async () => {
    const dir = { removeEntry: vi.fn(async () => {}) } as unknown as FileSystemDirectoryHandle;
    await clearLocalRecord(dir);
    expect(dir.removeEntry).toHaveBeenCalledWith('julian-chat.json');
    const missing = {
      removeEntry: vi.fn(async () => { throw new DOMException('nope', 'NotFoundError'); }),
    } as unknown as FileSystemDirectoryHandle;
    await expect(clearLocalRecord(missing)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && bunx vitest run src/lib/connection.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the module**

Create `app/src/lib/connection.ts`:

```ts
// One owner for every connection resource (#4): what startConnection
// acquires, stop() releases — and nothing else holds a reference.
import { startPersistence, startSync } from './store';
import { connectEvents, type ServerEvent } from './events';
import type { Persister } from 'tinybase/persisters';

export interface ConnectionHandle {
  stop(): Promise<void>;
}

let current: ConnectionHandle | null = null;

export async function startConnection(
  getJwt: () => Promise<string | null>,
  opts: { onEphemeral?: (e: ServerEvent) => void } = {},
): Promise<ConnectionHandle> {
  await stopConnection(); // never two live connections

  const persister: Persister | null = await startPersistence();
  const events = connectEvents({ onEphemeral: opts.onEphemeral });
  const sync = await startSync(getJwt);

  let stopped = false;
  const handle: ConnectionHandle = {
    async stop() {
      if (stopped) return;
      stopped = true;
      events.stop();
      if (sync) {
        sync.sync.destroy();
        sync.ws.close();
        sync.client.reset(); // drop the cached access token: no minting past logout
      }
      persister?.destroy();
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}

/** Stop whatever connection is live. Safe with none. */
export async function stopConnection(): Promise<void> {
  await current?.stop();
}

/**
 * Delete the local OPFS cache file. Logout-only; the in-memory store is NEVER
 * wiped (MergeableStore deletions are tombstones that would sync as mass
 * deletions of the record) — the caller hard-reloads the page instead, so the
 * in-memory copy dies without ever syncing again.
 */
export async function clearLocalRecord(dir?: FileSystemDirectoryHandle): Promise<void> {
  if (!dir) {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return;
    dir = await navigator.storage.getDirectory();
  }
  try {
    await dir.removeEntry('julian-chat.json');
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  }
}
```

(If `Persister`'s type import path differs in this repo, match whatever `store.ts` itself imports.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd app && bunx vitest run src/lib/connection.test.ts`
Expected: PASS.

- [ ] **Step 5: Turn on real renewal in auth.ts**

In `app/src/lib/auth.ts`, change two `UserManager` settings:

```ts
    scope: 'openid profile offline_access',
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    automaticSilentRenew: true, // background renewal via the refresh token; getToken() keeps its explicit renew as belt-over-braces
```

(Only `scope` and `automaticSilentRenew` change; if the issuer declines refresh tokens, `signinSilent()` fails as today and the UI's signed-out path carries it honestly — the manual task verifies the live half.)

- [ ] **Step 6: Rewire App.svelte through the module**

In `app/src/App.svelte`:

1. Replace the imports of `connectEvents`/`startSync` with `startConnection, stopConnection` from `./lib/connection`, and add `clearLocalRecord` to that import.
2. The boot effect drops `startPersistence()` (the connection owns it now):

```ts
  $effect(() => {
    (async () => {
      await initAuth();
      sfxMuted = sfx.isMuted();
      booted = true;
    })();
  });
```

3. The ready effect becomes:

```ts
  $effect(() => {
    if (!ready) return;
    void startConnection(getToken, { onEphemeral: handleEphemeral });
    fetchHealth().then((h) => (sessionActive = h.sessionActive));
    return () => { void stopConnection(); };
  });
```

4. The LOGOUT button handler becomes:

```ts
            onclick={async () => {
              await stopConnection();      // close socket, kill ticket minting, stop reader, stop persister
              await clearLocalRecord();    // delete the OPFS cache
              await signOut();             // drop the OIDC user
              window.location.replace('/'); // the in-memory store dies with the page — never syncs a wipe
            }}
```

- [ ] **Step 7: Run the whole app suite**

Run: `cd app && bunx vitest run`
Expected: PASS across all files (exchange, events, store, connection, and the pre-existing component-module tests).

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/connection.ts app/src/lib/connection.test.ts app/src/lib/auth.ts app/src/App.svelte
git commit -m "app: one owned connection lifecycle; logout closes, clears, reloads; offline_access renewal (#4, #5)"
```

---

### Task 5: Full verification

**Type:** gate
**Depends-on:** 1, 2, 3, 4

Run, expected green:

- `cd app && bunx vitest run` — the whole app suite.

(`bun run check` is knowingly red on an unrelated cause — parked issue #44; it is not this plan's gate.)

---

### Task 6: Live issuer + logout smoke

**Type:** manual
**Depends-on:** 5

Marcus-present runbook (needs his Pocket ID admin access and a browser):

- [ ] **Step 1:** Confirm the Pocket ID client for the app issues refresh tokens with the `offline_access` scope (admin UI; flip the client setting if it exists and is off). Record what was found in the deploy notes.
- [ ] **Step 2:** Live smoke on julian-new (or the Mac app): sign in → confirm sync; wait past access-token life (or shorten it) → confirm the session renews without a full-page redirect.
- [ ] **Step 3:** Logout smoke: sign out → confirm the socket closes (devtools), the OPFS file is gone (`navigator.storage.getDirectory()` in console), the page reloaded signed-out, and — the #4c proof — no further `/socket-ticket` mints appear in the gate ledger after the logout timestamp.
- [ ] **Step 4:** Note results on issue #4 and close it (with #5, #34, #43) if all green.

---

## Self-review notes

- Spec coverage: #4a → Task 4 Step 5 + Task 6; #4c → Tasks 4 (stop before signOut, reset kills minting, OPFS delete) + 6 Step 3; #4d/#5 residual → Tasks 2, 3, 4 (ownership + release, unit-tested without DOM mounting — the extraction makes mount-infra unnecessary for this bug class); #34 → Task 1; #43 → Task 3.
- Type consistency: `SyncHandle` produced in Task 3 is exactly what Task 4's mock and module consume ({ sync.destroy, ws.close, client.reset }); `connectEvents(handlers?, fetchImpl?)` matches Tasks 2 and 4.
- Tombstone hazard stated in Global Constraints, module comment, and App wiring — the three places a future editor would touch.
- Wave shape: Tasks 1/2/3 independent (wave 1), Task 4 fan-in (wave 2). No manufactured contracts; the module boundary existed as a design decision, not a parallelism trick.
