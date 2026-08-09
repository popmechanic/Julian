# Gate Phase 2A — Register Safety & Scope Foundation Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every consumer of the shared lease register derive authority from `(scope, principal)`, not mere liveness — closing the critical hole the adversarial review found (a `reading-room` token reaching the private stream through sync's own front door) and laying the multiplayer-safety seam, before the MCP face (Plan B) mints any lease.

**Architecture:** The broker's `GovernorDO` already returns a lease's `scope`; this phase adds a `principal` (default `julian`) and a `flow` marker via a guarded live-DO migration, threads both through introspection, and teaches the sync worker to refuse any lease whose scope is not stream-capable and whose principal does not own the requested store. The scope→verb map is rewritten so `reading-room` grants package reads only (mail verbs move to `full-house`), and `stream-read` is added. No MCP-face code ships here.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects (SQLite storage), TinyBase (sync store), Vitest with `@cloudflare/vitest-pool-workers`, `jose` (JWT), `bun` (test runner scripts).

## Global Constraints

- Runtime: Cloudflare Workers; DO state is SQLite via `ctx.storage.sql`. No KV, no JWTs for leases (opaque hashed tokens only) — verbatim from v1.
- The private stream (`julian/chat`) is bound to one principal; **never** readable by another principal or by a `reading-room` lease. This is the hard constraint.
- Single-writer memory: no new write path into the stream. MCP-class leases must never open a write socket.
- Fail closed: an unreachable governor/gate refuses; a non-definitive introspection is `503`/WS `4002` ("unavailable"), never `401`/`4001` ("revoked") — verbatim from v1's `introspectLease` contract.
- TinyBase persister stays `mode: 'fragmented'`, tinybase ≥ v9 — the on-disk layout is breaking; never downgrade.
- Lease scopes are exactly `reading-room`, `stream-read`, `full-house`. `reading-room` grants package verbs only. Every scope refusal is ledgered.
- Tests are concurrency-safe: unique ports/temp paths per test; no shared on-disk fixtures.
- Existing suites stay green (592 tests at v1 merge); device-flow behavior unchanged.

---

### Task 1: Scope→verb map — reading-room is package-only, add stream-read

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `broker/src/lease-auth.ts`
- Test: `broker/test/lease-auth.test.ts`

**Interfaces:**
- Produces: `scopeAllows(scope: string, service: string, verb: string): boolean` (unchanged signature); the `SCOPE_VERBS` map now keyed `reading-room`→package verbs only, `stream-read`→package+stream, `full-house`→package+stream+mail.
- Consumes: nothing new.

**Parallelization rationale:** the verb map is the contract every enforcement task reads; fixing it as its own early task (own file) lets the governor migration build in parallel and lets the invariant test in the gate assert against a single source of truth.

- [ ] **Step 1: Write the failing test** — add to `broker/test/lease-auth.test.ts`:

```ts
import { scopeAllows } from '../src/lease-auth';

describe('scope→verb map (phase 2A)', () => {
  it('reading-room grants package reads only — no mail, no stream', () => {
    expect(scopeAllows('reading-room', 'package', 'list')).toBe(true);
    expect(scopeAllows('reading-room', 'package', 'read')).toBe(true);
    expect(scopeAllows('reading-room', 'mail', 'read')).toBe(false);
    expect(scopeAllows('reading-room', 'mail', 'list')).toBe(false);
    expect(scopeAllows('reading-room', 'mail', 'send')).toBe(false);
    expect(scopeAllows('reading-room', 'stream', 'recent')).toBe(false);
  });
  it('stream-read grants package + stream, never mail', () => {
    expect(scopeAllows('stream-read', 'package', 'read')).toBe(true);
    expect(scopeAllows('stream-read', 'stream', 'recent')).toBe(true);
    expect(scopeAllows('stream-read', 'stream', 'session')).toBe(true);
    expect(scopeAllows('stream-read', 'stream', 'search')).toBe(true);
    expect(scopeAllows('stream-read', 'mail', 'send')).toBe(false);
  });
  it('full-house grants everything including mail and stream', () => {
    expect(scopeAllows('full-house', 'mail', 'send')).toBe(true);
    expect(scopeAllows('full-house', 'stream', 'recent')).toBe(true);
    expect(scopeAllows('full-house', 'package', 'read')).toBe(true);
  });
  it('unknown scope buys nothing', () => {
    expect(scopeAllows('nonsense', 'package', 'read')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && npx vitest run test/lease-auth.test.ts -t "scope→verb map"`
Expected: FAIL (reading-room still grants mail; stream/package verbs unknown).

- [ ] **Step 3: Rewrite `SCOPE_VERBS`** in `broker/src/lease-auth.ts`, replacing the existing map:

```ts
/** What each scope may ask for. Unknown scopes buy nothing.
 *  reading-room = the public identity package only (attribution, not confidentiality).
 *  stream-read  = package + the private live record, read-only.
 *  full-house   = everything, incl. mail verbs — held by home doors, not MCP leases. */
const PACKAGE_VERBS = ['package.list', 'package.read'] as const;
const STREAM_VERBS = ['stream.recent', 'stream.session', 'stream.search'] as const;
const MAIL_VERBS = ['mail.send', 'mail.list', 'mail.read', 'mail.health'] as const;

const SCOPE_VERBS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'reading-room': Object.freeze([...PACKAGE_VERBS]),
  'stream-read': Object.freeze([...PACKAGE_VERBS, ...STREAM_VERBS]),
  'full-house': Object.freeze([...PACKAGE_VERBS, ...STREAM_VERBS, ...MAIL_VERBS]),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && npx vitest run test/lease-auth.test.ts`
Expected: PASS (including the pre-existing lease-auth tests — check none asserted reading-room granting mail; if one does, it encoded the old model and must be updated to the new invariant, since reading-room granting mail is the exact bug being closed).

- [ ] **Step 5: Commit**

```bash
git add broker/src/lease-auth.ts broker/test/lease-auth.test.ts
git commit -m "gate 2A: reading-room is package-only; add stream-read scope"
```

---

### Task 2: Governor migration — principal + flow columns, principal in identity

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `broker/src/governor.ts`
- Test: `broker/test/governor.test.ts`
- Test: `broker/test/governor-migration.test.ts`

**Interfaces:**
- Produces: `LeaseIdentity` gains `principal: string`; `validateAccess(token): Promise<LeaseIdentity | null>` returns it; `LeaseScope` type includes `'stream-read'`; the `SCOPES` runtime array includes `'stream-read'`; new leases and the legacy pseudo-lease carry `principal='julian'`, `flow` (`'device'` default). A guarded constructor migration adds `principal` and `flow` columns to a pre-existing `leases` table.
- Consumes: nothing from other tasks.

**Parallelization rationale:** the storage/identity contract is independent of the verb map (different file, different concern); fixing `principal` on `LeaseIdentity` up front lets register-hardening and sync enforcement build against a known identity shape.

- [ ] **Step 1: Write the failing migration test** — create `broker/test/governor-migration.test.ts`. It builds a v1-shaped `leases` table (no `principal`/`flow`), then instantiates `GovernorDO` and asserts the columns exist and default correctly. Use the project's existing DO test harness pattern (see `governor-leases.test.ts` for how `GovernorDO` is constructed under `@cloudflare/vitest-pool-workers`); the assertion:

```ts
// After seeding a v1-shaped leases table (columns through send_cap_per_day only)
// and constructing GovernorDO over it:
it('migrates a v1 leases table to carry principal and flow', async () => {
  const cols = await gov.__columnsOf('leases'); // test-only helper added in Step 3
  expect(cols).toContain('principal');
  expect(cols).toContain('flow');
  const legacy = await gov.leaseList();
  const win = legacy.find((l) => l.leaseId === 'legacy-window');
  expect(win?.principal).toBe('julian'); // LeaseSummary gains principal too
});
```

Also add to `governor.test.ts`:

```ts
it('validateAccess returns principal on a living lease', async () => {
  // mint a lease via the existing knock→approve→devicePoll path used in governor-leases.test.ts,
  // then:
  const id = await gov.validateAccess(accessToken);
  expect(id?.principal).toBe('julian');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd broker && npx vitest run test/governor-migration.test.ts test/governor.test.ts -t principal`
Expected: FAIL (no `principal` column / not on identity).

- [ ] **Step 3: Add the guarded migration and thread `principal`** in `broker/src/governor.ts`:

In the constructor, after the `CREATE TABLE IF NOT EXISTS leases (...)` call, add an idempotent column migration (SQLite `ALTER TABLE ADD COLUMN` is a no-op-unsafe if the column exists, so guard via `PRAGMA table_info`):

```ts
const leaseCols = new Set(
  (sql.exec('PRAGMA table_info(leases)').toArray() as Array<{ name: string }>).map((r) => r.name),
);
if (!leaseCols.has('principal')) {
  sql.exec("ALTER TABLE leases ADD COLUMN principal TEXT NOT NULL DEFAULT 'julian'");
}
if (!leaseCols.has('flow')) {
  sql.exec("ALTER TABLE leases ADD COLUMN flow TEXT NOT NULL DEFAULT 'device'");
}
```

Add `principal: string` to the `LeaseIdentity` interface and `principal` + `flow` to `LeaseSummary`. Update `validateAccess`'s SELECT to include `l.principal AS principal` and return it. Update `leaseList`'s SELECT + mapping to include `principal` and `flow`. Add `'stream-read'` to the `SCOPES` array and the `LeaseScope` union. Add a **test-only** accessor:

```ts
/** Test seam: column names of a table, for migration assertions. */
__columnsOf(table: 'leases' | 'lease_tokens' | 'knocks' | 'ledger'): string[] {
  return (this.sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{ name: string }>).map((r) => r.name);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd broker && npx vitest run test/governor-migration.test.ts test/governor.test.ts test/governor-leases.test.ts`
Expected: PASS (all governor suites, including the migration and unchanged device-flow behavior).

- [ ] **Step 5: Commit**

```bash
git add broker/src/governor.ts broker/test/governor-migration.test.ts broker/test/governor.test.ts
git commit -m "gate 2A: governor migration — principal + flow columns, principal in identity"
```

---

### Task 3: Register hardening — introspection carries principal; /ledger approver-gated

**Type:** implementation
**Depends-on:** 2
**Review:** adversarial

**Files:**
- Modify: `broker/src/as/admin.ts`, `broker/src/index.ts`
- Test: `broker/test/admin.test.ts`, `broker/test/routing.test.ts`

**Interfaces:**
- Consumes: `LeaseIdentity.principal` (from Task 2).
- Produces: `POST /introspect` response JSON gains `principal`; `GET /ledger` is served inside `handleAdmin`, gated by `authorizeRegister` (breakglass secret or approver session), removed from the unauthenticated verb path.

- [ ] **Step 1: Write the failing tests** — in `broker/test/admin.test.ts`:

```ts
it('introspect returns principal for a living lease', async () => {
  const res = await handleAdmin(introspectReq(accessToken), env, gov);
  const body = await res.json();
  expect(body).toMatchObject({ active: true, scope: expect.any(String), principal: 'julian' });
});
it('/ledger without approver credential is refused', async () => {
  const res = await handleAdmin(new Request('https://gate/ledger'), env, gov);
  expect(res.status).toBe(401);
});
it('/ledger with an approver session returns entries', async () => {
  const res = await handleAdmin(ledgerReqWithApproverCookie(), env, gov);
  expect(res.status).toBe(200);
  expect((await res.json()).entries).toBeInstanceOf(Array);
});
```

In `broker/test/routing.test.ts`, assert `/ledger` is routed to the admin face (no longer reachable via a plain lease token):

```ts
it('/ledger is an approver-gated register action, not a lease verb', async () => {
  const res = await worker.fetch(new Request('https://gate/ledger', {
    headers: { Authorization: `Bearer ${readingRoomAccessToken}` },
  }), env);
  expect(res.status).toBe(401); // a lease token is not an approver credential
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd broker && npx vitest run test/admin.test.ts test/routing.test.ts -t "principal|ledger"`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `broker/src/as/admin.ts`:

Add `principal` to the introspect success body:

```ts
return json({
  active: true,
  lease_id: identity.leaseId,
  door_name: identity.doorName,
  scope: identity.scope,
  principal: identity.principal,
});
```

Add a ledger reader gated by `authorizeRegister`, and route it in `handleAdmin` alongside `/leases`:

```ts
async function readLedger(req: Request, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const limit = parseInt(new URL(req.url).searchParams.get('limit') ?? '50', 10) || 50;
  try {
    return json({ entries: await gov.entries(limit) });
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
}
```

In `handleAdmin`, extend the authorized register block to include `/ledger`:

```ts
if (path === '/leases' || path === '/leases/revoke' || path === '/leases/export' || path === '/ledger') {
  const authorized = await authorizeRegister(req, env);
  if (!authorized) return json({ error: NO_CREDENTIAL }, 401);
  if (path === '/ledger' && req.method === 'GET') return readLedger(req, gov);
  // ...existing /leases branches...
}
```

In `broker/src/index.ts`: add `/ledger` to the admin face route condition and **remove** the old unauthenticated `/ledger` block from the post-authenticate verb section:

```ts
if (path === '/introspect' || path === '/leases' || path.startsWith('/leases/') || path === '/ledger') {
  return handleAdmin(req, env, gov);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd broker && npx vitest run test/admin.test.ts test/routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker/src/as/admin.ts broker/src/index.ts broker/test/admin.test.ts broker/test/routing.test.ts
git commit -m "gate 2A: introspect carries principal; /ledger approver-gated"
```

---

### Task 4: Sync router — enforce scope and principal

**Type:** implementation
**Depends-on:** 3
**Review:** adversarial

**Files:**
- Modify: `sync/src/index.ts`
- Modify: `sync/src/auth.ts`
- Test: `sync/test/router-scope.test.ts`

Follow the existing sync test harness for the `OIDC_JWKS_JSON` seam and how `introspectLease` is stubbed — `sync/test/lease-introspect.test.ts` is the closest existing pattern (it already mocks the gate's `/introspect`), with `sync/test/routing.test.ts` for router-level request shaping.

**Interfaces:**
- Consumes: the introspection response's `scope` and `principal` fields (from Task 3, surfaced through `LeaseIntrospection`).
- Produces: sync refuses `reading-room` leases at both `/…/export` and the WS upgrade (403); refuses any lease whose `principal` does not own the requested store (403); `stream-read` and `full-house` are accepted for reads.

**Parallelization rationale:** router-level scope/principal enforcement (sync/index.ts + the introspection type) is a distinct file and concern from the DO socket path (Task 5); splitting lets the two enforcement points build and test in parallel once the introspection contract exists.

- [ ] **Step 1: Write failing tests** — `sync/test/router-scope.test.ts`. Stub `introspectLease` to return each scope/principal combination and assert the router's verdict:

```ts
it('reading-room lease is refused at export (identity-only never reads the stream)', async () => {
  stubIntrospect({ active: true, leaseId: 'L1', scope: 'reading-room', principal: 'julian' });
  const res = await worker.fetch(exportReq('jla_x'), env);
  expect(res.status).toBe(403);
});
it('reading-room lease is refused at the WS upgrade', async () => {
  stubIntrospect({ active: true, leaseId: 'L1', scope: 'reading-room', principal: 'julian' });
  const res = await worker.fetch(wsUpgradeReq('jla_x'), env);
  expect(res.status).toBe(403);
});
it('stream-read lease is accepted for export', async () => {
  stubIntrospect({ active: true, leaseId: 'L2', scope: 'stream-read', principal: 'julian' });
  const res = await worker.fetch(exportReq('jla_y'), env);
  expect(res.status).not.toBe(403);
});
it('a lease whose principal does not own the store is refused', async () => {
  stubIntrospect({ active: true, leaseId: 'L3', scope: 'stream-read', principal: 'guest-ada' });
  const res = await worker.fetch(exportReq('jla_z'), env); // store path julian/chat, owner 'julian'
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd sync && npx vitest run test/router-scope.test.ts`
Expected: FAIL (sync currently accepts any active lease).

- [ ] **Step 3: Implement** — in `sync/src/auth.ts`, add `principal` to `LeaseIntrospection` and to the parsed body:

```ts
export interface LeaseIntrospection {
  active: boolean;
  leaseId?: string;
  doorName?: string;
  scope?: string;
  principal?: string;
}
// in introspectLease, extend the parsed body type and the active-result:
const result: LeaseIntrospection = body.active
  ? { active: true, leaseId: body.lease_id, doorName: body.door_name, scope: body.scope, principal: body.principal }
  : { active: false };
```

(The parsed body type in `introspectLease` gains `principal?: string`.)

In `sync/src/index.ts`, after `introspection.active` passes, enforce scope + principal before forwarding. The store's owning principal is derived from the store name (today `julian/chat` → owner `julian`); encode it explicitly:

```ts
const STREAM_SCOPES = new Set(['stream-read', 'full-house']);
// after the active check:
if (!STREAM_SCOPES.has(introspection.scope ?? '')) {
  return new Response('this lease may not read the stream', { status: 403 });
}
const storeOwner = parsed.store; // store segment is the owning principal ('julian')
if ((introspection.principal ?? '') !== storeOwner) {
  return new Response('this lease does not own this store', { status: 403 });
}
auth = { sub: `lease:${introspection.leaseId}` };
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd sync && npx vitest run`
Expected: PASS (new suite + existing sync suites green; legacy JWT path unchanged — it does not carry a lease scope and keeps its own path).

- [ ] **Step 5: Commit**

```bash
git add sync/src/index.ts sync/src/auth.ts sync/test/router-scope.test.ts
git commit -m "gate 2A: sync router enforces scope + principal on lease reads"
```

---

### Task 5: Sync DO — defense-in-depth scope check on the socket

**Type:** implementation
**Depends-on:** 3
**Review:** adversarial

**Files:**
- Modify: `sync/src/do.ts`
- Test: `sync/test/do-scope.test.ts`

**Interfaces:**
- Consumes: the introspection `scope` field (from Task 3, via `introspectLease` used inside the DO's traffic-driven re-auth).
- Produces: the DO independently closes any socket whose lease scope is not stream-capable — the router's check is no longer the only guard (review: "the DO's blanket 'trust the router' is unsafe once multiple scopes share the register"). No MCP-class lease can hold an open sync socket.

**Parallelization rationale:** the DO re-auth path is a separate file from the router and enforces at a different lifecycle point (per-message re-auth vs upgrade); an independent check here is genuine defense-in-depth a good engineer adds regardless of parallelism.

- [ ] **Step 1: Write the failing test** — `sync/test/do-scope.test.ts`. Drive a socket whose attachment re-introspects to a non-stream scope and assert it is closed `4003` (a new "scope lost" close code, distinct from `4001` revoked / `4002` unavailable):

```ts
it('closes a socket whose lease scope is no longer stream-capable', async () => {
  // socket attached with a lease that later introspects as reading-room:
  stubIntrospect({ active: true, leaseId: 'L1', scope: 'reading-room', principal: 'julian' });
  const close = await sendAfterReauthWindow(ws); // advance clock past REAUTH_INTERVAL_MS
  expect(close.code).toBe(4003);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sync && npx vitest run test/do-scope.test.ts`
Expected: FAIL (DO re-auth checks only `active`).

- [ ] **Step 3: Implement** — in `sync/src/do.ts` `webSocketMessage`, after the `introspection.active` check, add a scope check:

```ts
const STREAM_SCOPES = new Set(['stream-read', 'full-house']);
// inside the re-auth block, after the !active → 4001 branch:
if (!STREAM_SCOPES.has(introspection.scope ?? '')) {
  ws.close(4003, 'lease scope may not read the stream');
  return;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd sync && npx vitest run`
Expected: PASS (new suite + all existing sync suites green).

- [ ] **Step 5: Commit**

```bash
git add sync/src/do.ts sync/test/do-scope.test.ts
git commit -m "gate 2A: sync DO closes non-stream-scope sockets (defense in depth)"
```

---

### Task 6: Verification gate — full regression + the scope-invariant suite

**Type:** gate
**Depends-on:** 1, 2, 3, 4, 5

**Files:**
- Test: (runs the existing suites; adds no implementation)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: green evidence that the critical hole is closed and nothing regressed.

- [ ] **Step 1: Run the broker suite**

Run: `cd broker && npx vitest run`
Expected: PASS — all suites, including `lease-auth`, `governor`, `governor-migration`, `admin`, `routing`, and the unchanged device-flow/mail suites.

- [ ] **Step 2: Run the sync suite**

Run: `cd sync && npx vitest run`
Expected: PASS — including `router-scope` and `do-scope`.

- [ ] **Step 3: Confirm the closed-hole invariant end to end**

Confirm, by the tests present, that: a `reading-room` lease is refused at sync export (Task 4), at the WS upgrade (Task 4), and mid-socket (Task 5); a lease with a foreign `principal` is refused (Task 4); `reading-room` grants no mail or stream verb (Task 1); `/ledger` requires an approver credential (Task 3). If any is missing, the plan is not done — add the assertion to the owning task's suite.

**Acceptance:** suite — the register-safety invariants are directly unit/integration testable; per-task adversarial review plus the scope-invariant assertions in Tasks 1, 4, and 5 are the verification. No sealed exam requested.

## Post-merge runbook (no `release`/`manual` tasks in this phase)

This phase ships no new secrets, bindings, or deploy steps — it modifies existing broker and sync workers in place. Deploy is the normal `wrangler deploy` for `broker/` then `sync/`, in that order (sync consumes the broker's introspection contract), performed at the operator's word after the pre-merge gate. Live-probe after deploy: a `reading-room` lease (minted in Plan B, or a test lease) must 403 at `julian-sync/julian/store/export`; the two living home doors (`mac-home`, `julian-new-web`, both `full-house`) must keep their sockets. The DO migration runs lazily on first construction after deploy — verify with one authenticated `GET /leases` that existing leases report `principal: julian`.
