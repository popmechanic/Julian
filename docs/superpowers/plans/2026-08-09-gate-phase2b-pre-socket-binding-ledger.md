# Gate Phase 2B-pre — Socket Policy, Introspection Binding, Refusal Ledger Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three Plan B preconditions found at the 2A gate: the sync→broker introspection wire that has never worked live (issue #28 — same-account `workers.dev` fetches silently 404), the bidirectional socket that `stream-read` could hold (single-writer violation), and the sync-side scope refusals that leave no ledger row.

**Architecture:** Sync reaches the gate through a **service binding** (`GATE`) instead of a public URL — `introspectLease` takes a fetcher, not a URL string. The WebSocket becomes **full-house-only**: TinyBase's sync protocol is bidirectional by design (a socket client can push `ContentDiff`/`ContentHashes` and answer diff requests, and the DO relays client↔client), so read-scoped leases get no socket at all — `stream-read` keeps `/export` and will get request/response verbs in Plan B. Every sync-side refusal is reported to a new introspect-secret-guarded gate endpoint `POST /refusals`, which writes the governor's existing denied-ledger row (`reserveLease` with zero caps).

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, service bindings (`Fetcher`), TinyBase v9 `WsServerDurableObject`, Vitest with `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Runtime: Cloudflare Workers; DO state is SQLite via `ctx.storage.sql`. No KV, no JWTs for leases (opaque hashed tokens only) — verbatim from v1.
- The private stream (`julian/chat`) is bound to one principal; **never** readable by another principal or by a `reading-room` lease. This is the hard constraint.
- Single-writer memory: **a live sync socket requires `full-house` scope.** `stream-read` may read `/export` but never holds a socket; `reading-room` reaches neither. MCP-class leases must never open a write path.
- Every scope refusal is ledgered — now including sync-side refusals (403s and scope/ownership socket closes). A lost refusal report never widens access ("the refusal stands either way").
- Fail closed: an unreachable governor/gate refuses; a non-definitive introspection is `503`/WS `4002` ("unavailable"), never `401`/`4001` ("revoked"). Close code `4003` means scope/ownership lost, distinct from both.
- Sync→gate traffic goes through the `GATE` service binding, never a public URL — same-account `workers.dev` fetches do not route (issue #28, measured 2026-08-09).
- Lease scopes are exactly `reading-room`, `stream-read`, `full-house`. Scope semantics for broker verbs (2A's `SCOPE_VERBS`) are unchanged by this plan.
- Tests are concurrency-safe: unique ports/temp paths per test; no shared on-disk fixtures.
- Existing suites stay green (broker 174 + sync 45 at the 2A merge, `223d50f`); device-flow and legacy Pocket ID JWT behavior unchanged.

---

### Task 1: introspectLease through a service binding

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `sync/src/auth.ts`
- Modify: `sync/wrangler.toml`
- Modify: `sync/vitest.config.ts`
- Test: `sync/test/lease-introspect.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `interface GateFetcher { fetch(input: string | Request, init?: RequestInit): Promise<Response> }` (structurally compatible with a Cloudflare `Fetcher` binding); `introspectLease(token: string, gate: GateFetcher, secret: string): Promise<LeaseIntrospection>` (second parameter is now a fetcher, not a URL string); `Env` gains `GATE: GateFetcher` and loses `GATE_URL`.

**Parallelization rationale:** contract-first — fixing the fetcher-based signature as its own task lets the enforcement task (sync callers) and the gate endpoint task build in parallel against known shapes; a fetcher parameter is also the honest seam regardless of parallelism, since it makes introspection testable without `fetchMock` URL interception.

- [ ] **Step 1: Write the failing test** — rewrite the introspection-function tests in `sync/test/lease-introspect.test.ts` to inject a fake fetcher instead of intercepting a URL. Replace the existing `describe('introspectLease', …)` block's fetch plumbing with:

```ts
// A fake GATE binding: records requests, returns scripted responses.
function fakeGate(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const gate = {
    calls,
    fetch: async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
  return gate;
}

test('introspects through the gate binding, not a public URL', async () => {
  const gate = fakeGate(200, { active: true, lease_id: 'L1', door_name: 'door:x', scope: 'full-house', principal: 'julian' });
  const result = await introspectLease('jla_binding1', gate, 'test-secret');
  expect(result).toEqual({ active: true, leaseId: 'L1', doorName: 'door:x', scope: 'full-house', principal: 'julian' });
  expect(gate.calls[0].url).toBe('https://gate/introspect');
  expect(new Headers(gate.calls[0].init?.headers).get('X-Introspect-Secret')).toBe('test-secret');
});

test('a non-ok gate response throws (fail closed), never reads as revoked', async () => {
  const gate = fakeGate(500, {});
  await expect(introspectLease('jla_binding2', gate, 'test-secret')).rejects.toThrow('introspect: gate responded 500');
});
```

Update every existing call in this file from `introspectLease(token, GATE, 'test-secret')` (URL string) to pass a `fakeGate(...)` with the equivalent scripted response, and delete the `fetchMock` interception of the `GATE` URL for these function-level tests (keep `fetchMock` only if other tests in the file still need it; `beforeAll`/`afterEach` hooks may remain).

- [ ] **Step 2: Run to verify it fails**

Run: `cd sync && npx vitest run test/lease-introspect.test.ts`
Expected: FAIL (TypeScript/runtime: `introspectLease` still expects a URL string and calls global `fetch`).

- [ ] **Step 3: Implement** — in `sync/src/auth.ts`:

Add the fetcher type and change the signature (the cache, header, body, parsing, and error text are unchanged):

```ts
/** Structural type of a Cloudflare service binding (Fetcher). Tests inject fakes. */
export interface GateFetcher {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export async function introspectLease(
  token: string,
  gate: GateFetcher,
  secret: string,
): Promise<LeaseIntrospection> {
  // …cache lookup unchanged…
  const res = await gate.fetch('https://gate/introspect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Introspect-Secret': secret,
    },
    body: new URLSearchParams({ token }),
  });
  // …!res.ok throw, body parsing, cache set — all unchanged…
}
```

(The URL's host is ignored by a service binding — `https://gate/` is a conventional placeholder. Only the path matters.)

In the `Env` interface in the same file: remove `GATE_URL: string;` and add `GATE: GateFetcher;`.

In `sync/wrangler.toml`: remove the `GATE_URL` line from `[vars]` and add:

```toml
# Sync reaches the gate in-process; same-account workers.dev fetches do not
# route (issue #28) — the binding is the only road.
[[services]]
binding = "GATE"
service = "julian-broker"
```

In `sync/vitest.config.ts`: the test runtime cannot resolve a service binding to the separately-deployed `julian-broker`, so give workerd a stub for boot (tests never exercise it — they inject fakes or stub `introspectLease`):

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          serviceBindings: {
            // Boot-time stub for the GATE binding; individual tests inject
            // their own fakes into env. 500 keeps any accidental use fail-closed.
            GATE: () => new Response('gate stub: not wired in tests', { status: 500 }),
          },
        },
      },
    },
  },
});
```

If the pool reports a duplicate/unresolvable `GATE` binding at startup, the miniflare override is authoritative — adjust per the pool's error message (this is the only step where the exact incantation may vary by pool version; the acceptance is that the suite boots and passes).

Note: `sync/src/index.ts` and `sync/src/do.ts` still reference `env.GATE_URL` after this task — they are updated by the sync-enforcement task. To keep this task's tree green in isolation, leave a deprecated optional field `GATE_URL?: string` on `Env` **only if** the compiler forces it; prefer updating nothing outside this task's files and accepting that the full cross-file typecheck completes in the enforcement task. The suite (vitest, esbuild-stripped) stays green either way.

- [ ] **Step 4: Run to verify it passes**

Run: `cd sync && npx vitest run test/lease-introspect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sync/src/auth.ts sync/wrangler.toml sync/vitest.config.ts sync/test/lease-introspect.test.ts
git commit -m "gate 2B-pre: introspectLease goes through the GATE service binding (issue #28)"
```

---

### Task 2: Gate refusals endpoint — POST /refusals, introspect-secret guarded

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `broker/src/as/admin.ts`
- Modify: `broker/src/index.ts`
- Test: `broker/test/admin.test.ts`
- Test: `broker/test/routing.test.ts`

**Interfaces:**
- Consumes: `GovernorDO.reserveLease(leaseId, doorName, service, verb, detail, capPerDay, leaseCap)` — calling with both caps `0` writes one disallowed ledger row and spends no quota (the register's existing denied pen).
- Produces: `POST /refusals` on the gate, guarded by `X-Introspect-Secret` (same machine credential as `/introspect`), body `{ lease_id, door_name, service, verb, detail }` (all strings) → `200 {"recorded":true}`; missing/wrong secret → `401`; malformed body → `400`; governor unreachable → `503`.

**Parallelization rationale:** the reporting endpoint is a pure broker-side contract with no sync dependency; landing it in parallel with the binding task gives the enforcement task both of its contracts at once. A good engineer isolates it regardless: it is the machine face's concern, not the router's.

- [ ] **Step 1: Write the failing tests** — in `broker/test/admin.test.ts` (follow the file's existing `handleAdmin` invocation pattern and its introspect-secret fixtures):

```ts
describe('POST /refusals (sync-side refusal ledger)', () => {
  const refusalReq = (body: unknown, secret?: string) =>
    new Request('https://gate/refusals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Introspect-Secret': secret } : {}),
      },
      body: JSON.stringify(body),
    });
  const goodBody = {
    lease_id: 'L1', door_name: 'door:x', service: 'stream', verb: 'socket',
    detail: 'refused: scope stream-read may not hold a socket',
  };

  it('without the introspect secret is refused 401', async () => {
    const res = await handleAdmin(refusalReq(goodBody), env, gov);
    expect(res.status).toBe(401);
  });
  it('with a wrong secret is refused 401', async () => {
    const res = await handleAdmin(refusalReq(goodBody, 'wrong'), env, gov);
    expect(res.status).toBe(401);
  });
  it('records a disallowed ledger row and returns 200', async () => {
    const res = await handleAdmin(refusalReq(goodBody, env.INTROSPECT_SECRET), env, gov);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    const entries = await gov.entries(5);
    const row = entries.find((e) => e.sub === 'lease:L1' && e.verb === 'socket');
    expect(row?.allowed).toBe(0);
    expect(row?.service).toBe('stream');
  });
  it('malformed body is 400, nothing ledgered', async () => {
    const res = await handleAdmin(refusalReq({ lease_id: 42 }, env.INTROSPECT_SECRET), env, gov);
    expect(res.status).toBe(400);
  });
});
```

In `broker/test/routing.test.ts`, assert the worker routes `/refusals` to the machine face (a plain lease token is not the machine credential):

```ts
it('/refusals is introspect-secret territory, not a lease verb', async () => {
  const res = await worker.fetch(new Request('https://gate/refusals', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lease_id: 'x', door_name: 'y', service: 'stream', verb: 'socket', detail: 'z' }),
  }), env);
  expect(res.status).toBe(401);
});
```

(Adapt fixture names — `env`, `gov`, `accessToken` — to the identifiers those files already use for the same things; both files mint leases and call `handleAdmin` today.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd broker && npx vitest run test/admin.test.ts test/routing.test.ts -t refusal`
Expected: FAIL (404 — no such route).

- [ ] **Step 3: Implement** — in `broker/src/as/admin.ts`:

Add the handler (reuse the same timing-safe secret check the `introspect` handler uses — factor the check into a small helper if the file doesn't have one already):

```ts
/** Sync-side refusals arrive here; the row is the same denied pen the broker's
 *  own verb path uses (reserveLease with zero caps): one disallowed entry, no
 *  quota spent. Guarded by the machine credential, like /introspect. */
async function recordRefusal(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const presented = req.headers.get('X-Introspect-Secret') ?? '';
  if (!env.INTROSPECT_SECRET || !timingSafeEqual(presented, env.INTROSPECT_SECRET)) {
    return json({ error: 'no machine credential' }, 401);
  }
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: 'body must be JSON' }, 400); }
  const b = body as Record<string, unknown>;
  const fields = ['lease_id', 'door_name', 'service', 'verb', 'detail'] as const;
  if (!fields.every((f) => typeof b[f] === 'string' && (b[f] as string).length > 0)) {
    return json({ error: 'lease_id, door_name, service, verb, detail — all required strings' }, 400);
  }
  try {
    await gov.reserveLease(b.lease_id as string, b.door_name as string, b.service as string, b.verb as string, b.detail as string, 0, 0);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  return json({ recorded: true });
}
```

Route it in `handleAdmin`, before the `authorizeRegister` block (it carries its own guard):

```ts
if (path === '/refusals') {
  if (req.method !== 'POST') return json({ error: 'refusals are POSTed' }, 405);
  return recordRefusal(req, env, gov);
}
```

In `broker/src/index.ts`, extend the admin-face route condition:

```ts
if (path === '/introspect' || path === '/refusals' || path === '/leases' || path.startsWith('/leases/') || path === '/ledger') {
  return handleAdmin(req, env, gov);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd broker && npx vitest run`
Expected: PASS (new tests plus every pre-existing broker suite).

- [ ] **Step 5: Commit**

```bash
git add broker/src/as/admin.ts broker/src/index.ts broker/test/admin.test.ts broker/test/routing.test.ts
git commit -m "gate 2B-pre: POST /refusals — sync-side refusals land in the governor ledger"
```

---

### Task 3: Sync enforcement — sockets are full-house-only, callers use the binding, refusals reported

**Type:** implementation
**Depends-on:** 1, 2
**Review:** adversarial

**Files:**
- Modify: `sync/src/index.ts`
- Modify: `sync/src/do.ts`
- Test: `sync/test/router-scope.test.ts`
- Test: `sync/test/do-scope.test.ts`

**Interfaces:**
- Consumes: `introspectLease(token, gate: GateFetcher, secret)` and `Env.GATE` (from Task 1); `POST /refusals` with body `{ lease_id, door_name, service, verb, detail }` guarded by `X-Introspect-Secret` (from Task 2).
- Produces: the router refuses any non-`full-house` lease at the WS upgrade (403) while `/export` keeps accepting `stream-read` + `full-house`; the DO's traffic-driven re-auth closes any socket whose lease is not `full-house` (4003) and any socket whose principal no longer owns the store path (4003); every sync-side refusal fire-and-forgets a `/refusals` report through the gate binding.

- [ ] **Step 1: Write the failing tests.**

In `sync/test/router-scope.test.ts` — the introspection stub changes shape: instead of `fetchMock` intercepting `GATE_URL`, inject a fake `GATE` fetcher into the env (drop the `fetchMock` plumbing for these tests). Replace the `testEnv()` helper's `e.GATE_URL = GATE` line with a recording fake:

```ts
// Records every call to the gate binding; scripts /introspect, accepts /refusals.
function fakeGateEnv(introspection: {
  active: boolean; lease_id?: string; door_name?: string; scope?: string; principal?: string;
}) {
  const refusals: unknown[] = [];
  const gate = {
    fetch: async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (new URL(url).pathname === '/refusals') {
        refusals.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ recorded: true }), { status: 200 });
      }
      return new Response(JSON.stringify(introspection), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    },
  };
  const e = env as unknown as Env;
  e.INTROSPECT_SECRET = 'test-secret';
  return { env: Object.assign(Object.create(null), e, { GATE: gate }) as unknown as Env, refusals };
}
```

New/updated assertions (unique `jla_` tokens per test — the introspect cache is keyed by token):

```ts
it('stream-read is accepted at export', async () => {
  const { env: e } = fakeGateEnv({ active: true, lease_id: 'L10', door_name: 'door:t', scope: 'stream-read', principal: 'julian' });
  const res = await worker.fetch(exportReq('jla_sockpolicy1'), withFakeStub(e));
  expect(res.status).not.toBe(403);
});
it('stream-read is refused at the WS upgrade — sockets are full-house-only', async () => {
  const { env: e, refusals } = fakeGateEnv({ active: true, lease_id: 'L11', door_name: 'door:t', scope: 'stream-read', principal: 'julian' });
  const res = await worker.fetch(wsUpgradeReq('jla_sockpolicy2'), e);
  expect(res.status).toBe(403);
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toMatchObject({ lease_id: 'L11', service: 'stream', verb: 'socket' });
});
it('full-house is accepted at the WS upgrade', async () => {
  const { env: e } = fakeGateEnv({ active: true, lease_id: 'L12', door_name: 'door:t', scope: 'full-house', principal: 'julian' });
  const res = await worker.fetch(wsUpgradeReq('jla_sockpolicy3'), withFakeStub(e));
  expect(res.status).not.toBe(403);
});
it('a foreign-principal refusal is reported to the gate ledger', async () => {
  const { env: e, refusals } = fakeGateEnv({ active: true, lease_id: 'L13', door_name: 'door:t', scope: 'full-house', principal: 'guest-ada' });
  const res = await worker.fetch(exportReq('jla_sockpolicy4'), e);
  expect(res.status).toBe(403);
  expect(refusals[0]).toMatchObject({ lease_id: 'L13', service: 'stream', verb: 'export' });
});
```

(`exportReq`/`wsUpgradeReq` are this file's existing request builders; `withFakeStub` is its existing fake-DO-namespace wrapper, whatever it is currently named — reuse, don't duplicate. Keep the existing reading-room tests: they must still 403 at both surfaces.)

In `sync/test/do-scope.test.ts`, the same stub-shape change (the DO test file stubs introspection today — convert its stub to a fake `GATE` fetcher on the DO's env), plus:

```ts
it('closes a socket whose lease is no longer full-house — stream-read mid-socket is 4003', async () => {
  // socket attached full-house; re-auth introspects to stream-read:
  stubGate({ active: true, lease_id: 'L20', door_name: 'door:t', scope: 'stream-read', principal: 'julian' });
  const close = await sendAfterReauthWindow(ws);
  expect(close.code).toBe(4003);
});
it('closes a socket whose principal no longer owns the store — 4003', async () => {
  stubGate({ active: true, lease_id: 'L21', door_name: 'door:t', scope: 'full-house', principal: 'guest-ada' });
  const close = await sendAfterReauthWindow(ws);
  expect(close.code).toBe(4003);
});
```

(`stubGate`/`sendAfterReauthWindow` are the do-scope file's existing helpers under whatever names it uses — adapt, and keep its existing 4001/4002/4003 assertions passing; reading-room mid-socket must still close 4003, an unreachable gate must still close 4002.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd sync && npx vitest run test/router-scope.test.ts test/do-scope.test.ts`
Expected: FAIL (stream-read still accepted at upgrade; `introspectLease` call sites still pass `GATE_URL`; no refusal reports exist).

- [ ] **Step 3: Implement.**

In `sync/src/index.ts`:

```ts
// Scopes that may read the export snapshot. The SOCKET is stricter: TinyBase
// sync is bidirectional by design (a socket client can push ContentDiff /
// ContentHashes and answer diff requests, and the DO relays client↔client),
// so a live socket is a WRITE surface and requires full-house. stream-read
// gets /export now and request/response verbs in Plan B — never a socket.
const EXPORT_SCOPES = new Set(['stream-read', 'full-house']);
const SOCKET_SCOPE = 'full-house';
```

Give the handler its context parameter and a reporting helper:

```ts
async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
```

```ts
// Fire-and-forget: the refusal stands whether or not the report lands.
function reportRefusal(
  env: Env, ctx: ExecutionContext | undefined,
  leaseId: string, doorName: string, verb: 'export' | 'socket', detail: string,
): void {
  const p = env.GATE.fetch('https://gate/refusals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Introspect-Secret': env.INTROSPECT_SECRET },
    body: JSON.stringify({ lease_id: leaseId, door_name: doorName, service: 'stream', verb, detail }),
  }).then(() => undefined).catch(() => undefined);
  ctx?.waitUntil ? ctx.waitUntil(p) : void p;
}
```

Replace the introspection call and the scope/principal block:

```ts
introspection = await introspectLease(headerToken, env.GATE, env.INTROSPECT_SECRET);
```

```ts
const verb = parsed.isExport ? 'export' : 'socket';
const allowed = parsed.isExport
  ? EXPORT_SCOPES.has(introspection.scope ?? '')
  : introspection.scope === SOCKET_SCOPE;
if (!allowed) {
  reportRefusal(env, ctx, introspection.leaseId ?? '', introspection.doorName ?? '', verb,
    `refused: scope ${introspection.scope} may not stream.${verb}`);
  return new Response(
    parsed.isExport ? 'this lease may not read the stream' : 'a sync socket requires full-house',
    { status: 403 });
}
const storeOwner = parsed.store;
if ((introspection.principal ?? '') !== storeOwner) {
  reportRefusal(env, ctx, introspection.leaseId ?? '', introspection.doorName ?? '', verb,
    `refused: principal ${introspection.principal} does not own ${storeOwner}`);
  return new Response('this lease does not own this store', { status: 403 });
}
```

In `sync/src/do.ts`, the re-auth block: pass the binding, tighten the socket scope, add the ownership re-check, and report:

```ts
introspection = await introspectLease(attachment.leaseToken, this.env.GATE, this.env.INTROSPECT_SECRET);
```

```ts
// A socket is a write surface: only full-house holds one. Scope- or
// ownership-lost is 4003 — distinct from revoked (4001) and unavailable (4002).
const owner = (this.getPathId() ?? '').split('/')[0];
const scopeOk = introspection.scope === 'full-house';
const ownerOk = (introspection.principal ?? '') === owner;
if (!scopeOk || !ownerOk) {
  void this.env.GATE.fetch('https://gate/refusals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Introspect-Secret': this.env.INTROSPECT_SECRET },
    body: JSON.stringify({
      lease_id: introspection.leaseId ?? '', door_name: introspection.doorName ?? '',
      service: 'stream', verb: 'socket',
      detail: scopeOk
        ? `refused: principal ${introspection.principal} does not own ${owner}`
        : `refused: scope ${introspection.scope} may not hold a socket`,
    }),
  }).catch(() => undefined);
  ws.close(4003, scopeOk ? 'lease does not own this store' : 'a sync socket requires full-house');
  return;
}
```

Delete the now-unused `STREAM_SCOPES` set in `do.ts` (its policy is `full-house` equality now) and update the comment block above it accordingly. In both files, remove any remaining `GATE_URL` reference; if Task 1 left a deprecated `GATE_URL?: string` on `Env`, delete it now — after this task, `npx tsc --noEmit` in `sync/` must report no error originating in `src/` or the four test files this plan touches.

- [ ] **Step 4: Run to verify they pass**

Run: `cd sync && npx vitest run`
Expected: PASS — new assertions plus every pre-existing sync suite (legacy JWT path untouched; 4001/4002 semantics unchanged).

- [ ] **Step 5: Commit**

```bash
git add sync/src/index.ts sync/src/do.ts sync/test/router-scope.test.ts sync/test/do-scope.test.ts
git commit -m "gate 2B-pre: sockets are full-house-only; sync refusals reach the ledger via the GATE binding"
```

---

### Task 4: Verification gate — full regression, both packages

**Type:** gate
**Depends-on:** 1, 2, 3

**Files:**
- Test: (runs the existing suites; adds no implementation)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: green evidence that the three preconditions are closed and nothing regressed.

- [ ] **Step 1: Run the broker suite**

Run: `cd broker && npx vitest run`
Expected: PASS — including the new `/refusals` tests and every unchanged 2A/device-flow suite.

- [ ] **Step 2: Run the sync suite**

Run: `cd sync && npx vitest run`
Expected: PASS — including the reshaped `router-scope`/`do-scope`/`lease-introspect` suites.

- [ ] **Step 3: Confirm the precondition invariants by present tests**

Confirm each of these is asserted by a passing test: `introspectLease` goes through the injected gate binding (Task 1); a non-ok gate response throws and reads as 503/4002, never 401/4001 (Task 1 + pre-existing do-scope assertion); `stream-read` is accepted at `/export` and refused at the WS upgrade (Task 3); `full-house` is accepted at the upgrade (Task 3); a mid-socket downgrade to any non-`full-house` scope closes 4003 (Task 3); a mid-socket ownership loss closes 4003 (Task 3); router-side refusals POST `/refusals` with `service: 'stream'` (Task 3); `/refusals` requires the introspect secret and writes a disallowed ledger row (Task 2). If any is missing, the plan is not done — add the assertion to the owning task's suite.

**Acceptance:** suite — the three preconditions are enforced at unit/integration-testable seams and per-task adversarial review covers the auth surface; the live wire proof (a real lease token reading `/export` end-to-end through the deployed binding) is deliberately a post-merge deploy probe, recorded in the runbook below. No sealed exam requested.

## Post-merge runbook (deploy is the live proof for issue #28)

Deploy order: `wrangler deploy` in `broker/` then `sync/` (sync's new binding references the broker service; the broker must carry `/refusals` before sync starts reporting to it). Then, at the operator's word:

1. **The issue #28 closure probe** — from the Mac (mac-home lease, `full-house`): mint a token from the loopback holder (`curl -s http://127.0.0.1:8377/lease/token`, field `access_token`) and GET `https://julian-sync.julian-memory.workers.dev/julian/store/export` with it as a Bearer. Expected: **200 with the store export** — the exact request that 503'd on 2026-08-09. Close issue #28 with the evidence.
2. Both living doors (`mac-home`, `julian-new-web`, both `full-house`) keep their sockets and the web app still syncs (legacy JWT path untouched).
3. One authenticated `GET /leases` (breakglass header `X-Breakglass-Secret`) still lists the register; then `GET /ledger?limit=10` via an approver credential after step 1's refusal rehearsal (optional): a deliberately mis-scoped request should now leave a visible disallowed row.
