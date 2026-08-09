# Julian Gate v1 — Lease Spine Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace borrowed browser-session bearers with named, scoped, until-revoked per-door leases minted by a bespoke device-flow AS on the existing GovernorDO, so a running door never dies of token expiry again.

**Architecture:** The `broker/` worker (deployed name unchanged) grows an AS face: RFC 8628 device flow, refresh rotation with lost-response grace, an approver-gated Pocket-ID-authenticated approval page, introspection for `julian-sync`, and admin verbs — all state in the GovernorDO (opaque tokens stored hashed; no JWTs, no KV). The Mac server holds its own lease and serves fresh access tokens to subprocesses over a loopback-only endpoint; VM doors hold a lease file and mint on demand. A dated legacy window keeps old Pocket ID bearers working as one revocable pseudo-lease.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), Bun, vitest, jose (legacy JWT verify only), Svelte 5 (app).

**Acceptance:** suite — operator did not request sealing; per-task adversarial review plus the committed suites are the verification, and the post-merge runbook carries the live reality-touching probes.

**Spec:** `docs/superpowers/specs/2026-08-08-julian-gate-auth-design.md` (rev 2, commit `26613a2`). The spec is authority; where this plan refines a detail (rotation grace returns a *fresh* pair and revokes the unused successor, because hashed storage cannot replay plaintext), the refinement is stated in the task body and preserves the spec's security property.

## Global Constraints

- **Deployed worker name stays `julian-broker`** (wrangler `name` unchanged): seven instances carry `BROKER_URL=https://julian-broker.julian-memory.workers.dev` in `.env`; renaming the worker would strand them. "Gate" is the conceptual name in docs only.
- **Token formats:** access `jla_` + 43 base64url chars (256-bit); refresh `jlr_` + 43. Stored server-side as SHA-256 hex. TTLs: access 3600s, device code 900s, poll interval 5s. Plaintext tokens are returned exactly once and never logged.
- **RFC 8628 wire shapes are literal:** requests `application/x-www-form-urlencoded`; grant type `urn:ietf:params:oauth:grant-type:device_code`; refresh grant `refresh_token` (RFC 6749 §6, form-encoded); responses snake_case JSON; error codes `authorization_pending` / `slow_down` / `expired_token` / `access_denied` with HTTP 400.
- **Caps:** global `mail.send` 20/UTC-day (unchanged); per-lease `mail.send` default 5/UTC-day. A 429 body names which counter refused (`"refusedBy": "global" | "lease"`).
- **Fail closed:** unreachable governor refuses every face including `/token`; empty or missing `APPROVER_SUBS` refuses all approvals; no auto-approve path exists.
- **Ledger identity:** gate-authenticated acts record `sub = "lease:<leaseId>"`; `doorName` comes only from the verified lease row, never from a request body.
- **`validateAccess` is non-ledgering:** routine auth checks write zero ledger rows; only verbs `reserve`.
- **Kiosk invariant:** demo sessions receive neither a token nor `JULIAN_LEASE_URL`; the loopback mint refuses while the live session is demo; the `FORCE_DEMO_MODE` bodyless-POST lock stands.
- **Legacy window:** Pocket ID JWTs are accepted only until `LEGACY_WINDOW_END` (ISO date var) and only while pseudo-lease `legacy-window` is unrevoked; they map to `lease:legacy-window`, scope `full-house`.
- **HTTP contracts** (shared; tasks build against these, not against sibling code):
  - `POST /device` form `client_id`,`host`,`purpose` → 200 `{"device_code","user_code","verification_uri":"<PUBLIC_URL>/approve","expires_in":900,"interval":5}`; 429 `{"error":"slow_down"}` on knock flooding (>5 pending).
  - `POST /token` device grant → 400 `{"error":"authorization_pending"|"slow_down"|"expired_token"|"access_denied"}` or 200 `{"access_token","token_type":"Bearer","expires_in":3600,"refresh_token","scope"}`; refresh grant → same 200 shape, 400 `{"error":"invalid_grant"}` on unknown/killed, and killing replay returns 400 `{"error":"invalid_grant","error_description":"lease killed: rotation replay"}`.
  - `POST /introspect` header `X-Introspect-Secret`, form `token` → 200 `{"active":false}` or `{"active":true,"lease_id","door_name","scope"}`; 401 on bad secret.
  - `GET /leases` / `POST /leases/revoke` (form `door_name`) / `GET /leases/export` — authenticated by header `X-Breakglass-Secret` (CLI/break-glass path) or an approver session cookie (browser path); revokes are ledgered with which path authorized them.
  - `GET http://127.0.0.1:8377/lease/token` (Mac loopback only) → 200 `{"access_token","expires_at"}`; 403 `{"error":"demo session active"}`; 503 `{"error":"no lease enrolled"}`.
- **Concurrency-safe tests:** no fixed ports (use `port: 0` and read the bound port); temp files under `mkdtemp`; worker tests run against the exported `fetch` handler with stub env, DO tests against a fresh in-memory SQLite state per test (existing `broker/test/` pattern).
- **Secrets never in code or fixtures:** tests use obviously-fake values (`test-secret`, `jla_TEST…`).
- **Copy rule:** user-facing 401s from the gate say what died and what to do — "lease revoked — re-knock" vs "session token expired" — never a bare Unauthorized to a door.

---

### Task 1: GovernorDO lease store and rotation machine

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `broker/src/governor.ts`
- Test: `broker/test/governor-leases.test.ts`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces (RPC methods on `GovernorDO`, all synchronous SQLite):
  - `knockCreate(clientId: string, host: string, purpose: string): { deviceCode: string; userCode: string; expiresIn: number; interval: number } | { error: 'slow_down' }`
  - `knockByUserCode(userCode: string): { userCode: string; clientId: string; host: string; purpose: string; created: number } | null`
  - `knockDecide(userCode: string, decision: 'approved' | 'refused', doorName: string, scope: 'full-house' | 'reading-room'): boolean`
  - `devicePoll(deviceCode: string, clientId: string): { status: 'pending' | 'slow_down' | 'expired' | 'refused' } | { status: 'ready'; accessToken: string; refreshToken: string; expiresIn: number; scope: string }`
  - `mintFromRefresh(refreshToken: string): { status: 'ok'; accessToken: string; refreshToken: string; expiresIn: number; scope: string } | { status: 'killed' } | { status: 'invalid' }`
  - `validateAccess(accessToken: string): { leaseId: string; doorName: string; scope: string } | null`
  - `legacyAllowed(): boolean`
  - `leaseRevoke(doorNameOrId: string, by: string): boolean`
  - `leaseList(): Array<{ leaseId: string; doorName: string; scope: string; status: string; born: number; lastRenewal: number | null; lastVerb: string | null }>`
  - `leaseExport(): { leases: unknown[]; tokens: unknown[]; knocks: unknown[] }` (hashes only, no plaintext)
  - `reserveLease(leaseId: string, doorName: string, service: string, verb: string, detail: string, globalCap: number | null, leaseCap: number | null): { ok: boolean; refusedBy?: 'global' | 'lease'; count: number; cap: number | null }`
  - Existing `reserve(...)` and `entries(...)` unchanged.

**Parallelization rationale:** single-file foundation; every gate face consumes these signatures, so fixing them first lets the three face tasks build in parallel against a real contract.

Schema added in the constructor (idempotent `CREATE TABLE IF NOT EXISTS`, beside the existing `ledger` table):

```sql
CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY, door_name TEXT NOT NULL UNIQUE,
  client_claims TEXT NOT NULL, scope TEXT NOT NULL,
  status TEXT NOT NULL,             -- living | revoked | killed-rotation
  born INTEGER NOT NULL, last_renewal INTEGER, last_verb TEXT,
  send_cap_per_day INTEGER NOT NULL DEFAULT 5);
CREATE TABLE IF NOT EXISTS lease_tokens (
  hash TEXT PRIMARY KEY, lease_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- access | refresh | refresh_prev
  generation INTEGER NOT NULL, expires INTEGER, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS knocks (
  device_code TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL, host TEXT NOT NULL, purpose TEXT NOT NULL,
  status TEXT NOT NULL,             -- pending | approved | refused | claimed
  scope TEXT, door_name TEXT,
  created INTEGER NOT NULL, expires INTEGER NOT NULL, last_poll INTEGER NOT NULL DEFAULT 0);
```

Token generation: `crypto.getRandomValues(new Uint8Array(32))` → base64url → prefix. Hashing: SHA-256 via `crypto.subtle.digest` — note the DO methods that mint must therefore be `async`. Adjust the Produces signatures accordingly: `knockCreate`, `devicePoll`, `mintFromRefresh`, `validateAccess` return Promises; the rest stay sync. `user_code`: 8 chars from alphabet `BCDFGHJKLMNPQRSTVWXZ` (20 unambiguous consonants), formatted `XXXX-XXXX`.

Rotation semantics (the spec's §4, refined for hashed storage): presenting the current `refresh` token rotates — old row becomes `refresh_prev` (generation g), any *unused* successor rows are deleted, new `refresh` (g+1) + `access` rows insert, `last_renewal` updates. Presenting a `refresh_prev` row whose successor is still unused (lost-response retry): mint a fresh pair the same way — safe, because the unreceived successor is revoked in the same transaction. Presenting a `refresh_prev` whose successor was already `used = 1`, or any hash not found while the lease has newer generations: `killed` — lease status `killed-rotation`, all its tokens deleted, ledgered via a direct INSERT into the ledger table with verb lease.killed (unformatted here deliberately — a backticked dotted token reads as a module reference to the plan compiler). A refresh mint marks the presented row `used = 1`.

- [ ] **Step 1: Write the failing tests** — `broker/test/governor-leases.test.ts`, following the existing `governor.test.ts` pattern for constructing the DO against in-memory storage:

```ts
import { describe, expect, test } from 'vitest';
import { makeGovernor } from './governor.test-util'; // extract the existing test harness helper if inline

describe('knock → approve → poll lifecycle', () => {
  test('happy path mints a working pair', async () => {
    const g = makeGovernor();
    const k = await g.knockCreate('julian-new-web', 'julian-new.exe.xyz', 'web app subprocess');
    expect('deviceCode' in k && k.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(await g.devicePoll(k.deviceCode, 'julian-new-web')).toEqual({ status: 'pending' });
    expect(g.knockDecide(k.userCode, 'approved', 'door:julian-new-web', 'full-house')).toBe(true);
    const ready = await g.devicePoll(k.deviceCode, 'julian-new-web');
    expect(ready.status).toBe('ready');
    const v = await g.validateAccess(ready.accessToken);
    expect(v).toMatchObject({ doorName: 'door:julian-new-web', scope: 'full-house' });
  });
  test('poll faster than interval → slow_down; expired knock → expired; refused → refused', async () => { /* three knocks, drive clock via injected now() */ });
  test('claimed device_code cannot be claimed twice', async () => { /* second poll after ready → invalid/expired */ });
});

describe('rotation machine', () => {
  test('normal rotation: old refresh becomes prev, new pair works', async () => { /* mint, rotate, validate new access */ });
  test('lost-response retry: prev refresh with unused successor mints fresh pair and revokes successor', async () => {
    // rotate to get (A2, R2); do NOT use R2; present R1 again → status ok, new pair (A3, R3); R2 now invalid; lease still living
  });
  test('theft: prev refresh after successor used → lease killed-rotation, all tokens dead, ledger row lease.killed', async () => { /* use R2 once, then present R1 → killed; validateAccess(A2) → null */ });
  test('unknown refresh → invalid, no kill', async () => { /* random jlr_ → { status: "invalid" } */ });
});

describe('validateAccess', () => {
  test('is non-ledgering: 20 validations add zero ledger rows', async () => { /* count ledger before/after */ });
  test('expired access token → null; revoked lease → null', async () => { /* drive clock past 3600s; revoke and check */ });
});

describe('reserveLease caps', () => {
  test('per-lease cap refuses before global and names itself', () => { /* leaseCap 2: third send → { ok:false, refusedBy:"lease" } */ });
  test('global cap counts across leases and names itself', () => { /* two leases, globalCap 3 → fourth send refusedBy:"global" */ });
  test('refusals are ledgered with sub lease:<id>', () => { /* inspect ledger row */ });
});

describe('admin', () => {
  test('leaseRevoke by door name; revoked lease fails validateAccess immediately', async () => {});
  test('leaseList shows name, scope, status, born; leaseExport contains hashes and never a jla_/jlr_ plaintext', async () => {
    const dump = JSON.stringify(g.leaseExport());
    expect(dump).not.toMatch(/jla_|jlr_/);
  });
  test('legacyAllowed seeds the pseudo-lease living, and revoking legacy-window flips it false', () => {});
});
```

For clock control, refactor the DO's `Date.now()` calls behind a `now()` instance method the test overrides — the existing governor tests already need this pattern for day boundaries; if they stub differently, follow their pattern instead.

- [ ] **Step 2: Run to verify failure** — `cd broker && bunx vitest run test/governor-leases.test.ts`. Expected: FAIL, methods not defined.
- [ ] **Step 3: Implement** the schema and methods in `broker/src/governor.ts` per the semantics above. Keep every method a single SQLite transaction (`ctx.storage.transactionSync` or sequential `sql.exec` — the DO is single-threaded, so sequential statements inside one method are atomic with respect to other RPCs). `knockCreate` refuses with `slow_down` when >5 pending knocks exist (flood guard).
- [ ] **Step 4: Run the full broker suite** — `cd broker && bunx vitest run`. Expected: all green including pre-existing governor/policy/routing/mail tests.
- [ ] **Step 5: Commit** — `git add broker/src/governor.ts broker/test/governor-leases.test.ts && git commit -m "gate: GovernorDO lease store, rotation machine, dual caps"`

---

### Task 2: REST face on leases — router seam, lease auth, legacy window

**Type:** implementation
**Depends-on:** 1
**Review:** adversarial

**Files:**
- Modify: `broker/src/index.ts`
- Modify: `broker/src/env.ts`
- Modify: `broker/wrangler.toml`
- Create: `broker/src/lease-auth.ts`
- Create: `broker/src/as/device.ts`
- Create: `broker/src/as/approve.ts`
- Create: `broker/src/as/admin.ts`
- Test: `broker/test/lease-auth.test.ts`

**Interfaces:**
- Consumes: `validateAccess`, `legacyAllowed`, `reserveLease` (Task 1 signatures).
- Produces:
  - `authenticate(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<{ leaseId: string; doorName: string; scope: string } | Response>` in `lease-auth.ts` — returns identity or the finished 401 Response with the copy-rule message.
  - Router contract: `index.ts` mounts `handleDevice(req, env, gov)`, `handleApprove(req, env, gov)`, `handleAdmin(req, env, gov)` for paths `/device`+`/token`, `/approve`+`/auth/callback`, `/introspect`+`/leases*` respectively; each stub returns 501 `{"error":"not implemented"}` until its own task replaces it.
  - `Env` gains: `APPROVER_SUBS: string`, `GATE_CLIENT_ID: string`, `GATE_REDIRECT_URI: string`, `PUBLIC_URL: string`, `LEGACY_WINDOW_END: string`, and secrets `SESSION_SECRET: string`, `INTROSPECT_SECRET: string`, `BREAKGLASS_SECRET: string`.

The three `as/` files are created as 501 stubs (each exports its handler returning `{"error":"not implemented"}`); Tasks 3–5 each replace exactly one of them and touch no other broker file.

**Parallelization rationale:** module-per-face is how a four-face worker should be structured regardless of parallelism (index.ts would otherwise quadruple); the stubs let Tasks 3–5 each own exactly one file with no `index.ts` contention.

Auth resolution order in `authenticate`: bearer starting `jla_` → `gov.validateAccess` (401 "lease token invalid or expired — renew, or re-knock if revoked" on null); any other bearer → legacy path: verify Pocket ID JWT exactly as today (`verifyWithKeySet(keySetFor(env))`), then require `Date.now() < Date.parse(env.LEGACY_WINDOW_END)` and `gov.legacyAllowed()`, mapping to `{ leaseId: 'legacy-window', doorName: 'legacy-window', scope: 'full-house' }` — else 401 "the legacy-bearer window has closed — this door needs a lease; run: bun scripts/door-knock.ts". Verb routes switch from `reserve(env, auth.sub, …)` to `reserveLease(auth.leaseId, auth.doorName, service, verb, detail, globalCap, leaseCap)` with `sub` recorded as `lease:<leaseId>` inside the DO; `mail.send` leaseCap comes from the lease row, others null. `/health` now requires any living lease (legacy pseudo-lease counts). 429 body: `{"error":"cap","refusedBy":result.refusedBy,…}`.

`wrangler.toml` gains `[vars] APPROVER_SUBS`, `GATE_CLIENT_ID`, `GATE_REDIRECT_URI`, `PUBLIC_URL`, `LEGACY_WINDOW_END` placeholders with a comment that real values are set at deploy (`name = "julian-broker"` is **not** changed — Global Constraints).

- [ ] **Step 1: Write failing tests** — `broker/test/lease-auth.test.ts` against the exported worker `fetch` with a stub env whose `GOVERNOR` returns a scripted stub (existing `routing.test.ts` shows the stubbing pattern):

```ts
test('jla_ bearer routes to validateAccess and mail.send reserves under lease identity', async () => { /* stub validateAccess → identity; assert reserveLease called with leaseId, and 200 */ });
test('valid legacy JWT inside window maps to lease:legacy-window', async () => { /* use the OIDC_JWKS_JSON test seam as routing.test.ts does */ });
test('legacy JWT after LEGACY_WINDOW_END → 401 naming door-knock', async () => {});
test('legacy JWT with legacyAllowed()=false (revoked pseudo-lease) → 401', async () => {});
test('per-lease 429 body carries refusedBy:"lease"', async () => {});
test('reading-room lease calling mail.send → 403 naming missing scope, ledgered as refusal', async () => {});
test('stubbed faces respond 501 at /device, /approve, /introspect', async () => {});
test('no token → 401; jla_ unknown → 401 with renew/re-knock copy', async () => {});
```

- [ ] **Step 2: Run to verify failure** — `cd broker && bunx vitest run test/lease-auth.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `lease-auth.ts`, thin `index.ts` into the router + verb routes using `authenticate`, create the three 501 stubs, extend `env.ts` and `wrangler.toml`.
- [ ] **Step 4: Run the full broker suite** — `cd broker && bunx vitest run`. Expected: green; pre-existing routing tests may need their env extended with the new vars — extend the test env fixtures, do not weaken assertions.
- [ ] **Step 5: Commit** — `git add broker/src broker/test/lease-auth.test.ts broker/wrangler.toml && git commit -m "gate: REST face authenticates leases; legacy window as revocable pseudo-lease"`

---

### Task 3: Device-flow AS endpoints

**Type:** implementation
**Depends-on:** 1, 2
**Review:** adversarial

**Files:**
- Modify: `broker/src/as/device.ts`
- Test: `broker/test/device-flow.test.ts`

**Interfaces:**
- Consumes: `knockCreate`, `devicePoll`, `mintFromRefresh` (Task 1); router mount + `Env` (Task 2).
- Produces: `handleDevice(req, env, gov)` serving `POST /device` and `POST /token` per the HTTP contracts in Global Constraints.

Parsing: `await req.formData()` — reject JSON bodies with 400 `{"error":"invalid_request"}` (RFC: form-encoded only). `/token` dispatches on `grant_type`: the device URN → `devicePoll` (mapping `pending→authorization_pending`, `slow_down→slow_down`, `expired→expired_token`, `refused→access_denied`, all HTTP 400 per RFC 8628 §3.5); `refresh_token` → `mintFromRefresh` (`invalid→invalid_grant`; `killed→invalid_grant` with `error_description: "lease killed: rotation replay"`); anything else → 400 `{"error":"unsupported_grant_type"}`. `/device` requires all three fields nonempty (400 `invalid_request` naming the missing field), passes them to `knockCreate`, and builds `verification_uri` from `env.PUBLIC_URL`.

- [ ] **Step 1: Write failing tests** — `broker/test/device-flow.test.ts`, worker-level with a scripted governor stub:

```ts
test('POST /device happy path returns RFC-shaped snake_case JSON', async () => {
  const res = await worker.fetch(new Request('https://gate/device', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'd', host: 'h', purpose: 'p' }),
  }), env);
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(['device_code', 'expires_in', 'interval', 'user_code', 'verification_uri']);
  expect(body.verification_uri).toBe('https://gate.example/approve');
});
test('JSON body → 400 invalid_request', async () => {});
test('token endpoint: URN grant maps all four poll states to RFC error codes at HTTP 400', async () => {});
test('token endpoint: ready poll returns access_token/refresh_token/expires_in/scope', async () => {});
test('refresh grant: ok mints; unknown → invalid_grant; killed → invalid_grant with rotation-replay description', async () => {});
test('missing client_id on either endpoint → 400 invalid_request', async () => {});
test('/device and /token require no Authorization header (they are the unauthenticated AS face)', async () => {});
```

- [ ] **Step 2: Run to verify failure** — `cd broker && bunx vitest run test/device-flow.test.ts`. Expected: FAIL (stub returns 501).
- [ ] **Step 3: Implement** `as/device.ts` fully; do not touch `index.ts`.
- [ ] **Step 4: Run the full broker suite** — green.
- [ ] **Step 5: Commit** — `git add broker/src/as/device.ts broker/test/device-flow.test.ts && git commit -m "gate: RFC 8628 device flow + refresh grant"`

---

### Task 4: Approval flow — Pocket ID login, approver allowlist, approve pages

**Type:** implementation
**Depends-on:** 1, 2
**Review:** adversarial

**Files:**
- Modify: `broker/src/as/approve.ts`
- Create: `broker/src/as/session.ts`
- Test: `broker/test/approve.test.ts`

**Interfaces:**
- Consumes: `knockByUserCode`, `knockDecide` (Task 1); router mount + `Env` incl. `SESSION_SECRET`, `APPROVER_SUBS`, `GATE_CLIENT_ID`, `GATE_REDIRECT_URI` (Task 2).
- Produces: `handleApprove(req, env, gov)` serving `GET /approve`, `POST /approve`, `POST /approve/confirm`, `GET /auth/callback`; `session.ts` exporting `mintSession(sub: string, secret: string): Promise<string>` (HMAC-signed `sub.exp.sig` cookie value, 24h), `readSession(cookieHeader: string | null, secret: string): Promise<{ sub: string } | null>`, `csrfFor(sessionValue: string, userCode: string, secret: string): Promise<string>`.

Flow: `GET /approve` with no valid session → 302 to `https://souls.exe.xyz/authorize?client_id=<GATE_CLIENT_ID>&redirect_uri=<GATE_REDIRECT_URI>&response_type=code&scope=openid&state=<random>&nonce=<random>&code_challenge=<PKCE S256>&code_challenge_method=S256`, with `state`+`nonce`+`code_verifier` in a short-lived HMAC-signed `gate_flow` cookie. `GET /auth/callback` → validate `state` against cookie, exchange code at `https://souls.exe.xyz/api/oidc/token` (form-encoded, PKCE verifier), verify the ID token locally with `verifyWithKeySet(keySetFor(env), 'https://souls.exe.xyz', env.GATE_CLIENT_ID)` plus a nonce check on the decoded payload, **then check `sub` against `APPROVER_SUBS`** (comma-split, trimmed; empty/missing var → 403 always) → set `gate_session` cookie (`Secure; HttpOnly; SameSite=Lax; Path=/`), redirect to `/approve`. With a session: `GET /approve` renders the code-entry form (hidden CSRF from `csrfFor(session, '')`); `POST /approve` validates CSRF + rate-limits code entry via a per-DO counter (reuse `reserveLease`? No — a plain in-DO counter is overkill; use `knockByUserCode` returning null + a fixed-window counter kept in the approve module per isolate is insufficient across isolates, so add nothing fancy: the governor's `knockByUserCode` misses are ledgered via a direct `reserve('gate','code-attempt',…, cap 5)` on the legacy `reserve` method with sub `approve:<session sub>` — cap refusal renders "too many attempts, wait 15 minutes"); on hit, renders the confirm page: gate-chrome facts (requested scope `full-house`, knock timestamp) plus the door's claims (client_id, host, purpose) each HTML-escaped, length-capped at 120 chars, under the heading "The door claims:"; editable `door_name` field prefilled `door:<client_id>`; buttons Open/Refuse; hidden CSRF from `csrfFor(session, userCode)`. `POST /approve/confirm` → re-validate session + CSRF (bound to that user_code) → `knockDecide`. Every HTML response carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. Escaping helper: `const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))`.

- [ ] **Step 1: Write failing tests** — `broker/test/approve.test.ts`; stub the Pocket ID token exchange with a fetch-mock and mint ID tokens with the same local-JWKS seam the routing tests use:

```ts
test('no session → 302 to souls.exe.xyz authorize with state, nonce, PKCE S256', async () => {});
test('callback with wrong state → 400; valid exchange but sub not in APPROVER_SUBS → 403 and no cookie', async () => {});
test('APPROVER_SUBS unset → 403 for every sub (fail closed)', async () => {});
test('approve pages set frame-ancestors none and escape client claims', async () => {
  // knockByUserCode stub returns purpose: '<script>alert(1)</script>'
  // assert response HTML contains &lt;script&gt; and never the raw tag
});
test('confirm without CSRF, or with CSRF for a different user_code → 403, knockDecide not called', async () => {});
test('confirm with valid session+CSRF calls knockDecide with the edited door_name', async () => {});
test('code-entry attempts beyond cap render the wait message', async () => {});
```

- [ ] **Step 2: Run to verify failure** — `cd broker && bunx vitest run test/approve.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `as/session.ts` then `as/approve.ts`; HMAC via `crypto.subtle` (`HMAC`,`SHA-256`), constant-time compare on signatures.
- [ ] **Step 4: Run the full broker suite** — green.
- [ ] **Step 5: Commit** — `git add broker/src/as/approve.ts broker/src/as/session.ts broker/test/approve.test.ts && git commit -m "gate: approval flow — Pocket ID login, approver allowlist, CSRF-bound one-tap approve"`

---

### Task 5: Admin face — introspection, leases list/revoke/export, break-glass

**Type:** implementation
**Depends-on:** 1, 2, 4
**Review:** adversarial

**Files:**
- Modify: `broker/src/as/admin.ts`
- Test: `broker/test/admin.test.ts`

**Interfaces:**
- Consumes: `validateAccess`, `leaseList`, `leaseRevoke`, `leaseExport` (Task 1); router mount + `Env` incl. `INTROSPECT_SECRET`, `BREAKGLASS_SECRET` (Task 2); `readSession(cookieHeader, secret)` (Task 4's session module) for the approver-browser path.
- Produces: `handleAdmin(req, env, gov)` serving `POST /introspect`, `GET /leases`, `POST /leases/revoke`, `GET /leases/export` per the HTTP contracts.

`/introspect`: constant-time compare of `X-Introspect-Secret` (401 on miss, no body detail); form `token`; `jla_`-prefixed → `validateAccess` mapping to `{active, lease_id, door_name, scope}`; anything else → `{active: false}` (introspection is for lease tokens only — sync keeps its own legacy JWT path). `/leases*`: authorized by `X-Breakglass-Secret` header (constant-time) **or** an approver session cookie; every revoke is ledgered inside `leaseRevoke` with `by` = `"breakglass"` or `"approver:<sub>"`. Export returns `leaseExport()` as JSON.

- [ ] **Step 1: Write failing tests** — `broker/test/admin.test.ts`:

```ts
test('introspect with bad secret → 401; good secret + unknown token → {active:false}', async () => {});
test('introspect with living lease token → active:true with lease_id/door_name/scope snake_case', async () => {});
test('leases list/revoke/export refuse without either credential', async () => {});
test('break-glass revoke works and is ledgered as breakglass', async () => {});
test('approver-session revoke works and is ledgered as approver:<sub>', async () => {});
test('export body never contains jla_ or jlr_ plaintext', async () => {});
```

- [ ] **Step 2: Run to verify failure.** `cd broker && bunx vitest run test/admin.test.ts`
- [ ] **Step 3: Implement** `as/admin.ts`.
- [ ] **Step 4: Full broker suite green.**
- [ ] **Step 5: Commit** — `git add broker/src/as/admin.ts broker/test/admin.test.ts && git commit -m "gate: introspection + lease admin with break-glass path"`

---

### Task 6: julian-sync accepts lease tokens by introspection

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `sync/src/index.ts`
- Modify: `sync/src/auth.ts`
- Modify: `sync/src/do.ts`
- Test: `sync/test/lease-introspect.test.ts`
- Modify: `sync/package.json`

**Interfaces:**
- Consumes: the `POST /introspect` HTTP contract (Global Constraints) — over fetch, never an import.
- Produces: `introspectLease(token: string, gateUrl: string, secret: string): Promise<{ active: boolean; leaseId?: string; doorName?: string; scope?: string }>` in `sync/src/auth.ts`, with a module-level 60s result cache keyed by token hash; `Env` gains `GATE_URL: string` and secret `INTROSPECT_SECRET: string`.

If `sync/` has no test setup yet, mirror `broker/test`'s vitest arrangement — `sync/package.json` gains the same vitest devDependency and `test` script `broker/package.json` carries.

Rules: a bearer starting `jla_` is only read from the `Authorization` header — a `jla_` token in the query string is rejected 401 with body "lease tokens ride in headers only" (the legacy query-string path stays for non-`jla_` browser JWTs, unchanged). On websocket accept with a lease token, the socket's serialized attachment records `{ leaseToken, verifiedAt }`; in the DO's message handler, if `Date.now() - verifiedAt > 300_000`, re-introspect before processing (piggyback re-auth on traffic — an idle socket can't act, so traffic-driven re-auth bounds the revocation SLA at 5 minutes of *activity*); on `active: false`, close the socket with code 4001 reason `lease revoked`. Introspection failure (gate unreachable) fails closed for *new* connections and *open* re-auths alike — close 4002 `introspection unavailable`.

- [ ] **Step 1: Write failing tests** — unit-test `introspectLease` (fetch-mocked: secret header sent, 60s cache hit skips second fetch, non-200 → inactive) and worker-level: `jla_` in query → 401; `jla_` in header with mocked-active introspection → upgrade proceeds (assert the DO stub receives the request); DO message-handler re-auth: fake attachment with stale `verifiedAt`, introspection inactive → socket closed 4001.
- [ ] **Step 2: Run to verify failure.** `cd sync && bunx vitest run`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Suite green** (`cd sync && bunx vitest run`), and `cd broker && bunx vitest run` still green (broker re-exports `sync/src/auth.ts` — the shared `verifyWithKeySet` must keep its exact signature).
- [ ] **Step 5: Commit** — `git add sync/ && git commit -m "sync: lease tokens via gate introspection, header-only, 5-min re-auth"`

---

### Task 7: Mac server — lease holder, loopback mint, kiosk invariant

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Create: `server/lease.ts`
- Modify: `server/lib.ts`
- Modify: `server/server.ts`
- Test: `tests/server/lease.test.ts`
- Modify: `tests/server/subprocess-env.test.ts`

**Interfaces:**
- Consumes: the `POST /token` refresh-grant HTTP contract (Global Constraints) — over fetch.
- Produces:
  - The new lease-holder module (first Create entry in this task's Files) exports `loadLeaseFile(path: string): LeaseFile | null` (`{ refresh_token: string; access_token: string; access_expires: number }`, defensive parse) and `startLeaseHolder(opts: { path: string; brokerUrl: string; isDemoActive: () => boolean; now?: () => number; port?: number }): Promise<{ port: number; stop: () => void; currentToken: () => Promise<string | null> }>` — starts the renewal timer (every 60s: renew when `access_expires - now < 1_800_000`, with ±10% jitter on the check; atomic rewrite temp+rename, 0600) and a `Bun.serve({ hostname: '127.0.0.1', port: opts.port ?? 8377 })` loopback listener serving `GET /lease/token` per the contract (403 when `isDemoActive()`, 503 when no lease file).
  - `subprocessEnv` (in this task's server lib file) gains a fourth parameter `leaseUrl: string` — non-empty sets `env.JULIAN_LEASE_URL`, empty deletes it (mirroring the existing oidcToken discipline directly beside it); demo spawns pass `''` for **both**.
- Produces (behavioral): the server boots the holder when `~/.julian/gate-lease.json` exists (path from `process.env.JULIAN_LEASE_FILE ?? join(homedir(), '.julian', 'gate-lease.json')`), passes `isDemoActive: () => currentSessionDemo || FORCE_DEMO_MODE`, and threads `leaseUrl` (`http://127.0.0.1:<port>/lease/token`, or `''` for demo) into both `spawnClaude` call sites that today thread `oidcToken` (near lines 1512 and 1524 of the main server file).

**Parallelization rationale:** the server consumes only the gate's HTTP wire contract, so it builds against a stub token server in tests and never waits on gate code.

- [ ] **Step 1: Write failing tests** — `tests/server/lease.test.ts` (run with `bun test tests/server/lease.test.ts` or the repo's existing server-test runner — match `tests/server/`'s existing convention):

```ts
test('renewal fires when under 30 min remain and rewrites the file atomically 0600', async () => {
  // stub token endpoint via Bun.serve port 0; seed lease file in mkdtemp with access_expires = now + 20min
  // startLeaseHolder with now() injectable; advance by calling the internal check via a 0ms timer tick
  // assert file rewritten with new tokens and mode 0o600
});
test('loopback serves current access token; refuses 403 while isDemoActive; 503 with no lease file', async () => {});
test('loopback binds 127.0.0.1 (server hostname is loopback)', async () => { /* assert opts passed / server.hostname */ });
test('renewal survives one failed attempt (gate 503) and retries next tick without corrupting the file', async () => {});
```

In `tests/server/subprocess-env.test.ts`, extend the existing cases:

```ts
test('leaseUrl set → JULIAN_LEASE_URL present; empty → absent (no stale var)', () => {});
test('demo spawn: neither JULIAN_LEASE_URL nor JULIAN_OIDC_TOKEN survives', () => {});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `server/lease.ts`, the `subprocessEnv` parameter, and the `server.ts` wiring (holder boot + threading `leaseUrl` at both spawn call sites; demo passes `''`).
- [ ] **Step 4: Run the server suite** — the repo's server tests (`bun test tests/server/` or existing script) all green.
- [ ] **Step 5: Commit** — `git add server/lease.ts server/lib.ts server/server.ts tests/server/ && git commit -m "server: lease holder + loopback mint; demo sessions get neither token nor mint URL"`

---

### Task 8: Door-side CLI — mint-on-demand mail-broker, door-knock, door-leases

**Type:** implementation
**Depends-on:** none
**Review:** lean

**Files:**
- Modify: `scripts/mail-broker.ts`
- Create: `scripts/lib/lease-client.ts`
- Create: `scripts/door-knock.ts`
- Create: `scripts/door-leases.ts`
- Test: `scripts/lease-client.test.ts`

**Interfaces:**
- Consumes: the `/device`, `/token`, `/lease/token`, `/leases*` HTTP contracts (Global Constraints) — over fetch, tested against stub servers on port 0.
- Produces: `scripts/lib/lease-client.ts` exporting `resolveAccessToken(env: NodeJS.ProcessEnv, leasePath: string, brokerUrl: string): Promise<{ token: string; source: 'loopback' | 'lease-file' | 'legacy' } | { error: string }>` — resolution order: `JULIAN_LEASE_URL` (fetch; its 403/503 bodies surface verbatim) → lease file (mint-on-demand: refresh when under 50% TTL, guarded by a `mkdir`-based lock dir `<leasePath>.lock` with 30s stale timeout; atomic rewrite 0600) → `JULIAN_OIDC_TOKEN` with a stderr deprecation line ("legacy bearer — this door should knock: bun scripts/door-knock.ts") → error naming all three misses.

`mail-broker.ts` swaps its env-var read for `resolveAccessToken`, updates `AGENT_DOC` (the token story: lease via loopback or lease file; 401 copy now distinguishes expired-renew from revoked-re-knock per the response body), and keeps every parse/command shape unchanged. `door-knock.ts`: POST `/device` with `--name`/`--host`/`--purpose` flags (host defaults to `hostname()`), print the boxed instructions (verification_uri + user_code), poll per `interval` honoring `slow_down` (+5s), on `ready` write the lease file 0600 and print the door name; on `expired_token` print "knock expired unanswered — knock again when Marcus is reachable" and exit 1. `door-leases.ts`: `list` / `revoke <door_name>` / `export` against `/leases*` using `GATE_BREAKGLASS_SECRET` from the Mac `.env` (sourced only inside the command per mail-discipline rule 5), printing a table for `list` and raw JSON for `export`.

- [ ] **Step 1: Write failing tests** — `scripts/lease-client.test.ts`: resolution-order (loopback wins; file when no URL; legacy last with deprecation on stderr), mint-on-demand refresh at <50% TTL against a stub `/token` (port 0), lock contention (second resolver waits or reuses the fresh file, never double-refreshes — spawn two concurrent `resolveAccessToken` calls against one stub that counts refresh hits, expect 1), atomic 0600 rewrite.
- [ ] **Step 2: Run to verify failure.** `cd scripts && bunx vitest run lease-client.test.ts`
- [ ] **Step 3: Implement** the three scripts + lib.
- [ ] **Step 4: Suite green** — `cd scripts && bunx vitest run`.
- [ ] **Step 5: Commit** — `git add scripts/ && git commit -m "doors: mint-on-demand lease client, door-knock, door-leases"`

---

### Task 9: End-session control hierarchy — the {final:true} trap

**Type:** implementation
**Depends-on:** none
**Review:** lean

**Files:**
- Modify: `app/src/components/FaceHeader.svelte`
- Modify: `app/src/App.svelte`
- Test: `app/src/lib/api.test.ts`

**Interfaces:**
- Consumes: nothing from sibling tasks (frontend-only; the server's pause/final handling is already correct).
- Produces: no exported symbols; behavioral contract only.

The incident: the control *labeled* "end session" is the destructive `{final:true}` one, while pause is the alarming all-caps "END" — Marcus clicked the readable label and destroyed the resume state. Fix is hierarchy and copy, not plumbing: the pause control becomes the primary, labeled `REST` with `title="Pause — Julian resumes this same session next start"`; the final control becomes a small, visually distinct danger control labeled `END FOR GOOD` with `title="Ends this session permanently — the next one starts fresh"`; the existing `confirm()` stays and its copy becomes "End this session for good? This cannot be resumed — the next session starts fresh, inheriting only the recent record." Keep `endSession()` / `endSession(true)` wiring exactly as-is in `App.svelte` (only labels, classes, titles, and the confirm string change; the danger control's class gains a distinct `danger` style in the component's existing style block).

- [ ] **Step 1: Write the failing test** — extend `app/src/lib/api.test.ts`'s existing endSession coverage with a component-free guard on the confirm copy if the app has a test harness for components; if it does not (check `app/` test setup — only `api.test.ts` exists), then instead add the assertion-as-comment and rely on the two label greps below as the verification step. Verification command in that case: `grep -q 'END FOR GOOD' app/src/components/FaceHeader.svelte && grep -q 'cannot be resumed' app/src/App.svelte`.
- [ ] **Step 2: Verify current state fails the greps.**
- [ ] **Step 3: Implement** the label/hierarchy/copy changes.
- [ ] **Step 4: Verify** — greps pass; `cd app && bunx vitest run` (existing api tests) green; `bun run build` in `app/` if a build script exists, to catch Svelte syntax errors.
- [ ] **Step 5: Commit** — `git add app/src && git commit -m "app: pause is primary (REST); final end is distinct and honestly labeled"`

---

### Task 10: Room doc, secrets manifest, deploy-skill note

**Type:** implementation
**Depends-on:** none
**Review:** lean

**Files:**
- Modify: `server/room.ts`
- Modify: `deploy/secrets-manifest.md`
- Modify: `.claude/skills/deploy/SKILL.md`

**Interfaces:**
- Consumes: nothing (documentation of contracts fixed in Global Constraints).
- Produces: none.

`server/room.ts` SERVICES: the broker entry's `purpose` gains "— the gate: doors authenticate with per-door leases (knock: `bun scripts/door-knock.ts`)" and its `auth` line becomes `'Door lease (device-flow knock, Marcus approves; see door-knock.ts). Legacy Pocket ID bearers accepted only during the migration window. Service keys held by the gate, never by agent or harness'`. Endpoint line unchanged (Global Constraints: worker name/URL stable).

`deploy/secrets-manifest.md`: add tier **T3 door lease** to the Rules ("revocable, capped authority; lives with the door that owns it (`~/.julian/gate-lease.json` on the Mac, `/opt/julian/.julian/lease.json` on a VM, 0600, gitignored); rotation is automatic on renewal; revocation is `bun scripts/door-leases.ts revoke <door>`; re-provisioning a VM clones fresh, so **re-provision means re-knock**"). Add credential rows: `SESSION_SECRET`, `INTROSPECT_SECRET` (T1, worker secrets on julian-broker, bound host the gate itself; rotation `wrangler secret put`), `GATE_BREAKGLASS_SECRET` (T0 Mac `.env` + T1 worker secret `BREAKGLASS_SECRET` — same value, two homes, one row noting both).

`.claude/skills/deploy/SKILL.md`: in the provisioning steps, after the clone step, add one step: "Enroll the door: `bun scripts/door-knock.ts --name door:<vmname>-web --purpose '<one line>'` — requires Marcus at `/approve`. Re-provisioning always re-knocks (the lease file does not survive a fresh clone)."

- [ ] **Step 1: Make the three edits.** (Doc task — the room change is covered by whatever room.md snapshot tests exist; check `tests/` for a room test and update its expected text if one asserts the SERVICES block.)
- [ ] **Step 2: Verify** — `bun test tests/server/` (or repo server-test convention) green; `grep -q 'door lease' deploy/secrets-manifest.md`.
- [ ] **Step 3: Commit** — `git add server/room.ts deploy/secrets-manifest.md .claude/skills/deploy/SKILL.md && git commit -m "gate: room auth pointer, T3 lease tier, re-provision-means-re-knock"`

---

### Task 11: Full verification gate

**Type:** gate
**Depends-on:** 1, 2, 3, 4, 5, 6, 7, 8, 9, 10

Run every suite the changes touch; all must pass:

- `cd broker && bunx vitest run`
- `cd sync && bunx vitest run`
- `cd scripts && bunx vitest run`
- `bun test tests/` (server + shared suites, per repo convention)
- `cd app && bunx vitest run`

Expectations: zero failures; no test skipped that previously ran; `git grep -n "jla_\|jlr_" -- '*.md' broker/test sync/test scripts` shows only obviously-fake fixtures.

---

### Task 12: Register the gate as an OIDC client of Pocket ID

**Type:** manual

Performed on the Mac (needs `POCKETID_API_KEY`, T0). Register a client for the gate at souls.exe.xyz: redirect URI `https://julian-broker.julian-memory.workers.dev/auth/callback`, public client + PKCE, note the issued client id. `deploy/pocketid-register-callback.ts` hardcodes VM-shaped callbacks — adapt its API call by hand or via the Pocket ID admin UI; do not ship a code change for a one-time act. Record the client id for Task 13's vars. Also look up Marcus's Pocket ID `sub` (the incident transcript shows the live value: `94d31ef6-0b1f-441e-b67c-c037a8993924` — confirm against souls.exe.xyz admin before trusting it) for `APPROVER_SUBS`.

---

### Task 13: Deploy the gate

**Type:** release

From `broker/`: set secrets `wrangler secret put SESSION_SECRET` / `INTROSPECT_SECRET` / `BREAKGLASS_SECRET` (generate: `openssl rand -base64 32`; the break-glass value also lands in the Mac `.env` as `GATE_BREAKGLASS_SECRET`); set vars via `wrangler.toml` deploy values: `APPROVER_SUBS=<Marcus sub>`, `GATE_CLIENT_ID=<from Task 12>`, `GATE_REDIRECT_URI=https://julian-broker.julian-memory.workers.dev/auth/callback`, `PUBLIC_URL=https://julian-broker.julian-memory.workers.dev`, `LEGACY_WINDOW_END=<deploy date + 14 days, ISO>`. `bunx wrangler deploy`. Then deploy julian-sync with its new `GATE_URL` var + `INTROSPECT_SECRET` secret. Verify: `curl -s -X POST <gate>/device -d 'client_id=probe&host=mac&purpose=deploy smoke'` returns the RFC shape; `/introspect` with the secret returns `{"active":false}` for a junk token; a legacy Pocket ID bearer still passes `/health`.

---

### Task 14: Enroll doors and run the live proofs

**Type:** manual

The post-merge reality-touching runbook (spec §10; Marcus present for approvals):

1. Mac: `bun scripts/door-knock.ts --name door:mac-home --purpose "Marcus's Mac — the home door"`; Marcus approves at `/approve`; restart `julian.service`-equivalent local server; confirm the loopback answers and `bun scripts/mail-broker.ts health` succeeds with **no** `JULIAN_OIDC_TOKEN` in the environment.
2. julian-new VM: same knock (`door:julian-new-web`); verify a spawned web-door session completes `health` via the lease file.
3. **Incident regression:** keep a door session running past two access-token TTLs (>2h), then complete a broker verb with no human intervention.
4. **Rotation replay:** copy the lease file, renew from the original, use the new pair once, then present the stale copy's refresh token — expect lease killed, a ledger row with verb lease.killed, notification received; re-knock to restore.
5. **Revocation SLA:** revoke a door's lease mid-sync-session; expect the sync socket closed (4001) within 5 minutes of its next activity and gate verbs refused immediately.
6. **Kiosk:** on the julian-new deployment with `DEMO_MODE=1` behavior, start a demo session and verify the subprocess env contains neither `JULIAN_LEASE_URL` nor any token, and the loopback (Mac-only anyway) refuses demo.
7. At `LEGACY_WINDOW_END` (or earlier if all doors are enrolled): `bun scripts/door-leases.ts revoke legacy-window`; confirm a legacy bearer gets the loud re-knock 401. Fold learnings back to ELF PATTERNS.md per fold-back-once-proven.

---

## Self-review record

- **Spec coverage:** §2 decisions → Tasks 1–8, 12–14; §4 lease model → 1; §5 knock → 3, 4 (+8 client side); §6 verbs/caps → 2; §7 scope column → 1, 2; §8 components → 2 (broker), 6 (sync), 7 (server), 8 (CLI), 9 (trap), 10 (docs); §9 failure rows → distributed into task tests + Task 14 probes; §10 testing → per-task suites + Task 11 gate + Task 14; §11 rollout → 12–14. §13 (phase 2) intentionally has no tasks.
- **Refinement declared:** rotation grace mints a fresh pair and revokes the unused successor (hashed storage cannot replay plaintext); theft signature unchanged (prev-after-successor-used). Stated in Task 1.
- **Type consistency:** async-ness of DO mint/validate methods corrected in Task 1's body (crypto.subtle); consumers (Tasks 2–5) call through the DO stub, which is Promise-typed regardless.
- **Dependency audit:** Task 5 consumes Task 4's `readSession` → header updated to Depends-on: 1, 2, 4 (noted in task body). Tasks 6, 7, 8 consume only HTTP contracts pinned in Global Constraints — no code edges, deliberately.
- **Same-file check:** Tasks 3, 4, 5 each own exactly one stub file; `index.ts` is touched only by Task 2; `server/server.ts` only by Task 7; app files only by Task 9.
