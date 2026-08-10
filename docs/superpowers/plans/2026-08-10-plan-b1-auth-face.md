# Plan B1 — The Auth Face (MCP knock: DCR + authorization-code flow)

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Acceptance:** suite — Marcus did not request sealing; the committed suite plus per-task adversarial review is the verification.

**Goal:** A standard MCP client can register (DCR), knock, and — on Marcus's approval — receive a scoped, capped `reading-room` lease token over an OAuth 2.1 authorization-code flow, with `full-house` structurally unmintable on this path, the consent flow bound to the approver's own browser, and the claude.ai refresh-fleet lease-kill closed.

**Architecture:** This is the first of three plans for the MCP face (spec `docs/superpowers/specs/2026-08-10-plan-b-mcp-face-spec.md`, rev 3). B1 builds only the auth face in the `julian-broker` worker — no sync changes, no new service binding, no MCP server, no package serving (those are B2/B3). A new `RegistrarDO` isolates DCR and pending-authcode state from `GovernorDO`; a new `as/authcode.ts` HTTP module adds `/register`, `/authorize`, and a `/token` authorization-code grant beside the existing device flow; the approval page gains a server-side-enforced scope election; and `GovernorDO` gains an authcode mint method plus a rotation reuse-grace for `flow='authcode'` leases. Deliverable is testable at the token level: a client obtains a Marcus-approved reading-room lease that the existing broker recognizes via `validateAccess`.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects (SQLite), `@cloudflare/vitest-pool-workers`, `jose` (already a dep, used for PKCE/JWKS in tests). No new runtime dependencies.

## Global Constraints

- **Worker name stays `julian-broker`** — URL stability for enrolled doors. Never rename.
- **Opaque tokens only, hashed at rest.** Lease tokens are `jla_…`/`jlr_…`; the DO stores only SHA-256 hashes (`governor.ts` `sha256Hex`). No JWTs minted by the gate, no KV, no plaintext secrets in any table.
- **Fail closed.** An unreachable `GovernorDO` or `RegistrarDO`, a missing secret, or any ambiguity refuses (503/401) and mints nothing. A missing `SESSION_SECRET`/`INTROSPECT_SECRET` never signs or authorizes.
- **Public clients only.** All three measured MCP clients register `token_endpoint_auth_method: "none"`; reject anything else. No client-secret handling.
- **PKCE S256 required** on the authcode flow; `plain` and absent are rejected. **RFC 8707 `resource`** is validated on `/authorize` and `/token`; the only acceptable value is the gate's own `/mcp` URL (`Env.MCP_RESOURCE_URL`).
- **`AUTHCODE_SCOPES = {reading-room, stream-read}`** is enforced **server-side in the DO mint method** — the absence of a `full-house` button is never the enforcement (review C2).
- **Approver allowlist is fail-closed** (`APPROVER_SUBS` empty/missing refuses everyone) and consulted at every act, exactly as `admin.ts isApprover` / `approve.ts` do today. The allowlist is **not** the homograph mitigation.
- **Marker/vocabulary:** an MCP session is a **visit**, never a "door" (`memory/the-visit.md`); leases minted here carry `flow='authcode'`. Ledger/lease vocabulary must not call them doors.
- **Test hygiene:** every test builds its own `Env` and scripts `GOVERNOR`/`REGISTRAR` stubs (the pattern in `broker/test/approve.test.ts` and `lease-auth.test.ts`); wrangler `[vars]` do not propagate through `SELF`. Same-wave suites run concurrently — no shared on-disk fixtures, unique ports/temp paths.

---

### Task 1: RegistrarDO + bindings (the isolated DCR/authcode store)

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Create: `broker/src/registrar.ts`
- Modify: `broker/wrangler.toml`
- Modify: `broker/src/env.ts`
- Modify: `broker/src/index.ts`
- Test: `broker/test/registrar-migration.test.ts`

`wrangler.toml` gains the DO binding + migration tag `v2`; `env.ts` gains `REGISTRAR` and `MCP_RESOURCE_URL`; `index.ts` gains the DO class export.

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `Env.REGISTRAR: DurableObjectNamespace`, `Env.MCP_RESOURCE_URL: string`.
  - `export class RegistrarDO extends DurableObject` exported from `broker/src/index.ts`, with two SQLite tables created in its constructor: `clients(client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, origin TEXT NOT NULL, created INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0)` and `authcodes(code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT NOT NULL, elected_scope TEXT, approver_sub TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)`.
  - `RegistrarDO.__columnsOf(table: 'clients' | 'authcodes'): string[]` test seam (mirrors `GovernorDO.__columnsOf`).
  - `RegistrarDO.now(): number` overridable clock (mirrors `GovernorDO.now`).

**Parallelization rationale:** front-loading the DO shell + bindings as one small task unblocks Task 2 (logic) and every consumer without any of them touching `wrangler.toml` again — the migration references the class, so class + binding + export must co-land, and isolating them here keeps later tasks single-file.

- [ ] **Step 1: Write the failing migration test**

```ts
// broker/test/registrar-migration.test.ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import type { RegistrarDO } from '../src/index';

describe('RegistrarDO schema', () => {
  test('creates clients and authcodes tables on fresh storage', async () => {
    const id = env.REGISTRAR.idFromName('t-registrar-fresh');
    const stub = env.REGISTRAR.get(id) as unknown as DurableObjectStub<RegistrarDO>;
    await runInDurableObject(stub, async (instance: RegistrarDO) => {
      expect(instance.__columnsOf('clients')).toEqual(
        expect.arrayContaining(['client_id', 'redirect_uris', 'origin', 'created', 'approved']),
      );
      expect(instance.__columnsOf('authcodes')).toEqual(
        expect.arrayContaining(['code_hash', 'client_id', 'redirect_uri', 'code_challenge',
          'resource', 'elected_scope', 'approver_sub', 'created', 'expires', 'used']),
      );
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd broker && npx vitest run test/registrar-migration.test.ts`
Expected: FAIL — `RegistrarDO` not exported / `REGISTRAR` binding undefined.

- [ ] **Step 3: Add the binding, migration, and env fields**

In `broker/wrangler.toml`, add a second DO binding and a `v2` migration (append after the existing `v1` block — never edit `v1`, an applied tag). Add the resource var:

```toml
[[durable_objects.bindings]]
name = "REGISTRAR"
class_name = "RegistrarDO"

[[migrations]]
tag = "v2"
new_sqlite_classes = ["RegistrarDO"]
```

Add to `[vars]`: `MCP_RESOURCE_URL = "https://julian-broker.julian-memory.workers.dev/mcp"`.

In `broker/src/env.ts` add to `Env`: `REGISTRAR: DurableObjectNamespace;` and `MCP_RESOURCE_URL: string;`.

- [ ] **Step 4: Write `RegistrarDO` (shell + schema) and export it**

```ts
// broker/src/registrar.ts
import { DurableObject } from 'cloudflare:workers';

export class RegistrarDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS clients (
      client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, origin TEXT NOT NULL,
      created INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS authcodes (
      code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL, resource TEXT NOT NULL, elected_scope TEXT,
      approver_sub TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0)`);
  }

  now(): number { return Date.now(); }
  private get sql(): SqlStorage { return this.ctx.storage.sql; }

  __columnsOf(table: 'clients' | 'authcodes'): string[] {
    if (!['clients', 'authcodes'].includes(table)) throw new Error('unknown table');
    return (this.sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{ name: string }>).map((r) => r.name);
  }
}
```

In `broker/src/index.ts`, beside `export { GovernorDO } from './governor';`, add `export { RegistrarDO } from './registrar';`.

- [ ] **Step 5: Run the test green**

Run: `cd broker && npx vitest run test/registrar-migration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add broker/src/registrar.ts broker/wrangler.toml broker/src/env.ts broker/src/index.ts broker/test/registrar-migration.test.ts
git commit -m "feat(gate): RegistrarDO shell + bindings (DCR/authcode store)"
```

---

### Task 2: RegistrarDO methods — DCR registration + pending authcodes

**Type:** implementation
**Depends-on:** 1
**Review:** adversarial

**Files:**
- Modify: `broker/src/registrar.ts`
- Test: `broker/test/registrar.test.ts`

**Interfaces:**
- Consumes: `RegistrarDO` class + tables (from Task 1).
- Produces (all `async`, on `RegistrarDO`):
  - `registerClient(meta: { redirect_uris: string[]; token_endpoint_auth_method: string; client_name?: string }): { client_id: string } | { error: string }` — rejects any `token_endpoint_auth_method !== 'none'`; requires ≥1 `https` or `http://localhost[:port]` redirect_uri; stores `origin` = decoded origin of the first redirect_uri; `approved=0`; sweeps `authcodes`/unapproved `clients` older than 2h on entry; returns a random `client_id`.
  - `createPending(p: { client_id: string; redirect_uri: string; code_challenge: string; resource: string; ttlSeconds: number }): { pendingId: string } | { error: string }` — validates the client exists and `redirect_uri` exact-matches one of its registered URIs (loopback compares ignoring port per RFC 8252); stores an `authcodes` row keyed by `code_hash = sha256(pendingId)` with `elected_scope=NULL, approver_sub=NULL`; returns the opaque `pendingId` (the value the browser cookie carries).
  - `attachApproval(pendingId: string, approverSub: string, electedScope: string): boolean` — sets `elected_scope`, `approver_sub` on the matching un-used, un-expired row; false if none.
  - `pendingView(pendingId: string): { client_id: string; origin: string; redirect_uri: string } | null` — for the approval page to render; never exposes the challenge.
  - `redeem(p: { code: string; client_id: string; redirect_uri: string; code_verifier: string }): { elected_scope: string; door_name: string } | { error: string }` — single-use (marks `used=1`); requires `elected_scope` and `approver_sub` set; re-checks `client_id` + exact `redirect_uri`; verifies PKCE S256 (`base64url(sha256(code_verifier)) === code_challenge`); derives a stable `door_name` from `origin` (`visit:<origin-host>`); refuses expired/used.

**Parallelization rationale:** the registrar's persistence logic is a self-contained unit consumed by Tasks 4 and 5; fixing its method contract here lets those build against signatures rather than waiting on internals.

- [ ] **Step 1: Write failing tests for the load-bearing behaviors**

```ts
// broker/test/registrar.test.ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import type { RegistrarDO } from '../src/index';

function reg(name: string) {
  return env.REGISTRAR.get(env.REGISTRAR.idFromName(name)) as unknown as DurableObjectStub<RegistrarDO>;
}

describe('RegistrarDO logic', () => {
  test('rejects a confidential client', async () => {
    await runInDurableObject(reg('t-conf'), async (i: RegistrarDO) => {
      const r = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'client_secret_post',
      });
      expect('error' in r).toBe(true);
    });
  });

  test('a full round-trip: register → pending → approve → redeem yields the elected scope', async () => {
    await runInDurableObject(reg('t-round'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      // S256 pair with a known verifier
      const verifier = 'a'.repeat(64);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://julian-broker.julian-memory.workers.dev/mcp',
        ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      expect(await i.attachApproval(pendingId, 'user_marcus', 'reading-room')).toBe(true);
      const ok = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect(ok).toMatchObject({ elected_scope: 'reading-room' });
      // single-use: a second redeem fails
      const twice = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect('error' in twice).toBe(true);
    });
  });

  test('redeem rejects a wrong PKCE verifier', async () => {
    await runInDurableObject(reg('t-pkce'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['http://localhost:3118/callback'], token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'http://localhost:9999/callback', // loopback, port ignored
        code_challenge: 'not-a-real-challenge', resource: 'https://julian-broker.julian-memory.workers.dev/mcp',
        ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      await i.attachApproval(pendingId, 'user_marcus', 'reading-room');
      const bad = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'http://localhost:9999/callback', code_verifier: 'wrong',
      });
      expect('error' in bad).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run and watch fail** — Run: `cd broker && npx vitest run test/registrar.test.ts` — Expected: FAIL (methods undefined).

- [ ] **Step 3: Implement the methods** in `broker/src/registrar.ts`. Reuse the `governor.ts` idioms (random token via `crypto.getRandomValues`+base64url; `sha256Hex`; SQLite `exec`). Enforce: public-only; exact redirect match with loopback port ignored (parse both URLs, compare `protocol+hostname+pathname`, ignore `port` when `hostname` is `localhost`/`127.0.0.1`); PKCE S256 by computing `base64url(sha256(code_verifier))` and comparing to the stored `code_challenge`; single-use via `used=1`; sweep unapproved rows older than 2h at entry to `registerClient`/`createPending`.

- [ ] **Step 4: Run green** — `cd broker && npx vitest run test/registrar.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker/src/registrar.ts broker/test/registrar.test.ts
git commit -m "feat(gate): RegistrarDO DCR + pending-authcode redemption (PKCE S256, single-use)"
```

---

### Task 3: GovernorDO authcode mint + rotation reuse-grace

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `broker/src/governor.ts`
- Test: `broker/test/governor-authcode.test.ts`

**Interfaces:**
- Consumes: nothing (own file; parallel to Tasks 1–2).
- Produces (on `GovernorDO`):
  - `AUTHCODE_SCOPES` — a module constant `['reading-room', 'stream-read'] as const`.
  - `mintAuthcodeLease(doorName: string, scope: string, principal: string, claims: string): MintResult` — refuses (`{ status: 'invalid' }`) any `scope` not in `AUTHCODE_SCOPES`; otherwise `upsertLease` with `flow='authcode'` and the given `principal`, then `insertPair(leaseId, 1, pair, now)`; returns the `ok` MintResult shape (`accessToken`, `refreshToken`, `expiresIn`, `scope`).
  - Rotation reuse-grace: `mintFromRefresh` returns the **same** pair for a repeat of the same presented refresh hash within a short window (default 10s) **only** when the lease's `flow='authcode'`; device-flow leases keep the strict tombstone kill path unchanged.
- Note: `upsertLease` currently ignores `principal`/`flow` (defaults `'julian'`/`'device'`); this task adds an overload/parameters so the authcode path writes `flow='authcode'`. Regression-assert device-flow minting still records `flow='device'`.

**Parallelization rationale:** `governor.ts` is edited by no other B1 task, so the DO-side scope gate and the rotation fix run fully in parallel with the registrar work — the highest-value independent mass in this plan.

- [ ] **Step 1: Failing tests**

```ts
// broker/test/governor-authcode.test.ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import type { GovernorDO } from '../src/index';

function gov(name: string) {
  return env.GOVERNOR.get(env.GOVERNOR.idFromName(name)) as unknown as DurableObjectStub<GovernorDO>;
}

describe('GovernorDO authcode mint', () => {
  test('refuses full-house on the authcode path, server-side', async () => {
    await runInDurableObject(gov('t-ac-full'), async (i: GovernorDO) => {
      const r = await i.mintAuthcodeLease('visit:claude.ai', 'full-house', 'julian', '{}');
      expect(r.status).toBe('invalid');
    });
  });

  test('mints a reading-room authcode lease with flow=authcode', async () => {
    await runInDurableObject(gov('t-ac-ok'), async (i: GovernorDO) => {
      const r = await i.mintAuthcodeLease('visit:claude.ai', 'reading-room', 'julian', '{}');
      expect(r.status).toBe('ok');
      const row = i.leaseList().find((l) => l.doorName === 'visit:claude.ai');
      expect(row?.flow).toBe('authcode');
      expect(row?.scope).toBe('reading-room');
    });
  });

  test('reuse-grace: a repeated refresh within the window returns the same pair (authcode only)', async () => {
    await runInDurableObject(gov('t-ac-grace'), async (i: GovernorDO) => {
      const minted = await i.mintAuthcodeLease('visit:cli', 'reading-room', 'julian', '{}');
      if (minted.status !== 'ok') throw new Error('mint failed');
      const first = await i.mintFromRefresh(minted.refreshToken);
      const second = await i.mintFromRefresh(minted.refreshToken); // same presented token, within window
      expect(first.status).toBe('ok');
      expect(second.status).toBe('ok');
      if (first.status === 'ok' && second.status === 'ok') {
        expect(second.refreshToken).toBe(first.refreshToken); // idempotent, not a kill
      }
    });
  });
});
```

- [ ] **Step 2: Run and watch fail** — `cd broker && npx vitest run test/governor-authcode.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Add `const AUTHCODE_SCOPES = ['reading-room', 'stream-read'] as const;`. Add `mintAuthcodeLease` (mirror `devicePoll`'s ready branch: `newPair()` first, then `upsertLease` + `insertPair`), extending `upsertLease` to accept `flow` and `principal` (default `'device'`/`'julian'` so the device path is unchanged). For reuse-grace: in `mintFromRefresh`, when the resolved lease has `flow='authcode'` and the presented hash was already rotated within the window, return the cached successor pair instead of taking the tombstone kill path — implement by recording the last-minted pair per lease with a short TTL, keyed by presented refresh hash, and returning it on a within-window repeat. Keep device-flow behavior byte-for-byte.

- [ ] **Step 4: Run green** — `cd broker && npx vitest run test/governor-authcode.test.ts` — Expected: PASS.

- [ ] **Step 5: Regression** — `cd broker && npx vitest run test/governor.test.ts test/device-flow.test.ts test/governor-migration.test.ts` — Expected: PASS (device flow + migration unchanged).

- [ ] **Step 6: Commit**

```bash
git add broker/src/governor.ts broker/test/governor-authcode.test.ts
git commit -m "feat(gate): GovernorDO authcode mint (AUTHCODE_SCOPES gate) + authcode reuse-grace"
```

---

### Task 4: The authorization-code HTTP module + discovery

**Type:** implementation
**Depends-on:** 1, 2, 3
**Review:** adversarial

**Files:**
- Create: `broker/src/as/authcode.ts`
- Test: `broker/test/authcode.test.ts`

**Interfaces:**
- Consumes: RegistrarDO `registerClient`/`createPending`/`redeem` (from Task 2); GovernorDO `mintAuthcodeLease` (from Task 3); `session.ts` `setCookie`/`cookieValue`/`randomValue` (existing).
- Produces:
  - `handleAuthcode(req: Request, env: Env, gov, registrar): Promise<Response>` routing `/register`, `/authorize`, and the `/token` `grant_type=authorization_code` branch.
  - `oauthDiscovery(env: Env, path: string): Response | null` returning the protected-resource metadata (`/.well-known/oauth-protected-resource` and the `/mcp`-suffixed variant) and AS metadata (`/.well-known/oauth-authorization-server`) with `scopes_supported: ["reading-room"]` only, `code_challenge_methods_supported: ["S256"]`, `registration_endpoint`, `authorization_endpoint`, `token_endpoint`.
  - Constant `PENDING_COOKIE = 'gate_pending'`.

Behavior (enforce all; every one has a test below):
- `/register` (POST JSON): parse DCR metadata, call `registerClient`, return `{ client_id, token_endpoint_auth_method: 'none', ... }` echoing registered `redirect_uris`; reject non-`none`.
- `/authorize` (GET): require `response_type=code`, `code_challenge_method=S256`, a `resource` equal to `Env.MCP_RESOURCE_URL`, an exact-registered `redirect_uri`. On any failure **before** redirecting, return a 400 page (never redirect an unvalidated `redirect_uri`). On success, `createPending`, set `PENDING_COOKIE` = pendingId (`Secure; HttpOnly; SameSite=Lax`), and hand off to the approval flow (redirect to `/approve` carrying the pendingId server-side via the cookie — the approval page reads the cookie, not a query param).
- `/token` `authorization_code`: require `code`, `client_id`, `redirect_uri`, `code_verifier`; call `redeem`; on success call `mintAuthcodeLease(door_name, elected_scope, 'julian', claims)` and return the OAuth token JSON (`access_token`, `token_type: 'Bearer'`, `expires_in`, `refresh_token`, `scope`); on failure return `invalid_grant`.

**Parallelization rationale:** none beyond its dependencies — this is a genuine join point (it needs both DOs' contracts), authored after them by necessity, not by authoring order.

- [ ] **Step 1: Failing tests** (build `Env` + scripted `REGISTRAR`/`GOVERNOR` stubs as `approve.test.ts` does; assert: non-`none` register → error; `/authorize` with a `plain` challenge → 400 and no redirect; `/authorize` with a wrong `resource` → 400; a happy `/authorize` sets `gate_pending` cookie; `/token` with a redeemable code returns an `access_token` with `scope: 'reading-room'`). Include a test that `/token` never yields `full-house` even if a tampered stub returns it (the DO gate refuses).

- [ ] **Step 2: Run red** — `cd broker && npx vitest run test/authcode.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `broker/src/as/authcode.ts`.** Mirror `device.ts` structure (form parsing for `/token`, JSON for `/register`). Validate `resource` with `timingSafeEqual`-style exact compare against `Env.MCP_RESOURCE_URL`. Never call `redeem` before all bindings present.

- [ ] **Step 4: Run green** — `cd broker && npx vitest run test/authcode.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker/src/as/authcode.ts broker/test/authcode.test.ts
git commit -m "feat(gate): authorization-code flow (/register /authorize /token) + OAuth discovery"
```

---

### Task 5: Approval scope election + browser-bound authcode approval

**Type:** implementation
**Depends-on:** 2, 4
**Review:** adversarial

**Files:**
- Modify: `broker/src/as/approve.ts`
- Test: `broker/test/approve-election.test.ts`

The existing `broker/test/approve.test.ts` must stay green (device-flow approval is unchanged); the new election behavior gets its own suite.

**Interfaces:**
- Consumes: RegistrarDO `pendingView`/`attachApproval` (from Task 2); `PENDING_COOKIE` (from Task 4); `session.ts` (existing cookies/CSRF).
- Produces: an approval path that, for an authcode knock, (a) reads the pending id **only** from `PENDING_COOKIE` (never a query param), (b) renders the decoded origin from `pendingView` as primary identity plus a "NEW ORIGIN" banner when unseen, (c) offers a scope election — `reading-room` pre-selected, `stream-read` behind an explicit second confirmation — and (d) on submit calls `attachApproval(pendingId, session.sub, electedScope)` for **the pending the browser's own cookie names**, nothing else.
- Retires the module constant `GRANTED_SCOPE = 'full-house'`: the device-flow approval keeps `full-house` as the pre-selected election (today's behavior), while the authcode path can elect only `reading-room`/`stream-read`.

- [ ] **Step 1: Failing tests** — assert: (a) an authcode approval POST acts on the cookie's pending id, and a forged query-param pending id is ignored; (b) electing `stream-read` requires the second-confirm field or the submit is rejected back to the election screen; (c) `full-house` is not an option on the authcode path; (d) device-flow approval still defaults to and can grant `full-house` (regression against the existing behavior). Use the `csrfFor`/`mintSession` seam from `session.ts` as `approve.test.ts` does.

- [ ] **Step 2: Run red** — `cd broker && npx vitest run test/approve-election.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Branch the approval handler on whether a `PENDING_COOKIE` is present (authcode) vs a device `user_code` (device flow). For authcode: bind the approval to the cookie; render `esc()`-escaped origin claim; require the second confirmation to elect `stream-read`. Keep all existing security headers and CSRF discipline.

- [ ] **Step 4: Run green** — `cd broker && npx vitest run test/approve-election.test.ts test/approve.test.ts` — Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add broker/src/as/approve.ts broker/test/approve-election.test.ts
git commit -m "feat(gate): server-bound authcode approval + scope election, retire hard-coded full-house"
```

---

### Task 6: Router wiring + the MCP 401 challenge

**Type:** implementation
**Depends-on:** 1, 4
**Review:** adversarial

**Files:**
- Modify: `broker/src/index.ts`
- Test: `broker/test/routing.test.ts`

The existing `routing.test.ts` is extended with the new-route assertions below.

**Interfaces:**
- Consumes: `handleAuthcode`/`oauthDiscovery`/`PENDING_COOKIE` (from Task 4); `RegistrarDO`/`Env.REGISTRAR` (from Task 1).
- Produces: routes ahead of the lease gate for `/register`, `/authorize`, `/.well-known/oauth-protected-resource*`, `/.well-known/oauth-authorization-server`, and the `authorization_code` branch of `/token` (device grant unchanged); plus a `challenge401()` helper returning `401` + `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"` for a future `/mcp` (B2 mounts the endpoint; B1 wires the challenge so discovery is reachable). Add a `registrar(env)` accessor mirroring `governor(env)`.

- [ ] **Step 1: Failing tests** — assert: `GET /.well-known/oauth-authorization-server` returns AS metadata advertising only `reading-room`; `POST /register` reaches the authcode module (not the lease gate); `/token` with `grant_type=authorization_code` reaches the authcode module while `grant_type=urn:ietf:params:oauth:grant-type:device_code` still reaches the device module (regression).

- [ ] **Step 2: Run red** — `cd broker && npx vitest run test/routing.test.ts` — Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement.** Add the self-authenticating routes beside the existing `/device`/`/token`/`/approve`/`/introspect` block; route `/token` by parsing `grant_type` to device vs authcode (or pass both modules the form). Add the `registrar(env)` accessor and thread the stub into `handleAuthcode`/`handleApprove`.

- [ ] **Step 4: Run green** — `cd broker && npx vitest run test/routing.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker/src/index.ts broker/test/routing.test.ts
git commit -m "feat(gate): mount authcode routes + OAuth discovery + MCP 401 challenge"
```

---

### Task 7: Gate — scope invariants + full regression

**Type:** gate
**Depends-on:** 1, 2, 3, 4, 5, 6

**Files:**
- Create: `broker/test/scope-invariants.test.ts`

This gate writes one consolidated security-invariant suite and then runs the whole broker suite green. Expectations:

- The authcode mint path cannot produce a `full-house` lease for any input (asserts the DO-level `AUTHCODE_SCOPES` gate, not the UI).
- A `reading-room` lease `scopeAllows` only `package.list`/`package.read` and no `stream.*`/`mail.*` (regression of `lease-auth.ts` `SCOPE_VERBS`).
- DCR rejects a confidential client; registration grants nothing (no lease exists post-register, pre-approval).
- A `plain` PKCE challenge and an absent/wrong `resource` are refused at `/authorize`.
- A redeemed authcode is single-use; a browser-forged pending id cannot be approved.
- The device flow is unchanged: a device knock still mints `flow='device'` and can be granted `full-house`.

Run (the full suite; all must pass):

```bash
cd broker && npx vitest run
```

Expected: all broker suites green (the 174 at 2B-pre plus the new authcode/registrar/election suites).

---

### Task 8: Deploy + live wire probe (the camelCase lesson)

**Type:** manual
**Depends-on:** 7

Not run in a worktree — requires account credentials and a real MCP client. Carried into the post-merge runbook:

- `cd broker && npx wrangler deploy` (the `v2` migration creates `RegistrarDO` against the live account; additive, GovernorDO untouched).
- Confirm `MCP_RESOURCE_URL` var is set on the deployed worker.
- With the real Claude Code CLI, run discovery → DCR → `/authorize` → Marcus approves at `reading-room` → `/token` → confirm a `jla_…` access token whose `POST /introspect` reports `scope: reading-room`, `principal: julian`. No wire assumption ships un-probed.
- Probe refresh: force a refresh and confirm rotation; then a deliberate double-refresh (two concurrent presentations of the same token) and confirm the **authcode reuse-grace** returns a pair rather than killing the lease (the claude.ai-fleet regression). Record the observed grace window; tune if needed.
- Leave `full-house` unreachable on this path: attempt to elect it via a crafted request and confirm refusal.

---

## Self-review

**Spec coverage (against rev-3 must-fix core, B1 scope):** C2 server-side `AUTHCODE_SCOPES` gate → Task 3/7. C3 authcode reuse-grace built unconditionally → Task 3/8. H2 browser-bound pending-authcode lure defense → Tasks 4/5. H3 honest homograph posture (origin display + reading-room bound; allowlist not the mitigation) → Task 5 + Global Constraints. H7 visit vocabulary → Global Constraints + Task 3 (`flow='authcode'`, no "door"). M7 door-name stability → Task 2 (`redeem` derives stable `visit:<origin>`). M8 loopback port tolerance → Task 2. Deferred to B2/B3 (named, not dropped): the `/mcp` server + package manifest + KV pin + pin-bump + cf-cache (B2); the SYNC binding, stream verbs, sync legacy-JWT bind/sunset, `/export`, `shared/scopes.ts` consolidation, the integration-spanning acceptance (B3).

**Placeholder scan:** no TBD/"handle edge cases"; every task carries real test code and named signatures.

**Type consistency:** `mintAuthcodeLease` returns `MintResult` (governor's existing type); `redeem` returns `{ elected_scope, door_name }`; `PENDING_COOKIE` shared Task 4→5→6; `AUTHCODE_SCOPES` defined Task 3, asserted Task 7.

**Decomposition shaping:** Tasks 1 and 3 are the independent root wave (different files, no shared dependency); 2 follows 1; 4 joins 1+2+3; 5 joins 2+4; 6 joins 1+4. Each `**Depends-on:**` is a real data/interface edge (verified against `Consumes:`/`Produces:`), not authoring order. No same-wave task modifies another's file. `wrangler.toml` is touched only by Task 1. `index.ts` is touched by Tasks 1 and 6, and 6 `Depends-on: 1`.

**Acceptance:** `suite` — declared in the header; Marcus did not request sealing.
