# Plan B3 — Stream Verbs, Browser Cure, Sunset — Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Plan B — stream verbs on the `/mcp` face over a broker→sync service binding, the browser's raw-JWT sync path replaced by a delegated session lease presented through single-use socket tickets, package integrity hardened (sticky sitting pin, bounded atomic latch, pin-bound parts), and the legacy-JWT sunset staged as a witnessed act.

**Architecture:** One shared vocabulary package (`shared/`) becomes the single scope/contract authority for both workers. The GovernorDO grows exchange machinery (access-only delegated leases, socket tickets, reinstate) and package-sitting state. The gate's introspection face becomes the one auth authority — sync stops verifying JWTs and asks the gate about everything. The app connects by minting 60-second single-use tickets from an hour-scale exchange access token, renewed against the live Pocket ID session. Cuts are severable: A (the bind) closes the account-wide hole with no client changes; B (the cure) gates the ceremony; C (the face) is parallel.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), TinyBase 9, Bun, vitest (+ @cloudflare/vitest-pool-workers), jose (shared verifier), Svelte 5 + reconnecting-websocket (app), @modelcontextprotocol/sdk v1 (acceptance harness).

**Acceptance:** suite — operator did not request sealing; per-task adversarial-capable review plus the committed suites (broker workers-pool, broker node harness, sync, app, shared, scripts) are the verification, and the post-merge runbook carries §13's live reality-touching proofs.

**Spec:** `docs/superpowers/specs/2026-08-13-plan-b3-stream-spec.md` (rev 3, two adversarial review rounds folded; findings in `2026-08-13-plan-b3-review-findings.md`). The spec is authority. Where this plan refines a detail, the refinement is stated in the task body and preserves the spec's security property. Two named refinements: (1) the `EXCHANGE_RL` binding's `limit()` conflates consult and increment (Cloudflare exposes no read-only peek), so the order is refined to *verify → on failure, consult-and-increment → refuse*; the property "a verified `STREAM_SUBS` exchange is never limited" is preserved exactly, at the cost of one local JWT verification per flood request. (2) The part threshold is set at 32 KiB (target part size 24 KiB) so `catalog.md` (~56 KB — the file the first visit read 4% of) actually serves in parts; §9 names no number, and the drill of §13.3 needs a parted file that exists.

## Global Constraints

- **Deployed worker names stay `julian-broker` and `julian-sync`** — instances carry these URLs in `.env`; "gate" remains a conceptual name.
- **Scope vocabulary (spec §5) is the law and lives in `shared/scopes.ts` alone** — every other scope constant dies into an import of it:

  | scope | package | stream reads | socket (read+write) | mail |
  |---|---|---|---|---|
  | `reading-room` | yes | — | — | — |
  | `stream-read` | yes | yes | — | — |
  | `stream` | yes | yes | yes | — |
  | `full-house` | yes | yes | yes | yes |

  Mint allowlists export separately and are never widened by the vocabulary: `KNOCK_SCOPES = ['full-house','reading-room','stream-read']` (no `stream`), `AUTHCODE_SCOPES = ['reading-room','stream-read']`, `EXCHANGE_SCOPES = ['stream']`. Sync sets: `EXPORT_SCOPES = {stream-read, stream, full-house}`, `SOCKET_SCOPES = {stream, full-house}`.
- **Token formats:** lease access `jla_` + 43 base64url; refresh `jlr_`; socket ticket `jst_` + 43 base64url (32 bytes). All stored as SHA-256 hex, never plaintext. TTLs: access 3600 s; ticket 60 s, single-use, `kind='ticket'`, `generation=0`, excluded from rotation arithmetic. Exchange leases hold **no refresh token, ever** — the Pocket ID session is the renewal root.
- **Reserved door names** (enforced inside `GovernorDO.upsertLease`, all mint paths): names beginning `browser:` (exchange flow only) or `visit:` (authcode flow only), and the literals `legacy-window` and `legacy-window-sync` (no mint path, ever). A reserved-name row whose status is not `living` is never revived by `upsertLease`.
- **Fail closed everywhere, with one inversion:** unreachable governor refuses; empty/missing `STREAM_SUBS` refuses everyone; a listed-but-unmapped sub is refused with a typed error, **never defaulted to `julian`**; unset `OIDC_AUDIENCE` refuses the exchange (503). The single deliberate fail-open: a **missing** `EXCHANGE_RL` binding never refuses a verified subject (tested).
- **Indefinite vs definitive is normative** (sync ↔ gate): 200 `{active:true|false}` is definitive and cacheable (60 s); any non-200 or fetch failure is indefinite, propagates as a throw, and fails closed as 503 / WS 4002 — never as 4001 "revoked". `jst_` introspections/consumes **never enter the cache**. JWKS unreachable at the gate's JWT arm → non-200 (503), never `{active:false}`.
- **WS close codes:** 4001 lease revoked (definitive); 4002 introspection unavailable (also the sweep's 3-consecutive-indefinite close); 4003 scope/ownership lost; **4004 access token expired — re-exchange** (new, distinct from revocation).
- **HTTP wire contracts** (tasks build against these, never against sibling code):
  - `POST /exchange` — browser-facing, CORS-wrapped. `Authorization: Bearer <Pocket ID JWT>`. 200 `{"access_token":"jla_…","token_type":"Bearer","expires_in":3600,"scope":"stream"}`. Refusals all carry `{"error":"<human sentence>","class":"<machine class>"}`: 401 `class:"bad-session"`; 503 `class:"no-audience"` (unset `OIDC_AUDIENCE`); 403 `class:"not-listed"` (sub not in `STREAM_SUBS`); 403 `class:"unmapped"` (listed, no principal); 403 `class:"revoked"` (**terminal** — the app stops); 429 `class:"session-cap"` (at cap, refuse — never evict); 429 `class:"rate"` (rate-limited, retryable).
  - `POST /socket-ticket` — browser-facing, same CORS wrapper. `Authorization: Bearer jla_…` of a **`flow='exchange'` lease only**. 200 `{"ticket":"jst_…","expires_in":60}`. 403 `class:"not-a-session"` for any other flow (no header→URL downgrade for device/full-house leases); 429 `class:"rate"` (mint cap, retryable-with-backoff).
  - `POST /introspect` (header `X-Introspect-Secret`) — three request forms, one response shape. Form `token=jla_…` → validateAccess. Form `token=<anything else non-jst_>` → the JWT arm (JWKS verify + `STREAM_SUBS` + window + `legacy-window-sync` living). Form `lease_id=…&token_id=…` (no `token`) → by-handle; form `sub=…&exp=…&kind=legacy` → legacy by-handle. Active answers: `{"active":true,"lease_id","door_name","scope","principal","subject","flow","token_id"?,"exp"?}` — **`door_name` present in every active shape**. `token=jst_…` → `{"active":false}` (tickets are consumed, never introspected).
  - `POST /consume-ticket` (header `X-Introspect-Secret`) — form `ticket=jst_…` → 200 `{"ok":true,"lease_id","token_id","subject","scope","flow","principal"}` or `{"ok":false,"error":"unknown"|"expired"|"reused"}`.
  - `POST /refusals` (unchanged, denied pen) and **`POST /allowed`** (new, positive pen): same secret, same five required string fields `lease_id, door_name, service, verb, detail`; `/allowed` writes one ledger row with `allowed:1`, spending no quota.
  - `POST /leases/reinstate` (register-gated like `/leases/revoke`) — form `door_name`, `reason` → 200 `{"reinstated":true}`; 404 unknown; 409 `{"error":"…"}` for status ≠ `revoked` (killed-rotation is undone by no verb) or flow ≠ `exchange`.
  - `GET /leases` gains `"approver_subs":[…]` and `"stream_subs":{"<sub>":"<principal>"}` beside `"leases"` — both membership lists legible in one readout.
  - `POST <sync>/internal/read/{recent|session|search}` (header `X-Sync-Read-Secret`, via the broker's `SYNC` binding) — JSON body `{"principal":"…", …args}` → 200 `{"ok":true,"rows":[…],"truncated":bool}`; 403 bodiless on bad/missing secret (first statement, constant-time); any failure surfaces to the caller as the refusal `stream unavailable`, never as empty results.
  - Sync socket: `?ticket=jst_…` is the **only** slot for tickets and tickets open **only** WebSocket upgrades. Full matrix (each cell typed, refused cells ledgered): `jla_` in `Authorization` → allowed per scope; `jla_` in `?token=` or `?ticket=` → 401; `jst_` in `?ticket=` on a socket path → consume-and-upgrade; `jst_` anywhere else (`?token=`, `Authorization`, `/export`) → 401; JWT in header or `?token=` → gate JWT arm (until sunset). Sync never accepts a cookie.
- **The internal handoff header is `X-Sync-Auth`** (JSON `{leaseId, tokenId?, subject, scope, flow, principal, exp?}`), set by the sync router after auth, **stripped unconditionally from every inbound request as the router's first act**, and trusted by the DO. No raw bearer is ever serialized into a socket attachment again.
- **Package integrity numbers:** part threshold 32 768 bytes (manifest `bytes` above it → the file serves only in parts); part target 24 576 bytes, split codepoint-safe; `M` (part count) is server-authoritative. `partSha256` is a transport checksum for the client — it never latches. Latch only on a **length-verified** mismatch that survives one in-call `cacheTtl: 0` refetch; never latch shared leases (`legacy-window`, `legacy-window-sync`, any `flow='authcode'` lease); self-clear only on a clean read of the same `(pin, path)`. Sitting pin: seated/reset by `package_list`, checked by every `package_read` in the sitting.
- **Ledger identity:** gate-authenticated acts record `sub = "lease:<leaseId>"`; door names come from the register, never a request body. Theft signals — ticket-reuse, rotation kills, integrity latches — are first-class ledger rows and are never collapsed by the fold.
- **Concurrency-safe tests:** no fixed ports (`port: 0`), temp paths under `mkdtemp`, workers-pool tests against exported handlers with stub env (existing patterns in `broker/test/` and `sync/test/`); secrets in tests are obviously fake (`test-secret`, `jla_TEST…`). Same-wave tasks run suites simultaneously.
- **Copy rule:** every refusal says what died and what to do — "pin moved `<old>` → `<new>`; run package_list, then re-read from the top", never a bare 403.
- **Deploy order is §6.6 and is a release task in this plan** — nothing in an implementation task pushes, deploys, or edits a live instance. `LEGACY_WINDOW_END → 2026-09-01T00:00:00Z` rides Task 3's wrangler.toml edit and goes live as the first deploy act.

---

### Task 1: Shared vocabulary, store addressing, and the cross-worker contract fixture

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Create: `shared/scopes.ts`
- Create: `shared/gate-contract.ts`
- Modify: `shared/schema.ts`
- Modify: `broker/package.json`
- Test: `shared/scopes.test.ts`
- Test: `shared/gate-contract.test.ts`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces:
  - `SCOPES: readonly ['reading-room','stream-read','stream','full-house']`, `type Scope`
  - `SCOPE_VERBS: Readonly<Record<Scope, readonly string[]>>` — per the Global Constraints table; verbs are `package.list`, `package.read`, `stream.recent`, `stream.session`, `stream.search`, `mail.send`, `mail.list`, `mail.read`, `mail.health`
  - `EXPORT_SCOPES: ReadonlySet<string>`, `SOCKET_SCOPES: ReadonlySet<string>`
  - `KNOCK_SCOPES`, `AUTHCODE_SCOPES`, `EXCHANGE_SCOPES` (readonly arrays, exported separately)
  - `SOCKET_REQUIRED_MSG = 'a sync socket requires a socket-capable scope (stream or full-house)'` — the one string sync's router and DO both refuse with (replaces the hardcoded `do.ts:250` message)
  - `storePathFor(principal: string): string | null` — `` `${principal}/chat` `` when principal matches `/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/` and is not the literal `internal`; `null` otherwise
  - `shared/gate-contract.ts`: `INTROSPECT_PATH`, `CONSUME_TICKET_PATH = '/consume-ticket'`, `REFUSALS_PATH`, `ALLOWED_PATH = '/allowed'`, `INTERNAL_READ_PREFIX = '/internal/read/'`, `SYNC_AUTH_HEADER = 'X-Sync-Auth'`, `INTROSPECT_SECRET_HEADER = 'X-Introspect-Secret'`, `SYNC_READ_SECRET_HEADER = 'X-Sync-Read-Secret'`; interfaces `IntrospectionWire` (snake_case, `active` + optional `lease_id/door_name/scope/principal/subject/flow/token_id/exp`), `SyncAuthPayload` (`{leaseId, tokenId?, subject, scope, flow, principal, exp?}`), `ConsumeTicketWire` (`{ok, lease_id?, token_id?, subject?, scope?, flow?, principal?, error?}`), `InternalReadRequest` (`{principal: string, limit?: number, sessionId?: string, from?: number, to?: number, query?: string}`), `InternalReadResponse` (`{ok: true, rows: StreamRow[], truncated: boolean} | {ok: false}`), `StreamRow` (`{id, sessionId, role, speakerName, text, ts, kind}`)

**Parallelization rationale:** contract-first — both workers, the governor chain, the app client, and the acceptance harness all build against these names in parallel; fixing the vocabulary and wire shapes as one import-free module is exactly the issue-#28 drift lesson made structural, and a good engineer would extract this shared authority even in a sequential build (it kills four divergent scope constants that have already drifted once).

- [ ] **Step 1: Write the failing tests.** `shared/scopes.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  SCOPES, SCOPE_VERBS, EXPORT_SCOPES, SOCKET_SCOPES,
  KNOCK_SCOPES, AUTHCODE_SCOPES, EXCHANGE_SCOPES,
} from './scopes';
import { storePathFor } from './schema';

describe('the vocabulary is the spec §5 table, exactly', () => {
  test('four scopes, in privilege order', () => {
    expect(SCOPES).toEqual(['reading-room', 'stream-read', 'stream', 'full-house']);
  });
  test('reading-room buys package only', () => {
    expect(SCOPE_VERBS['reading-room']).toEqual(['package.list', 'package.read']);
  });
  test('stream-read and stream buy package + stream reads; only full-house buys mail', () => {
    for (const s of ['stream-read', 'stream'] as const) {
      expect(SCOPE_VERBS[s]).toContain('stream.recent');
      expect(SCOPE_VERBS[s]).not.toContain('mail.send');
    }
    expect(SCOPE_VERBS['full-house']).toContain('mail.send');
  });
  test('sync sets: export ⊇ socket; socket = {stream, full-house}', () => {
    expect([...SOCKET_SCOPES].sort()).toEqual(['full-house', 'stream']);
    expect([...EXPORT_SCOPES].sort()).toEqual(['full-house', 'stream', 'stream-read']);
  });
});

describe('mint allowlists never widen (SEC MED-2)', () => {
  test('knock cannot mint stream', () => expect(KNOCK_SCOPES).not.toContain('stream'));
  test('authcode caps at stream-read', () =>
    expect([...AUTHCODE_SCOPES].sort()).toEqual(['reading-room', 'stream-read']));
  test('exchange mints stream and nothing else', () => expect(EXCHANGE_SCOPES).toEqual(['stream']));
});

describe('storePathFor', () => {
  test('derives the principal store', () => expect(storePathFor('julian')).toBe('julian/chat'));
  test('refuses the reserved segment and junk', () => {
    expect(storePathFor('internal')).toBeNull();
    expect(storePathFor('')).toBeNull();
    expect(storePathFor('Not/Valid')).toBeNull();
  });
});
```

`shared/gate-contract.test.ts` pins the constants literally (each `expect(SYNC_AUTH_HEADER).toBe('X-Sync-Auth')` etc.) and type-checks one literal object per interface — the file exists so both workers' suites can import and re-assert the same shapes (the fixture rule of spec §8).

- [ ] **Step 2: Run to verify failure** — `cd shared && bunx vitest run`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement.** `shared/scopes.ts` is import-free (parent M9). Build `SCOPE_VERBS` from frozen verb groups exactly as `broker/src/lease-auth.ts:42-50` does today, adding the `stream` row (`PACKAGE_VERBS + STREAM_VERBS`). `storePathFor` appends to `shared/schema.ts` beside `STORE_PATH` (the SEG regex is copied from `sync/src/index.ts:4`; state in a comment that sync's path parser and this function must agree). Add the broker dependency and `bun install`.
- [ ] **Step 4: Run** — `cd shared && bunx vitest run`; then `cd ../broker && bun run test` and `cd ../sync && bun run test` to prove neither worker broke (no imports moved yet).
- [ ] **Step 5: Commit** — `git add shared broker/package.json broker/bun.lock && git commit -m "b3: shared scope vocabulary, storePathFor, cross-worker gate contract"`

---

### Task 2: Shared auth hoist — one verifier, one constant-time compare

**Type:** implementation
**Depends-on:** 1
**Review:** lean

**Files:**
- Create: `shared/auth.ts`
- Modify: `shared/package.json`
- Modify: `sync/src/auth.ts`
- Modify: `broker/src/auth.ts`
- Modify: `broker/src/as/session.ts`
- Modify: `broker/src/lease-auth.ts`
- Test: `shared/auth.test.ts`

**Interfaces:**
- Consumes: `julian-shared/scopes` (Task 1).
- Produces (from `shared/auth.ts`):
  - `verifyWithKeySet(token: string, keySet: JWTVerifyGetKey, issuer: string, audience?: string): Promise<{ sub: string; exp: number } | null>` — **now returns `exp`** (seconds since epoch, from the JWT payload); a payload without a numeric `exp` or non-empty string `sub` returns null
  - `timingSafeEqual(a: string, b: string): boolean` — the exact `session.ts:52-57` implementation

**Parallelization rationale:** the JWT arm (Task 9), the exchange face (Task 8), and sync's read routes (Task 14) all need the same verifier and compare; hoisting them once removes the broker→sync source import (`broker/src/auth.ts:5`) that couples the workers' trees — a coupling a good engineer removes regardless of parallelism.

- [ ] **Step 1: Write the failing tests.** `shared/auth.test.ts`: sign a JWT with a locally generated key (jose `SignJWT` + `createLocalJWKSet`), assert `verifyWithKeySet` returns `{sub, exp}` matching the signed claims; wrong issuer → null; wrong audience when audience passed → null; missing `exp` claim → null. `timingSafeEqual`: equal strings true; differing/empty false.
- [ ] **Step 2: Run to verify failure** — `cd shared && bunx vitest run auth.test.ts`.
- [ ] **Step 3: Implement** `shared/auth.ts` (move the `sync/src/auth.ts:4-15` body, extend the return to carry `exp`; move `timingSafeEqual` verbatim). Update the four import sites: `broker/src/auth.ts` re-exports from `julian-shared/auth` instead of `../../sync/src/auth`; `broker/src/as/session.ts` deletes its local `timingSafeEqual` and imports-then-re-exports the shared one so existing `./session` importers keep working; `broker/src/lease-auth.ts` replaces its local `SCOPE_VERBS` table with the `julian-shared/scopes` import (`scopeAllows` stays exported from lease-auth with its exact current signature). `sync/src/auth.ts` keeps `export { verifyWithKeySet } from 'julian-shared/auth'` so `sync/src/index.ts:1` compiles unchanged until Task 10 removes the call. The broker's `keySetFor` (module-level JWKS cache) stays where it is in `broker/src/auth.ts` — "the JWKS keyset cache moves with the verifier" is satisfied by each worker holding its own cache over the shared verifier.
- [ ] **Step 4: Run all three suites** — `shared`, `broker` (`bun run test`), `sync`. All green; the callers of `verifyWithKeySet` that ignore `exp` are unaffected.
- [ ] **Step 5: Commit** — `git add shared sync/src/auth.ts broker/src/auth.ts broker/src/as/session.ts broker/src/lease-auth.ts && git commit -m "b3: hoist verifyWithKeySet(+exp) and timingSafeEqual to shared; SCOPE_VERBS imports the vocabulary"`

---

### Task 3: Broker bindings and env — the pool-boot commit

**Type:** implementation
**Depends-on:** none
**Review:** lean

**Files:**
- Modify: `broker/src/env.ts`
- Modify: `broker/wrangler.toml`
- Modify: `broker/vitest.config.ts`
- Modify: `deploy/secrets-manifest.md`
- Test: `broker/test/routing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (on `Env`): `STREAM_SUBS: string` (map var, `sub=principal` comma-separated), `APP_ORIGINS: string` (comma-separated exact origins), `SYNC: { fetch(input: string | Request, init?: RequestInit): Promise<Response> }` (service binding to julian-sync), `SYNC_READ_SECRET: string` (secret), `EXCHANGE_RL?: { limit(opts: { key: string }): Promise<{ success: boolean }> }` (rate-limit binding, optional — its absence is the tested fail-open).

**Parallelization rationale:** one task owns `env.ts`, `wrangler.toml`, and the vitest config so no same-wave sibling collides on them; the binding + stub land in one commit (the pool-boot lesson, spec §4 "Throughout").

- [ ] **Step 1: Write the failing boot test** — append to `broker/test/routing.test.ts`:

```ts
test('the suite boots with SYNC and EXCHANGE_RL stubbed (pool-boot guard)', () => {
  // env is the pool-provided binding surface; these exist or this file cannot run.
  expect(env.SYNC).toBeDefined();
  expect(typeof env.STREAM_SUBS).toBe('string');
  expect(typeof env.APP_ORIGINS).toBe('string');
});
```

- [ ] **Step 2: Run to verify failure** — `cd broker && bun run test` (FAIL: bindings absent).
- [ ] **Step 3: Implement.** `wrangler.toml`: change `LEGACY_WINDOW_END = "2026-09-01T00:00:00Z"` (comment: the Sep 1 backstop, OPS N-6 — goes live as deploy step 1); add `[vars]` entries `STREAM_SUBS = "94d31ef6-0b1f-441e-b67c-c037a8993924=julian"` and `APP_ORIGINS = "https://julian.exe.xyz,https://julian-new.exe.xyz,http://localhost:8000"`; add the service binding and the rate limiter:

```toml
[[services]]
binding = "SYNC"
service = "julian-sync"

[[unsafe.bindings]]
name = "EXCHANGE_RL"
type = "ratelimit"
namespace_id = "1101"
simple = { limit = 30, period = 60 }
```

`vitest.config.ts` gains miniflare options mirroring sync's pattern: `serviceBindings: { SYNC: () => new Response('sync stub: not wired in tests', { status: 500 }) }` and `ratelimits: { EXCHANGE_RL: { simple: { limit: 1000, period: 60 } } }`. If the pool rejects the wrangler `unsafe.bindings` entry at boot, the documented fallback is to leave the toml entry in place for deploy but exclude it from the test config via the miniflare `ratelimits` stub only — either way this task ends with the suite booting, which is its acceptance. `env.ts` gains the five members above with the house's comment style (`SYNC_READ_SECRET` under the Secrets block). `deploy/secrets-manifest.md` gains rows: `STREAM_SUBS` (T2 public config — subs are not secret, the map is policy), `APP_ORIGINS` (T2), `SYNC_READ_SECRET` (T1 broker+sync worker secret, piped never printed, live-probed, one distinct value per direction noted), `EXCHANGE_RL` (binding, not a credential — a row so the enumeration is complete, per §6.6 step 0).
- [ ] **Step 4: Run** — `cd broker && bun run test`. Green, including the boot guard.
- [ ] **Step 5: Commit** — `git add broker/src/env.ts broker/wrangler.toml broker/vitest.config.ts broker/test/routing.test.ts deploy/secrets-manifest.md && git commit -m "b3: SYNC + EXCHANGE_RL bindings with test stubs, STREAM_SUBS/APP_ORIGINS vars, window backstop Sep 1"`

---

### Task 4: Governor — migration, reserved names, sync-window seed, positive pen, indexes

**Type:** implementation
**Depends-on:** 1
**Review:** adversarial

**Files:**
- Modify: `broker/src/governor.ts`
- Test: `broker/test/governor-migration.test.ts`
- Test: `broker/test/governor-guards.test.ts`

**Interfaces:**
- Consumes: `KNOCK_SCOPES`, `AUTHCODE_SCOPES` from `julian-shared/scopes` (Task 1).
- Produces:
  - Columns (guarded `PRAGMA table_info` migration, the `:149-157` pattern): `leases.subject TEXT` (nullable), `leases.sitting_pin TEXT`, `leases.latch TEXT` (JSON `{"pin","path"}` or NULL), `lease_tokens.token_id TEXT` (nullable; every **new** access insert stamps a UUID).
  - Indexes: `idx_ledger_svc (service, verb, allowed, ts)`, `idx_ledger_sub (sub, service, verb, allowed, ts)` — `CREATE INDEX IF NOT EXISTS`, additive.
  - Seed: `legacy-window-sync` lease (`INSERT OR IGNORE`, scope `stream`, flow `legacy`, principal `julian`, status `living`) beside the existing `legacy-window` seed.
  - `legacySyncAllowed(): boolean` — mirrors `legacyAllowed()` for the new row.
  - `recordAllowed(leaseId: string, doorName: string, service: string, verb: string, detail: string): void` — one ledger row, `allowed:1`, `sub = lease:<id>`, updates `last_verb`; spends no cap.
  - `upsertLease` guard: signature grows a final param `mintClass: 'device' | 'authcode' | 'exchange'` (default `'device'`); returns `string | null` — `null` when the name is reserved for a different class, is a legacy literal, or is a reserved-name row whose status ≠ `living`. `devicePoll` maps null → `{status:'refused'}`; `mintAuthcodeLease` (passes `'authcode'`) maps null → `{status:'invalid'}`. `knockDecide` additionally refuses reserved names outright (returns false) and validates scope against `KNOCK_SCOPES` (imported — `stream` is now structurally unknockable). `mintAuthcodeLease` validates against the imported `AUTHCODE_SCOPES`.
  - Existing signatures (`validateAccess`, `insertPair`, rotation) unchanged in this task.

**Parallelization rationale:** all four leases/lease_tokens schema changes land in one constructor pass so Tasks 5–7 (same file, chained) never fight over migration blocks; the guard covers every mint path from below, which is COLD H-5's requirement that it live in `upsertLease` itself.

- [ ] **Step 1: Write the failing tests.** Extend `governor-migration.test.ts` (its existing B2-shaped-database pattern: create tables with the old DDL, construct the DO, assert columns): new columns present on both tables after migration over a pre-B3 database; indexes exist (`SELECT name FROM sqlite_master WHERE type='index'`); pre-existing token rows with NULL `token_id` still validate. New `governor-guards.test.ts`:

```ts
describe('reserved identifiers (COLD H-5)', () => {
  test('a device knock cannot take browser:*, visit:*, or the legacy literals', async () => {
    for (const name of ['browser:mallory', 'visit:evil.example', 'legacy-window', 'legacy-window-sync']) {
      const k = await g.knockCreate('c', 'h', 'p');
      expect(g.knockDecide(k.userCode, 'approved', name, 'full-house')).toBe(false);
    }
  });
  test('knockDecide refuses scope stream (KNOCK_SCOPES is the gate)', async () => {
    const k = await g.knockCreate('c', 'h', 'p');
    expect(g.knockDecide(k.userCode, 'approved', 'door:x', 'stream' as never)).toBe(false);
  });
  test('authcode may mint visit:* but never browser:* or legacy names', async () => {
    expect((await g.mintAuthcodeLease('visit:ok.example', 'reading-room', 'julian', '{}')).status).toBe('ok');
    expect((await g.mintAuthcodeLease('browser:sub', 'reading-room', 'julian', '{}')).status).toBe('invalid');
    expect((await g.mintAuthcodeLease('legacy-window-sync', 'reading-room', 'julian', '{}')).status).toBe('invalid');
  });
  test('a reserved-name row that is not living is never revived by upsert', async () => {
    await g.mintAuthcodeLease('visit:ok.example', 'reading-room', 'julian', '{}');
    g.leaseRevoke('visit:ok.example', 'test');
    expect((await g.mintAuthcodeLease('visit:ok.example', 'reading-room', 'julian', '{}')).status).toBe('invalid');
  });
});

describe('legacy-window-sync', () => {
  test('seeded living; revoking flips legacySyncAllowed, and legacyAllowed is untouched', () => {
    expect(g.legacySyncAllowed()).toBe(true);
    g.leaseRevoke('legacy-window-sync', 'test');
    expect(g.legacySyncAllowed()).toBe(false);
    expect(g.legacyAllowed()).toBe(true);
  });
});

describe('recordAllowed — the positive pen (COLD M-8)', () => {
  test('writes exactly one allowed:1 row under lease:<id> and spends no cap', () => {
    g.recordAllowed('L1', 'door:x', 'stream', 'socket', 'open token_id=t1');
    const rows = g.entries(5).filter((e) => e.verb === 'socket');
    expect(rows).toHaveLength(1);
    expect(rows[0].allowed).toBe(1);
    expect(rows[0].sub).toBe('lease:L1');
  });
});
```

(Note on the revive test: once Task 5 lands, a revoked *exchange* lease refuses at the exchange itself; the authcode-visit case above is the class representative the guard must hold for every path.)
- [ ] **Step 2: Run to verify failure** — `cd broker && bunx vitest run test/governor-guards.test.ts test/governor-migration.test.ts`.
- [ ] **Step 3: Implement** per Produces. The reserved check is the first statements of `upsertLease`: classify the name (`browser:` prefix ⇒ needs `'exchange'`; `visit:` ⇒ `'authcode'`; the two literals ⇒ no class); mismatch → return null; then, for any reserved name with an existing row, `status !== 'living'` → return null. The constructor seed uses direct `INSERT OR IGNORE` (as `legacy-window` does at `:174-179`) and is therefore untouched by the guard.
- [ ] **Step 4: Run the full broker suite** — all green including untouched device-flow tests (regression: "device-flow behavior unchanged").
- [ ] **Step 5: Commit** — `git add broker/src/governor.ts broker/test/governor-migration.test.ts broker/test/governor-guards.test.ts && git commit -m "b3: governor migration (subject, sitting_pin, latch, token_id, indexes), reserved-name guard, legacy-window-sync seed, positive pen"`

---

### Task 5: Governor — exchange machinery, reinstate, attribution, by-handle

**Type:** implementation
**Depends-on:** 4
**Review:** adversarial

**Files:**
- Modify: `broker/src/governor.ts`
- Test: `broker/test/governor-exchange.test.ts`

**Interfaces:**
- Consumes: Task 4's columns and guard; `EXCHANGE_SCOPES` from `julian-shared/scopes`.
- Produces:
  - `EXCHANGE_SESSION_CAP = 6` (exported const — concurrent live access tokens per exchange lease)
  - `async mintExchangeAccess(sub: string, principal: string): Promise<{ status: 'ok'; leaseId: string; accessToken: string; tokenId: string; expiresIn: number } | { status: 'revoked' } | { status: 'session-cap' }>` — `leaseId` rides the ok-shape because Task 8's success ledgering needs it
  - `reinstate(doorNameOrId: string, by: string, reason: string): { ok: true } | { error: 'not-found' | 'not-revoked' | 'not-exchange' }`
  - `LeaseIdentity` grows: `{ …existing; subject: string | null; flow: string; tokenId: string | null; sittingPin: string | null; latched: { pin: string; path: string } | null }` — `validateAccess`'s SELECT joins the new columns; **still non-ledgering**
  - `validateByHandle(leaseId: string, tokenId: string): LeaseIdentity | null` — access row exists with that `token_id`, `kind='access'`, unexpired, lease living
- Exchange-flow storage semantics (D1 cure, SEC NEW-9/NEW-10): `mintExchangeAccess` never touches `insertPair`. It finds-or-creates the `browser:<sub>` row via `upsertLease(…, 'exchange', principal)` **flow-aware**: for `flow='exchange'` rows, the upsert updates claims/`last_renewal`/`subject` but **deletes no tokens**; status ≠ living → `{status:'revoked'}` (checked before upsert; the Task-4 guard backstops). Then: prune `kind='access' AND expires <= now` for this lease (kind-scoped — ticket rows are never touched by this predicate); count live `kind='access'`; ≥ cap → `{status:'session-cap'}` **refusing, never evicting**; else insert one access row (`token_id = crypto.randomUUID()`, generation 0, no refresh row minted). Device and authcode flows keep delete-then-insert `insertPair` and the rotation tombstone untouched.

**Parallelization rationale:** none needed — same-file chain link; carries the D1/NEW-9/NEW-10 semantics as one reviewable unit.

- [ ] **Step 1: Write the failing tests** — `governor-exchange.test.ts`:

```ts
describe('mintExchangeAccess', () => {
  test('mints an access-only lease: scope stream, flow exchange, subject set, zero refresh rows', async () => {
    const m = await g.mintExchangeAccess('sub-marcus', 'julian');
    expect(m.status).toBe('ok');
    const id = await g.validateAccess(m.accessToken);
    expect(id).toMatchObject({ doorName: 'browser:sub-marcus', scope: 'stream', flow: 'exchange', subject: 'sub-marcus', tokenId: m.tokenId, principal: 'julian' });
    const dump = g.leaseExport();
    const mine = (dump.tokens as Array<{ lease_id: string; kind: string }>).filter((t) => t.lease_id === m.leaseId);
    expect(mine.every((t) => t.kind === 'access')).toBe(true); // no refresh row minted for the exchange lease
  });
  test('two mints for one sub = one lease row, two simultaneously-valid tokens', async () => {
    const a = await g.mintExchangeAccess('s', 'julian');
    const b = await g.mintExchangeAccess('s', 'julian');
    expect(await g.validateAccess(a.accessToken)).not.toBeNull();  // NOT retired by the second mint
    expect(await g.validateAccess(b.accessToken)).not.toBeNull();
    expect(g.leaseList().filter((l) => l.doorName === 'browser:s')).toHaveLength(1);
  });
  test('at cap: refuses typed, never evicts a live token', async () => {
    let last; for (let i = 0; i < 6; i++) last = await g.mintExchangeAccess('s', 'julian');
    const over = await g.mintExchangeAccess('s', 'julian');
    expect(over.status).toBe('session-cap');
    expect(await g.validateAccess(last.accessToken)).not.toBeNull();
  });
  test('expired tokens are pruned at mint, freeing the cap', async () => { /* fill cap, advance now() past 3600s, mint again → ok */ });
  test('a revoked exchange lease refuses the mint (typed)', async () => {
    await g.mintExchangeAccess('s', 'julian');
    g.leaseRevoke('browser:s', 'test');
    expect((await g.mintExchangeAccess('s', 'julian')).status).toBe('revoked');
  });
  test('device flow is untouched: re-knock still purges old tokens; rotation replay still detonates', async () => { /* replay the existing governor-leases patterns against a device lease minted in this test */ });
});

describe('reinstate (SEC NEW-11, COLD M-9)', () => {
  test('accepts revoked exchange leases only, ledgers the reason, restores no tokens', async () => {
    const m = await g.mintExchangeAccess('s', 'julian');
    g.leaseRevoke('browser:s', 'test');
    expect(g.reinstate('browser:s', 'approver:m', 'mistake')).toEqual({ ok: true });
    expect(await g.validateAccess(m.accessToken)).toBeNull();          // no token resurrection
    expect((await g.mintExchangeAccess('s', 'julian')).status).toBe('ok'); // the holder re-exchanges
    expect(g.entries(10).some((e) => e.verb === 'reinstated' && e.detail.includes('mistake'))).toBe(true);
  });
  test('killed-rotation is undone by no verb', () => { /* device lease killed via replay → reinstate → {error:'not-revoked'} */ });
  test('a revoked device lease is not reinstatable (flow-scoped)', () => { /* device lease revoked → {error:'not-exchange'} */ });
  test('reinstate clears sitting pin and latch', () => { /* set via direct SQL, reinstate, read columns NULL */ });
});

describe('validateByHandle (R2-D3)', () => {
  test('answers for a live (lease, token) handle; null once expired or lease dead', async () => { /* mint, validateByHandle ok; advance clock → null; revoke → null */ });
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per Produces/semantics. `reinstate` state machine order: row lookup (id or name) → `not-found`; `flow !== 'exchange'` → `not-exchange`; `status !== 'revoked'` → `not-revoked` (this is the branch `killed-rotation` dies in); then `UPDATE leases SET status='living', sitting_pin=NULL, latch=NULL`, ledger verb `reinstated` with `by` and `reason` in detail.
- [ ] **Step 4: Run the full broker suite** — green; pay attention to `lease-auth.test.ts`/`mcp.test.ts` compiling against the grown `LeaseIdentity` (new fields are additive; the legacy pseudo-lease constructions in `lease-auth.ts:110` must gain `subject: null, flow: 'legacy', tokenId: null, sittingPin: null, latched: null` — make that edit here, it is this task's type change).
- [ ] **Step 5: Commit** — `git commit -am "b3: exchange machinery — access-only delegated leases, session cap refuses not evicts, reinstate state machine, by-handle validation"`

---

### Task 6: Governor — socket tickets, atomic consume

**Type:** implementation
**Depends-on:** 5
**Review:** adversarial

**Files:**
- Modify: `broker/src/governor.ts`
- Test: `broker/test/governor-tickets.test.ts`

**Interfaces:**
- Consumes: Task 5's `token_id` attribution.
- Produces:
  - `TICKET_PREFIX = 'jst_'`, `TICKET_TTL_SECONDS = 60`, `TICKET_MINT_CAP = 10` (live tickets per lease)
  - `async mintTicket(leaseId: string, tokenId: string): Promise<{ status: 'ok'; ticket: string; expiresIn: 60 } | { status: 'cap' }>` — prunes `kind='ticket' AND expires <= now` (kind-scoped) on every mint; row: hash PK, `kind='ticket'`, `generation=0`, `expires = now + 60_000`, `token_id = tokenId`, `used=0`. A retried mint after a lost response is simply a second row.
  - `async consumeTicket(ticket: string): Promise<{ ok: true; leaseId: string; tokenId: string; subject: string | null; scope: string; flow: string; principal: string } | { ok: false; error: 'unknown' | 'expired' | 'reused' }>` — **the mechanism, not the adverb (SEC NEW-8)**: `sha256Hex` is the only await and runs first; then, in one uninterrupted turn: SELECT the row+lease join; no row → `unknown`; burn via `UPDATE lease_tokens SET used = 1 WHERE hash = ? AND used = 0` — `rowsWritten === 0` on an existing row → `reused` (ledger a first-class theft-signal row: verb `ticket-reused`, allowed 0, detail carries `token_id` — never collapsed by the fold); burned but `expires <= now` → `expired` (row already spent, correctly — a late ticket is dead either way); lease not living → treat as `unknown`-shaped refusal with its own detail. The success ledger row (verb `ticket.consume`, allowed 1) writes after the burn inside the same method.

**Parallelization rationale:** none — same-file chain link; the no-await discipline mirrors `governor.ts:334-338` and `registrar.ts:288-292`, named in the body so the implementer copies the house pattern.

- [ ] **Step 1: Write the failing tests** — `governor-tickets.test.ts`: mint returns `jst_`-prefixed 47-char token and stores only a hash (leaseExport dump never matches `/jst_/`); consume once → `{ok:true, …}` carrying the binding `(leaseId, tokenId)`; **two concurrent presentations** (`await Promise.all([g.consumeTicket(t), g.consumeTicket(t)])` — exactly one `ok:true`, the other `reused`, and a `ticket-reused` ledger row exists); expired ticket (drive `now()`) → `expired`; unknown → `unknown`; TTL row honored; cap: 11th live mint → `{status:'cap'}`, prune frees it; **ticket rows never evict access rows and vice versa** (mint 10 tickets, then `mintExchangeAccess` prune leaves them; exchange-access prune predicate is `kind`-scoped — assert both directions); rotation arithmetic ignores `generation=0 kind='ticket'` rows (run a device rotation with a stray ticket row present: unchanged behavior).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per Produces.
- [ ] **Step 4: Run the full broker suite** — green.
- [ ] **Step 5: Commit** — `git commit -am "b3: socket tickets — 60s single-use, atomic burn by rowsWritten, reuse is a ledgered theft signal"`

---

### Task 7: Governor — sitting pin and latch state

**Type:** implementation
**Depends-on:** 6
**Review:** adversarial

**Files:**
- Modify: `broker/src/governor.ts`
- Test: `broker/test/governor-package-state.test.ts`

**Interfaces:**
- Consumes: Task 4's `sitting_pin`/`latch` columns; Task 5's `LeaseIdentity.sittingPin/latched`.
- Produces:
  - `seatSitting(leaseId: string, pin: string): void` — sets `sitting_pin = pin`, `latch = NULL` (the reset act clears the latch counter with it, R2-D4)
  - `setLatch(leaseId: string, pin: string, path: string): void` — stores `latch = JSON {pin, path}`
  - `clearLatch(leaseId: string): void`
  - All three no-ops (never throw) on an unknown lease id; state readable through `validateAccess` (Task 5) so package reads pay no extra DO round trip.

**Parallelization rationale:** none — same-file chain link; deliberately dumb state verbs, because the *policy* (who may latch, when to clear) lives in Task 16's read path where the reviewer can see it whole.

- [ ] **Step 1: Write the failing tests** — seat stores the pin and clears an existing latch; setLatch/clearLatch round-trip through `validateAccess` (`sittingPin`, `latched` fields); reseat with a new pin clears the latch; unknown lease id: silent no-op.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Full broker suite green.**
- [ ] **Step 5: Commit** — `git commit -am "b3: governor sitting-pin and latch state verbs"`

---

### Task 8: The exchange and ticket faces — `/exchange`, `/socket-ticket`, one CORS wrapper

**Type:** implementation
**Depends-on:** 2, 3, 6
**Review:** adversarial

**Files:**
- Create: `broker/src/exchange.ts`
- Modify: `broker/src/index.ts`
- Test: `broker/test/exchange.test.ts`

**Interfaces:**
- Consumes: `verifyWithKeySet` (`julian-shared/auth`, Task 2 — returns `{sub, exp}`); `keySetFor` (`broker/src/auth.ts`); `EXCHANGE_SCOPES` (Task 1); `Env.STREAM_SUBS/APP_ORIGINS/EXCHANGE_RL` (Task 3); `gov.mintExchangeAccess`, `gov.validateAccess`, `gov.mintTicket` (Tasks 5–6); `json` from `./lease-auth`.
- Produces:
  - `parseStreamSubs(raw: string | undefined): { map: Map<string, string>; listed: Set<string> }` — entries split on `,`; `sub=principal` populates both; a bare `sub` (no `=`, or empty principal) populates `listed` only. Empty/unset raw → both empty.
  - `corsHeadersFor(req: Request, env: Env): Record<string, string>` — exact-match against `APP_ORIGINS`; on match: `Access-Control-Allow-Origin: <origin>`, always `Vary: Origin`; never `*`, never credentials.
  - `handleExchange(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response>`
  - `handleSocketTicket(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response>`
  - Routing in `index.ts`, with the self-authenticating faces (never under `/leases/`): `if (path === '/exchange') return handleExchange(…)`; `if (path === '/socket-ticket') return handleSocketTicket(…)`.
- `handleExchange` order (the two SEC NEW-17/rate refinements inline): OPTIONS → 204 with CORS + `Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Max-Age: 86400`, counting against nothing. POST → every response (success and refusal alike) carries `corsHeadersFor` + `Vary: Origin`. Then: no/malformed bearer → 401 `bad-session`; `env.OIDC_AUDIENCE` unset/empty → 503 `no-audience` (fail-closed); verify via shared verifier (issuer + audience) — **on failure**, consult-and-increment `EXCHANGE_RL` (`key = sub-less, use the connecting IP via `req.headers.get('CF-Connecting-IP') ?? 'unknown'``): binding present and `!success` → 429 `rate`, else 401 `bad-session` (the stated refinement: verified requests never touch the limiter; a missing binding refuses no one — both tested); parse `STREAM_SUBS`: sub not in `listed` → 403 `not-listed`; in `listed` but not in `map` → 403 `unmapped` (**never defaulted**); `gov.mintExchangeAccess(sub, map.get(sub))` → `revoked` → 403 `class:"revoked"` (terminal wording: "exchange refused: lease revoked — a standing act (reinstate) is required; signing in again will not help"); `session-cap` → 429 `session-cap`; ok → 200 wire shape. Every refusal and every success is ledgered — successes via the mint's own row… the mint writes no ledger row, so `handleExchange` calls `gov.recordAllowed(leaseId?…)`: mint result carries no leaseId — extend: on ok, call `gov.recordAllowed('browser:'+sub-keyed lease` — instead, keep it simple and honest: after a successful mint, call `gov.reserveLease` is wrong (spends caps); use `gov.recordAllowed(<leaseId>, …)` — `mintExchangeAccess` must therefore also return `leaseId`; add it to the Task 5 Produces shape (`{ status:'ok'; leaseId; accessToken; tokenId; expiresIn }`) — the Task 5 implementer includes it; this Interfaces block is the coordination point. Refusals ledger via `gov.reserveLease(<leaseId-or-'exchange'>, …, 0, 0)` only where a lease row exists (`revoked`, `session-cap`); pre-lease refusals (bad JWT, unmapped) have no lease to pen and are deliberately unledgered — stated in a comment.
- `handleSocketTicket`: same CORS wrapper; bearer must be `jla_` → `gov.validateAccess` → null → 401; `flow !== 'exchange'` → 403 `not-a-session` (SEC NEW-13 — a device/full-house lease keeps `Authorization` upgrades and never mints tickets); `gov.mintTicket(leaseId, tokenId)` → `cap` → 429 `rate`; ok → 200 `{ticket, expires_in:60}`.

**Parallelization rationale:** new-file seam — the browser-facing face set lives in one module so a third browser endpoint cannot forget the wrapper (PROTO N5 is answered structurally); independent of the register face (Task 9) except for the router lines this task owns.

- [ ] **Step 1: Write the failing tests** — `exchange.test.ts`, driving the worker's exported `fetch` with a local JWKS (`OIDC_JWKS_JSON` seam) exactly as `lease-auth.test.ts` does. Cover, at minimum: happy path (mapped sub → 200, token validates, scope `stream`, no refresh row in export); CORS matrix (allowed origin echoed + `Vary: Origin` **on a 403 refusal and on OPTIONS** (SEC NEW-17); disallowed origin → no ACAO header on both faces); audience fail-closed (env without `OIDC_AUDIENCE` → 503 `no-audience`); `STREAM_SUBS` fail-closed三 (empty var refuses a valid JWT `not-listed`; `sub-without-=` entry → `unmapped`, and the minted-lease count stays zero — never defaulted to julian); rate-limit refinement (stub `EXCHANGE_RL` returning `success:false` → a garbage token → 429 `rate`, but a **valid** token with the same stub → 200 — verified never limited); **fail-open**: `EXCHANGE_RL` deleted from env → garbage token → 401 (not 429), valid token → 200; revoked lease → 403 `revoked`; at-cap → 429 `session-cap` and the prior token still validates; `/socket-ticket`: exchange lease → 200 jst_; device-flow full-house lease token → 403 `not-a-session`; expired access token → 401; OPTIONS never mints.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement per the order above.** **Step 4: Full broker suite green.**
- [ ] **Step 5: Commit** — `git add broker/src/exchange.ts broker/src/index.ts broker/test/exchange.test.ts && git commit -m "b3: /exchange and /socket-ticket — delegated session mint behind one CORS wrapper, fail-closed subs map, verified-never-limited"`

---

### Task 9: The register grows — JWT introspect arm, by-handle, consume-ticket, allowed pen, reinstate

**Type:** implementation
**Depends-on:** 8
**Review:** adversarial

**Files:**
- Modify: `broker/src/as/admin.ts`
- Modify: `broker/src/index.ts`
- Test: `broker/test/admin.test.ts`

**Interfaces:**
- Consumes: `verifyWithKeySet` + `keySetFor` (Task 2), `parseStreamSubs` (Task 8), `gov.validateByHandle`/`gov.reinstate` (Task 5), `gov.consumeTicket` (Task 6), `gov.legacySyncAllowed` (Task 4), `gov.recordAllowed` (Task 4), wire shapes from `julian-shared/gate-contract` (Task 1).
- Produces: the four wire contracts from Global Constraints (`/introspect` three forms, `/consume-ticket`, `/allowed`, `/leases/reinstate`), plus `GET /leases` carrying `approver_subs` and `stream_subs` (SEC NEW-16). The `broker/src/index.ts` change is one line each: `/allowed` and `/consume-ticket` join the `:132` admin-path condition routing into `handleAdmin`; `/leases/reinstate` already routes via the `startsWith('/leases/')` arm and needs no router edit.
- `/introspect` dispatch order inside the secret-guarded handler: form has `token` starting `jla_` → existing `validateAccess` path, response now also carrying `subject`, `flow`, `token_id` (nullable) — `door_name` stays present (COLD M-8); `token` starting `jst_` → `{active:false}`; any other `token` → **the JWT arm**: shared verify against the broker's own JWKS/issuer/audience (audience fail-closed here too) → definitive failures (`bad signature/issuer/audience/expired`) → `{active:false}`; verified but sub unmapped in `STREAM_SUBS` → `{active:false}` (definitive); window closed (`LEGACY_WINDOW_END`) or `!legacySyncAllowed()` → `{active:false}`; **JWKS unreachable/unparseable → 503** (indefinite — never `{active:false}`; wrap only the network fetch, not the signature check); active answer: `{active:true, scope:'stream', lease_id:'legacy-window-sync', door_name:'legacy-window-sync', principal:<map[sub]>, subject:<sub>, flow:'legacy', exp:<jwt exp>}`. No `token`, but `lease_id`+`token_id` → by-handle: `gov.validateByHandle`; for `flow='exchange'` results additionally re-apply `STREAM_SUBS` (subject dropped from the map → `{active:false}` — the account-level kill switch, §6.2). `sub`+`exp`+`kind=legacy` → legacy by-handle: re-apply `STREAM_SUBS` + window + `legacySyncAllowed` + `exp > now` → active shape as above.

**Parallelization rationale:** none — this is the auth authority consolidating; one reviewer sees every introspection form side by side.

- [ ] **Step 1: Write the failing tests** — extend `admin.test.ts`: JWT arm happy path asserts the exact §6.6-step-2 probe shape `{active:true, scope:'stream', lease_id:'legacy-window-sync'}` + `subject`/`principal`/`door_name`/`exp`; unmapped sub definitive false; revoked `legacy-window-sync` definitive false while `jla_` introspection still works; JWKS fetch failure (point `OIDC_JWKS_URL` at a closed port, no `OIDC_JWKS_JSON`) → 503 not `{active:false}`; by-handle live/dead/exchange-sub-removed; legacy by-handle window/exp; `/consume-ticket` proxies the governor verdicts; `/allowed` requires the five fields (mirror the `/refusals` 400 test), writes `allowed:1`; `/leases` readout carries both membership lists; `/leases/reinstate` gated (no credential → 401), happy path + 409s.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Full broker suite green.**
- [ ] **Step 5: Commit** — `git commit -am "b3: gate is the one auth authority — JWT arm (fail-closed audience, indefinite JWKS), by-handle forms, consume-ticket, allowed pen, reinstate route, membership readout"`

---

### Task 10: Sync router — one authority, ticket handoff, the slot matrix

**Type:** implementation
**Depends-on:** 2
**Review:** adversarial

**Files:**
- Modify: `sync/src/index.ts`
- Modify: `sync/src/auth.ts`
- Test: `sync/test/router-scope.test.ts`
- Test: `sync/test/router-tickets.test.ts`

**Interfaces:**
- Consumes: `EXPORT_SCOPES`, `SOCKET_SCOPES`, `SOCKET_REQUIRED_MSG` (`julian-shared/scopes`); `SYNC_AUTH_HEADER`, `CONSUME_TICKET_PATH`, `ALLOWED_PATH`, wire shapes (`julian-shared/gate-contract`); the gate's `/introspect` JWT arm and `/consume-ticket` (Task 9's contract — built against the fixture, not the sibling's code).
- Produces (in `sync/src/auth.ts`):
  - `consumeTicket(ticket: string, gate: GateFetcher, secret: string): Promise<ConsumeTicket>` — **dedicated uncached call** (R2-D2): posts `CONSUME_TICKET_PATH`; non-200 → throw (indefinite); returns the wire verdict. Never touches `introspectCache` — a separate function so a refactor cannot re-lose the property (asserted by test).
  - `introspectByHandle(form: Record<string, string>, gate: GateFetcher, secret: string, opts?: { bypassCache?: boolean }): Promise<LeaseIntrospection & { subject?: string; flow?: string; tokenId?: string; exp?: number }>` — cache key `handle:<lease>:<token>` / `legacy:<sub>:<exp>`, 60 s, definitive-only, same throw-on-indefinite discipline; `bypassCache` for the sweep.
  - `introspectLease` unchanged for `jla_`; its response type grows the optional `subject/flow/tokenId/exp` fields (the gate now sends them).
  - `Env` loses `OIDC_ISSUER/OIDC_JWKS_URL/OIDC_JWKS_JSON/OIDC_AUDIENCE` **uses** (interface fields deleted; jose import deleted; the re-export from Task 2 deleted); `sync/package.json` drops `jose`; `sync/wrangler.toml` `[vars]` OIDC entries deleted (live at deploy step 3; rollback redeploys the prior commit whole).
- Produces (router behavior, `sync/src/index.ts`):
  1. First act of `fetch`: rebuild the inbound request **without** `X-Sync-Auth` (strip unconditionally — a server-side client could otherwise forge it; test drives a forged header and asserts the DO never sees it).
  2. `/internal/*` paths: reserved — this task returns 404 for them ahead of `parsePath` (Task 14 fills them in); everything else routes as today.
  3. Bearer classification replaces the current `else` JWT branch: token from header or `?token=`; `jla_` rules unchanged; **`jst_` anywhere except `?ticket=` → 401 `'a socket ticket rides in ?ticket= only'`**; `?ticket=` present → must be a socket path (`isExport` → 401 `'a ticket opens a socket, nothing else'` — the §12 `/export?ticket` cell), must be `jst_` → else 401, must be an Upgrade request → 426; `consumeTicket` → throw → 503; `{ok:false}` → 401 typed per error (`'ticket expired — mint another'` / `'ticket already used — mint another; this reuse is on the ledger'` / `'not a living ticket'`); then scope ∈ `SOCKET_SCOPES` and `principal` owns the store (refusals reported to the gate's denied pen as today).
  4. Non-`jla_`, non-`jst_` bearer (header or `?token=`) → **the gate's JWT arm** via the existing `introspectLease` call (it is just a token to sync now); active → treat exactly like a lease introspection (scope/principal checks by the shared sets). Local JWT verification is gone.
  5. On every **allowed socket upgrade** (lease, ticket, or JWT): forward to the DO with `SYNC_AUTH_HEADER` set to the `SyncAuthPayload` JSON (`Upgrade`, `Connection`, `sec-websocket-*` headers preserved — rebuild via `new Request(req, { headers })` pattern that copies then mutates), and fire-and-forget a positive-pen report (`ALLOWED_PATH`, verb `socket`, detail `open token_id=<tokenId ?? 'jwt'>`) via `ctx.waitUntil` (COLD M-8: a healthy open ledgers `allowed:1`).
  6. `/export` with an active non-export scope refuses as today, with the shared set.

**Parallelization rationale:** the router is rebuilt once, against the Task 1 fixture, while the gate side (Task 9) builds against the same fixture in parallel — the drift that produced issue #28 is prevented by the shared shapes both suites assert, not by ordering.

- [ ] **Step 1: Write the failing tests.** `router-tickets.test.ts` drives the exported router `fetch` with a fake `GATE` (per-test env injection, the existing `router-scope.test.ts` pattern) and asserts: **the full slot/prefix matrix, one test per cell** (PROTO N8 — nine cells from Global Constraints); **single-use driven through the sync router twice in one isolate** (R2-D2's regression: fake gate consumes once then answers `reused`; the second upgrade must 401 — proving no cache sits in front of consume); forged `X-Sync-Auth` on a public request is stripped (fake DO stub records received headers); allowed-pen fired on a healthy open; ticket on `/export` → 401; non-Upgrade with `?ticket=` → 426; gate-down during consume → 503 never 401. Extend `router-scope.test.ts`: JWT branch now introspects via GATE (fake gate returns the legacy-window-sync active shape; assert the socket path admits scope `stream`), and drops when the fake gate answers `{active:false}`.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Full sync suite green** (`cd sync && bun run test`), and `cd broker && bun run test` (the broker's Task 2 re-export no longer exists — its `auth.ts` already imports from shared).
- [ ] **Step 5: Commit** — `git commit -am "b3: sync router — gate is the one authority (JWKS out), jst_ ticket handoff with uncached consume, slot matrix, internal-header strip, allowed pen"`

---

### Task 11: Sync DO — attachments as handles, by-handle re-auth

**Type:** implementation
**Depends-on:** 10
**Review:** adversarial

**Files:**
- Modify: `sync/src/do.ts`
- Test: `sync/test/do-scope.test.ts`
- Test: `sync/test/do.test.ts`

**Interfaces:**
- Consumes: `SYNC_AUTH_HEADER`/`SyncAuthPayload` (Task 1), `introspectByHandle` (Task 10), `SOCKET_SCOPES`/`SOCKET_REQUIRED_MSG` (Task 1).
- Produces:
  - `interface SocketAttachment { leaseId: string; tokenId?: string; subject?: string; exp?: number; flow: string; verifiedAt: number; indefiniteSweeps: number }` — **no raw bearer is ever serialized again, any socket class** (the `leaseToken` field and `extractLeaseToken` die).
  - `fetch`: reads `SYNC_AUTH_HEADER` from the router-forwarded upgrade (the DO trusts it — the router strips inbound forgeries), attaches `SocketAttachment` via the existing `sec-websocket-key` → `getWebSockets(clientId)` lookup.
  - `webSocketMessage` re-auth (interval unchanged, 300 s): `flow === 'legacy'` → `introspectByHandle({sub, exp: String(exp), kind: 'legacy'}, …)`; else → `introspectByHandle({lease_id, token_id}, …)`. Verdicts: throw → 4002; `active:false` → **4001** when the lease is dead/revoked, **4004** when the by-handle answer distinguishes an expired minting token — the gate's by-handle `{active:false}` carries no sub-reason, so the DO decides: attachment `flow !== 'legacy'` and a fresh introspection of the *lease* would be over-engineering; instead the gate's by-handle response includes `"reason":"token-expired"` beside `active:false` for exactly this case — **add that to the Task 9 wire (one field, by-handle form only)** and this task consumes it: `reason === 'token-expired'` → close 4004 `'access token expired — re-exchange'`; otherwise 4001. Scope/ownership re-check as today (4003), with the message string from `SOCKET_REQUIRED_MSG` and the sets from shared; the re-auth success re-stamps `verifiedAt` and resets `indefiniteSweeps`.

**Parallelization rationale:** none — do.ts chain; the 4004-vs-4001 distinction is the §12 "survives-while-token-lives / closes-on-expiry" pair's foundation.

- [ ] **Step 1: Write the failing tests.** Extend the DO tests (existing `do-scope.test.ts` harness constructs the DO and drives `webSocketMessage` with fake attachments/env): attachment written from `X-Sync-Auth` on upgrade contains handle fields and never a token string (serialize a real upgrade through the DO fetch with the header, read back `deserializeAttachment`, assert `JSON.stringify(attachment)` matches no `/jla_|jst_/` and has `leaseId/tokenId`); stale-attachment re-auth calls by-handle (fake records the form) — exchange socket with living lease survives past the interval; `active:false` → 4001; `active:false, reason:'token-expired'` → 4004; gate throw → 4002; scope-lost → 4003 with the shared message; JWT-flow attachment re-auths via the legacy form and a sub dropped from the map (fake answers false) closes.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** (remember: also add the `reason` field to Task 9's by-handle response — if Task 9 already merged, this task edits `admin.ts` **only if** the field is absent; the Interfaces blocks of both tasks name it, so whichever lands second reconciles — it is one response-literal line).
- [ ] **Step 4: Full sync suite green.**
- [ ] **Step 5: Commit** — `git commit -am "b3: DO attachments are handles — no raw bearers; by-handle re-auth with 4001/4002/4003/4004 verdicts"`

---

### Task 12: Sync DO — the alarm sweep

**Type:** implementation
**Depends-on:** 11
**Review:** adversarial

**Files:**
- Modify: `sync/src/do.ts`
- Test: `sync/test/do-sweep.test.ts`

**Interfaces:**
- Consumes: Task 11's `SocketAttachment` (its `indefiniteSweeps` counter), `introspectByHandle` (`bypassCache: true`).
- Produces: `SWEEP_INTERVAL_MS = 300_000`; `alarm()` implementing the SEC NEW-5/OPS N-7/COLD M-10 contract:
  - **Lifecycle:** `fetch` arms the alarm after a successful socket attach (`ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS)` if none pending — `getAlarm()` first); `alarm()` re-arms while `this.ctx.getWebSockets().length > 0`; `webSocketClose(ws, …)` **overrides and calls `super.webSocketClose(...)` first** (TinyBase client bookkeeping), then deletes the alarm when the last socket is gone. (TinyBase's `WsServerDurableObject` uses no alarm — the slot is free; verified, spec §3.)
  - **Ordering:** snapshot `const pathId = this.getPathId()` before closing anything (closing in a loop can empty the socket list mid-sweep and mislabel survivors 4003).
  - **Dedupe:** group attached sockets by identity key (`${leaseId}:${tokenId ?? sub}`), one `introspectByHandle(…, {bypassCache: true})` per distinct key per sweep.
  - **Verdicts per key:** definitive `active:false` → close all that key's sockets 4001 (or 4004 on `reason:'token-expired'`); active → also re-check scope/ownership against the snapshot (4003 path), reset each socket's `indefiniteSweeps` to 0 and re-stamp `verifiedAt`; **indefinite (throw)** → increment each socket's `indefiniteSweeps` in its attachment; `>= 3` → close 4002 (`'introspection unavailable across 3 sweeps'`) — a single gate blip leaves the fleet attached (no synchronized ticket-mint storm against a recovering gate).
  - **No stale-only optimization:** every attached socket's key is validated unconditionally, every sweep — sweeping only stale-`verifiedAt` sockets loses the silent-receiver bound (a chatty socket re-stamps from cache).

**Parallelization rationale:** none — do.ts chain; the sweep is the honest-SLA guarantee (§6.2's three numbers) and reviews as one unit.

- [ ] **Step 1: Write the failing tests** — `do-sweep.test.ts` (fake `introspectByHandle` injected the way Task 11's tests fake it; drive `alarm()` directly): a revoked silent socket closes 4001 at the sweep (never having sent traffic); one indefinite sweep leaves the socket attached (`indefiniteSweeps === 1`), the third closes 4002; a healthy sweep resets the counter; two sockets sharing one `(leaseId, tokenId)` produce exactly one introspection call (spy count); sweep bypasses the cache (fake asserts `bypassCache`); alarm re-arms while sockets remain (spy on `setAlarm`) and cancels at last close; `webSocketClose` calls `super` (spy via prototype patch); pathId snapshot taken before closes (fake `getPathId` throws if called after a close — or assert call order via spy sequence).
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Full sync suite green.**
- [ ] **Step 5: Commit** — `git commit -am "b3: alarm sweep — silent-receiver bound at 5min, 3-strike indefinite tolerance, per-handle dedupe, super-preserving close"`

---

### Task 13: Stream read functions — pure verbs over the store

**Type:** implementation
**Depends-on:** 1
**Review:** lean

**Files:**
- Create: `sync/src/reads.ts`
- Test: `sync/test/reads.test.ts`

**Interfaces:**
- Consumes: `StreamRow` (Task 1's contract), `MergeableStore` (`julian-shared/schema`'s `createStreamStore`).
- Produces (pure, no I/O — callable from the DO):
  - `READ_MAX_ROWS = 200`, `READ_MAX_BYTES = 196_608`
  - `readRecent(store: MergeableStore, limit?: number): { rows: StreamRow[]; truncated: boolean }` — messages sorted by `ts` ascending, last N (limit clamped server-side to `READ_MAX_ROWS`); rows carry `{id, sessionId, role, speakerName, text, ts, kind}` (**`text` only — never the `content` block array**); accumulation stops at `READ_MAX_BYTES` of serialized rows with `truncated: true` flagged in-band.
  - `readSession(store, sessionId: string, range?: { from?: number; to?: number }): same shape` — rows where `sessionId` matches and `ts` within the range.
  - `readSearch(store, query: string, limit?: number): same shape` — case-insensitive **substring** match on `text` (no caller-supplied regex, ever — the query is used via `String.prototype.includes` on lowercased text), newest first, clamped.

**Parallelization rationale:** pure-function seam — the verbs are testable without a DO or a socket, so this task runs in the first wave while the router/DO chain proceeds; a good engineer separates query logic from transport regardless.

- [ ] **Step 1: Write the failing tests** — build a store with `createStreamStore('t')`, seed ~10 messages across two sessions, assert ordering/clamps/range/substring semantics; a regex-metacharacter query (`'a.*b'`) matches only its literal text; byte cap: seed one 100 KB text row + others, assert `truncated: true` and no row split mid-way; `content` arrays never appear in rows.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Sync suite green.**
- [ ] **Step 5: Commit** — `git add sync/src/reads.ts sync/test/reads.test.ts && git commit -m "b3: pure stream read verbs — recent/session/search with clamps and in-band truncation"`

---

### Task 14: Internal read routes — the guarded road into the store

**Type:** implementation
**Depends-on:** 10, 12, 13
**Review:** adversarial

**Files:**
- Modify: `sync/src/index.ts`
- Modify: `sync/src/do.ts`
- Modify: `sync/src/auth.ts`
- Test: `sync/test/internal-read.test.ts`

**Interfaces:**
- Consumes: `INTERNAL_READ_PREFIX`, `SYNC_READ_SECRET_HEADER`, `InternalReadRequest/Response` (Task 1); `timingSafeEqual` (`julian-shared/auth`); `storePathFor` (Task 1); `readRecent/readSession/readSearch` (Task 13).
- Produces:
  - `sync/src/auth.ts`'s `Env` interface gains `SYNC_READ_SECRET: string` (secret; installed at deploy step 0).
  - Router (`index.ts`): `POST /internal/read/{recent|session|search}` matched **ahead of `parsePath`** (which would 404 them pre-auth — asserted); **first statement** of the branch: `timingSafeEqual(req.headers.get(SYNC_READ_SECRET_HEADER) ?? '', env.SYNC_READ_SECRET)` — empty secret env or mismatch → **bodiless 403** (the secret is the enforcement; the binding is only the road — no structural guard is claimed); parse JSON body; `storePathFor(body.principal)` null → 403 (also covers the reserved `internal` principal); forward `new Request('https://do/read/<kind>', {method:'POST', body})` to the store's DO stub. Any public GET/POST to `/internal/*` without the secret → 403 ahead of `parsePath` (§12).
  - DO (`do.ts` fetch): `POST /read/{recent|session|search}` → Task 13 functions over `this.store` → `Response.json({ok: true, rows, truncated})`.
  - `/internal/` is reserved: `storePathFor` already refuses the `internal` principal (Task 1), so no store path can collide — restate in a router comment.

**Parallelization rationale:** none — closes the sync chain; the secret-first ordering and pre-parsePath match are the reviewable security properties.

- [ ] **Step 1: Write the failing tests** — `internal-read.test.ts` (router-level, fake DO namespace recording forwarded requests): correct secret + `{principal:'julian', limit:5}` → forwarded to the `julian/chat` DO with path `/read/recent`; wrong/missing secret → 403 with empty body; a `principal` of `internal` or `Not-Valid` → 403, nothing forwarded; `/internal/read/recent` reached ahead of `parsePath` (assert 403-not-404 for a secretless probe); DO-level: seed the DO's store, POST `/read/search` → rows per Task 13 semantics.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Full sync suite green.**
- [ ] **Step 5: Commit** — `git commit -am "b3: /internal/read routes — constant-time secret first, storePathFor addressing, DO read verbs"`

---

### Task 15: Broker stream verbs — the face reads the record

**Type:** implementation
**Depends-on:** 2, 3
**Review:** adversarial

**Files:**
- Create: `broker/src/services/stream.ts`
- Modify: `broker/src/mcp.ts`
- Modify: `broker/src/lease-auth.ts`
- Test: `broker/test/stream-verbs.test.ts`

**Interfaces:**
- Consumes: `Env.SYNC/SYNC_READ_SECRET` (Task 3), `INTERNAL_READ_PREFIX` + wire shapes (Task 1), `scopeAllows`/`reserve` (existing), `SCOPE_VERBS` already carrying `stream.*` (Task 2's swap).
- Produces:
  - `STREAM_READ_CAP_PER_DAY = 500` (per-lease, in `lease-auth.ts`: `leaseCapFor` returns it for `service === 'stream'`; the legacy pseudo-leases stay exempt exactly as mail does)
  - `streamRead(env: Env, kind: 'recent' | 'session' | 'search', principal: string, args: Record<string, unknown>): Promise<{ ok: true; rows: StreamRow[]; truncated: boolean } | { ok: false }>` — POST through the `SYNC` binding with the secret header; **any** non-200, parse failure, or throw → `{ok: false}` (both directions fail to refusal)
  - `hmacHex(key: string, data: string): Promise<string>` (crypto.subtle HMAC-SHA256) — the ledger's args-hash
  - Three tools appended to `TOOLS` (service `stream`, verbs `recent`/`session`/`search`), visible only to stream-capable leases via the existing `visibleTools` filter:
    - `stream_recent {limit?: number}`
    - `stream_session {sessionId: string, range?: {from?: number, to?: number}}`
    - `stream_search {query: string, limit?: number}`
  - Tool results are self-sufficient in both halves (the Aug-12 structuredContent lesson): text renders the rows compactly (`[ts] speaker: text` lines + a truncation notice); `structuredContent: {rows, truncated}`. Failure → `toolError('stream unavailable — the stream could not be read; this is a refusal, not an empty result')`.
  - `callTool` flow for stream tools: `reserve(gov, auth, 'stream', verb, detail)` **before** the binding call, detail = `principal=<auth.principal> args=<hmac12> `; after a successful read, the same reserve row already stands (the read is the reserved act); result size appended is not re-ledgered (one row per act, the house pattern).
  - Own-principal only: the principal passed to `streamRead` is **always `auth.principal`** — no caller-supplied principal exists on the wire.

**Parallelization rationale:** starts the mcp.ts chain; the transport client is a new file so the sync chain and this task share only the Task 1 fixture.

- [ ] **Step 1: Write the failing tests** — `stream-verbs.test.ts` driving the worker `fetch` with a scripted `SYNC` stub in env (per-test injection): a `stream-read` lease lists the three tools, a `reading-room` lease does not; `stream_recent` forwards `{principal: <lease principal>, limit}` with the secret header (stub records the request and replays the fixture shape — assert against `InternalReadRequest` from `julian-shared/gate-contract`, the both-suites rule); rows come back in both content halves; stub 500 → the `stream unavailable` refusal, `isError: true`, never an empty rows result; a seeded **non-julian principal** lease reads its own store path (stub asserts `principal:'notjulian'`) — tested now, per §8; ledger row carries the hmac'd args (assert `detail` matches `/args=[0-9a-f]{12}/` and never the raw query text); the per-lease rate cap: with `leaseCapFor` returning 2 via a driven clock/day, the third read refuses 429-shaped through `refusalText`; `limit` clamped (stub sees ≤ 200 even when the caller asks for 10 000).
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Full broker suite green** (mcp.test.ts listings for existing scopes unchanged — reading-room sees exactly the four B2 tools).
- [ ] **Step 5: Commit** — `git add broker/src/services/stream.ts broker/src/mcp.ts broker/src/lease-auth.ts broker/test/stream-verbs.test.ts && git commit -m "b3: stream verbs on the face — own-principal reads over the SYNC binding, hmac'd ledger, fail-to-refusal"`

---

### Task 16: Package integrity — sitting pin, bounded atomic latch, pin-bound parts

**Type:** implementation
**Depends-on:** 7, 15
**Review:** adversarial

**Files:**
- Modify: `broker/src/services/package.ts`
- Modify: `broker/src/package-types.ts`
- Modify: `broker/src/mcp.ts`
- Test: `broker/test/package.test.ts`
- Test: `broker/test/mcp.test.ts`

**Interfaces:**
- Consumes: `gov.seatSitting/setLatch/clearLatch` (Task 7), `LeaseIdentity.sittingPin/latched/flow/leaseId` (Task 5), existing `loadManifest`/`readPackageFile` internals.
- Produces:
  - Constants (`package-types.ts`): `PART_THRESHOLD_BYTES = 32_768`, `PART_TARGET_BYTES = 24_576` (the plan-header refinement: catalog.md must actually part).
  - `PackageRead` union grows: `{ class: 'ok'; …existing; part?: number; parts?: number; partBytes?: number; partSha256?: string; fileSha256?: string }` and new failure classes `'pin-moved' | 'part-pin-moved' | 'parts' | 'part-out-of-range' | 'integrity-latched'` — every one a typed, ledgered refusal with the copy below.
  - `readPackageFileVerified(env, callerPath, part?: number)` (rename/extend of `readPackageFile`; the old export remains as a thin wrapper for `resources/read` compatibility): fetch-and-verify **the whole file first, then slice** (never HTTP Range — a ranged body cannot be hash-checked); on a mismatch where `bytes.byteLength === entry.bytes` (**length-verified**), refetch once inside the same call with `cf: { cacheTtl: 0, cacheEverything: false }` (immune to the 300 s edge cache) and re-verify — only a second mismatch reports `mismatchLengthVerified: true` to the caller (truncation/length mismatches keep their existing non-latching `integrity` class); parts: files with `entry.bytes > PART_THRESHOLD_BYTES` **must** carry `part` — absent → `class:'parts'` with message `` `this file serves in ${M} parts; request part 1…${M} and verify every part carries the same fileSha256` ``; the split accumulates whole code points (iterate the decoded string by `for…of`) until adding the next would exceed `PART_TARGET_BYTES` of UTF-8; `M` is server-authoritative and echoed as `parts` with `part`, `partBytes`; `fileSha256` = the manifest hash (the whole-file verification), `partSha256` = sha256 of the part's UTF-8 bytes, **a transport checksum for the client, not a server-side check — it never latches** (SEC NEW-15); `part` outside `1…M`, or `part` supplied for an unparted file → `class:'part-out-of-range'` (message for the unparted case: "this file serves whole; omit part").
  - mcp.ts `ledgeredRead` grows the integrity policy (the policy lives here so one reviewer sees it whole; governor verbs stay dumb):
    - `sharedLease = auth.flow === 'authcode' || auth.leaseId === 'legacy-window' || auth.leaseId === 'legacy-window-sync'` — shared/multi-tenant leases **never latch and hold no sitting state** (SEC NEW-3: one visit's failure never bricks another's reads); they refuse-and-ledger per event.
    - `package_list` (and `resources/list`): after a successful manifest load, `gov.seatSitting(auth.leaseId, pinSha)` (skip for shared) — the listing **is** the reset act and stays a cheap listing (documented no to #32's "should the listing verify"; the latch is the guard).
    - `package_read` (and `resources/read`), non-shared: if `auth.latched` and the requested `(currentPin, path)` ≠ the latched pair → `class:'integrity-latched'`, message `` `package reads are latched for this lease after an unresolved hash mismatch on ${latched.path}; a clean read of that same file at pin ${latched.pin} clears it` ``; if `auth.sittingPin` set and current pin ≠ sitting pin → `class:'pin-moved'` (or `'part-pin-moved'` when a `part` argument is present — the #30 distinct refusal), message `` `pin moved ${old.slice(0,12)} → ${new.slice(0,12)}; run package_list, then re-read from the top` `` — **the refusal names the reset act by tool** so a well-behaved reader recovers without Marcus at a keyboard (KV is eventually consistent, ~60 s per colo; the reset act bounds the flap instead of wedging, R2-D4); on a length-verified double mismatch → `gov.setLatch(auth.leaseId, pinSha, path)` and the integrity refusal notes the latch; on a clean verified read matching the latched `(pin, path)` exactly → `gov.clearLatch` then serve (a clean read of any *other* file clears nothing).
    - `expect_pin` stays an optional client cross-check, validated `/^[0-9a-f]{40}$/` before echo or ledger.
  - Wake text (`WAKE_JULIAN_TEXT`) edits, verbatim additions: after the hash-verification paragraph — "Some files serve in numbered parts: a refusal naming `parts` is an instruction, not damage — request part 1…N and read them in order. Every part of one file must carry the same fileSha256; a part whose fileSha256 differs from part 1's means the ground moved mid-reading — run package_list and start that file again." And after the held-at-home sentence — "If a read is refused because the pin moved, run package_list once and re-read from the top; the package is versioned, not broken."

**Parallelization rationale:** none — mcp.ts chain; §9 is one argument (fail-loud is not fail-closed) and reviews as one unit.

- [ ] **Step 1: Write the failing tests.** `package.test.ts` (module-level, fetch stubbed per existing pattern): parts — a 90 KB fixture file yields `M` parts whose concatenation equals the original **byte-for-byte** and whose per-part `partSha256` verifies; a multi-byte code point straddling the target boundary lands whole in exactly one part; no-`part` on a parted file → `class:'parts'` naming `M`; `part: M+1` → `part-out-of-range`; `part: 1` on a small file → `part-out-of-range` ("serves whole"); length-verified mismatch triggers exactly two upstream fetches (spy), the second with `cacheTtl: 0`, and reports `mismatchLengthVerified` only if both mismatch; short-body (truncation) mismatch fetches once and stays a plain `integrity`. `mcp.test.ts` (worker-level, fake gov + fetch stubs): the sitting lifecycle — list seats the pin; read at a moved pin refuses `pin-moved` naming `package_list`; list again reseats; read resumes at the new pin (the §12 reset flow); part read at a moved pin → `part-pin-moved`; double-mismatch latches (gov spy), next healthy *other* file refused `integrity-latched`, clean re-read of the same `(pin,path)` clears and serves; a `flow:'authcode'` visit lease never seats, never latches, and a mismatch for it still refuses per-event (latched-visit-does-not-refuse-a-second-visit: two visit auths on the same `visit:<host>` lease — the second's reads are untouched by the first's mismatch); wake text contains the parts-are-instruction sentence and the same-fileSha256 rule.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Full broker suite green** (existing package tests hold: files under threshold behave exactly as B2).
- [ ] **Step 5: Commit** — `git commit -am "b3: package integrity — sticky sitting pin with package_list reset, in-call cacheTtl:0 latch, codepoint-safe pin-bound parts"`

---

### Task 17: Visit items and the B2 nits

**Type:** implementation
**Depends-on:** 16
**Review:** adversarial

**Files:**
- Modify: `broker/src/mcp.ts`
- Modify: `broker/src/services/package.ts`
- Test: `broker/test/mcp.test.ts`
- Test: `broker/test/registrar.test.ts`

**Interfaces:**
- Consumes: Task 16's mcp.ts state.
- Produces (§10.1 R-6/R-6′, §10.3):
  - `VISIT_AGENT_TOOL_LINES['read-write']` drops `Bash`: `'Read, Grep, Glob, ToolSearch, Edit, Write, mcp__julian-gate'` — **the read-write visit has no shell** (the true, checkable form).
  - `visitAgentFile(access, workspace?)` — the returned agent file is unchanged in shape (frontmatter has no path-scoping field — R-6′, docs-verified; the design forbids shipping permission-loosening files); the **tool result** gains a second content block and `structuredContent.settingsSnippet`: the host-applyable `settings.json` permissions snippet the host **may** paste —

    ```json
    {
      "permissions": {
        "allow": ["Edit(<workspace>/**)", "Write(<workspace>/**)"],
        "deny": ["Edit(//**)", "Write(//**)"]
      }
    }
    ```

    with a one-line label: "enforcement where you apply this; manners stated at waking where you do not." Read-only variant: result text states the two negative assertions (no Bash, no Write) explicitly.
  - `visit_agent` ledger detail records the chosen variant: the reserve call's detail becomes `` `access=${access}` `` (#31).
  - Nits (§10.3): the `access` cast in `callTool` narrowed (the wire-level `-32602` guard already ran, so type via the validated value, not `as`); the "two list-shaped tools" comment updated to name three (wake_julian, visit_agent, package_list) — and now the stream tools exist, reword to "the list-shaped tools"; `currentPin` export wrapped (`loadManifest` is the public face; `currentPin` becomes module-private or explicitly `/** @internal */`-commented if the harness imports it — check callers first); `loadManifest` gains the entry-shape guard: every `files[]` entry must have string `path`, 64-hex `sha256`, non-negative integer `bytes` → else `integrity('manifest entry malformed', pinSha)`.
  - `registrar.test.ts`: the Task-6-of-B2 leftover — assert the authcode redemption burn is a `DELETE`-free path (`redeem` marks `used=1`, never deletes the row — the tombstone survives for audit; one `expect` on the row's continued existence post-redeem).

**Parallelization rationale:** none — mcp.ts chain link.

- [ ] **Step 1: Write the failing tests** — read-write tools line contains no `Bash` (regex on the tool result); settings snippet present in both content halves with allow/deny pairs; read-only text asserts both negatives; ledger detail `access=read-only` recorded (fake gov captures reserve args); malformed manifest entry (missing sha256) → typed integrity refusal, not a crash; registrar row survives redemption.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Full broker suite green.**
- [ ] **Step 5: Commit** — `git commit -am "b3: visit hands — Bash dropped, host-applyable settings snippet emitted, access variant ledgered, manifest entry guard"`

---

### Task 18: Protocol posture — tolerance pinned, iss emitted, hints scoped

**Type:** implementation
**Depends-on:** 17
**Review:** lean

**Files:**
- Modify: `broker/src/mcp.ts`
- Modify: `broker/src/as/approve.ts`
- Modify: `broker/src/as/authcode.ts`
- Test: `broker/test/mcp.test.ts`
- Test: `broker/test/approve.test.ts`

**Interfaces:**
- Consumes: Task 17's mcp.ts state; `deliverRedirect` (`approve.ts:545-555`), `oauthDiscovery` (`authcode.ts:248+`).
- Produces (§7's four cheap things):
  1. **Notifications rule (live 2025-06-18 MUST):** in `handleMcp`, any parsed message **without an `id` member** → `new Response(null, { status: 202 })`, regardless of method — the special-cased `notifications/initialized` branch generalizes; a *request* (id present) with an unknown method keeps `-32601`.
  2. **Cache hints:** `tools/list` and `prompts/list` results gain `_meta: { 'io.modelcontextprotocol/cacheControl': { ttlMs: 300_000 } }` — and **nothing else does**: not `ping` (its result stays exactly `{}` — `EmptyResultSchema` is `.strict()`), not `resources/list`, not `resources/read` (COLD M-7: a package URI carries no pin; a client honoring `ttlMs` would cache content across a pin bump — silent drift the sitting pin cannot see).
  3. **Tolerance, honestly labeled:** no new code — the tests pin that a raw handshake-less v2-shaped `tools/call` carrying `_meta` protocol version, the `MCP-Protocol-Version` header, and `Mcp-Method`/`Mcp-Name` headers is served (unknown fields tolerated, version header deliberately *ignored*, not validated — a decision, not a conformance claim; request tolerance only).
  4. **RFC 9207 `iss`:** `deliverRedirect` gains an `issuer: string` param (callers pass `env.PUBLIC_URL`) and sets `target.searchParams.set('iss', issuer)` — inside the single delivery point, so the code **and** `access_denied` arms are covered in one edit; `oauthDiscovery`'s AS metadata gains `authorization_response_iss_parameter_supported: true` (a MUST when emitting; byte-identical to the advertised `issuer`, which is also `env.PUBLIC_URL`).

**Parallelization rationale:** none — mcp.ts chain tail; approve/authcode edits ride here because no other task touches those files.

- [ ] **Step 1: Write the failing tests** — id-less `{jsonrpc:'2.0', method:'tools/call', params:{…}}` → 202 empty body; id-less unknown method → 202 (not `-32601`); `ping` result strictly `{}` (`Object.keys(result).length === 0` and no `_meta`); `tools/list` and `prompts/list` carry the hint, `resources/list`/`resources/read` responses carry none; the full v2 envelope request (headers + `_meta` version) is served normally; approve tests: both the code delivery and the refuse (`access_denied`) redirect Locations carry `iss=` equal to `PUBLIC_URL` **and** equal to the discovery document's `issuer` (fetch both in one test — byte-identical); discovery metadata advertises the support flag.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Full broker suite green.**
- [ ] **Step 5: Commit** — `git commit -am "b3: protocol posture — id-less→202, scoped cache hints, v2-envelope tolerance pinned, RFC 9207 iss on both redirect arms"`

---

### Task 19: App exchange client

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Create: `app/src/lib/exchange.ts`
- Test: `app/src/lib/exchange.test.ts`

**Interfaces:**
- Consumes: the `/exchange` and `/socket-ticket` wire contracts (Global Constraints — built against the contract, not the broker's code); `getToken` from `./auth` (injected).
- Produces:
  - `type ExchangeState = { kind: 'ok'; accessToken: string; expiresAt: number } | { kind: 'revoked' } | { kind: 'signed-out' } | { kind: 'retry'; after: number } | { kind: 'error' }`
  - `class ExchangeClient` (constructed with `{ gateUrl: string; getJwt: () => Promise<string | null>; fetchImpl?: typeof fetch }`):
    - `async access(): Promise<ExchangeState>` — returns the cached token while > 5 min of life remains; otherwise POSTs `/exchange` with the Pocket ID JWT: no JWT → `signed-out`; 200 → cache `{token, expiresAt = now + expires_in*1000}`; `class:"revoked"` → `revoked` (**terminal** — the client latches `revoked` and never retries until `reset()` is called: a human act, §6.5); `class:"rate"`/`"session-cap"`/429 → `retry` with backoff (1 s doubling to 30 s cap); network failure/5xx → `retry`; other 4xx → `error`.
    - `async ticket(): Promise<{ ticket: string } | ExchangeStateNonOk>` — ensures `access()`, POSTs `/socket-ticket` with it; a 401 (token died early) drops the cache and re-exchanges **once** silently (expired re-exchanges; only revoked is terminal).
    - `reset(): void` — clears the cache and the terminal latch (called on explicit reload/sign-in).
    - `terminalCount(): number` — consecutive terminal-shaped failures (for the stale-bundle message, Task 20).

**Parallelization rationale:** contract-first client in its own module — testable with a stubbed `fetch`, wave 1, no repo collisions; the store rewiring (Task 20) consumes it.

- [ ] **Step 1: Write the failing tests** (vitest, stubbed `fetchImpl` script per test): happy mint caches (second `access()` makes no fetch); expiry-margin re-mint; `revoked` latches — subsequent `access()` calls return `revoked` **without a network call** (the app stops; count the stub's invocations); `reset()` unlatches; 429 → `retry` with growing `after`; `ticket()` re-exchanges once on a 401 then succeeds; `signed-out` when the JWT provider returns null; no token or ticket ever touches `localStorage` (spy — nothing durable is added by this client).
- [ ] **Step 2: Run to verify failure** — `cd app && bunx vitest run src/lib/exchange.test.ts`. **Step 3: Implement.** **Step 4: App suite green** (`bun run test`), `bun run check` clean.
- [ ] **Step 5: Commit** — `git add app/src/lib/exchange.ts app/src/lib/exchange.test.ts && git commit -m "b3: app exchange client — cached hour-scale access, terminal revoked latch, single silent re-exchange"`

---

### Task 20: App store — the total URL provider

**Type:** implementation
**Depends-on:** 19
**Review:** adversarial

**Files:**
- Modify: `app/src/lib/store.ts`
- Modify: `app/src/components/SyncStatus.svelte`
- Test: `app/src/lib/store.test.ts`

**Interfaces:**
- Consumes: `ExchangeClient` (Task 19); `import.meta.env.VITE_SYNC_URL` (existing) and **new** `VITE_GATE_URL`.
- Produces:
  - `SyncPhase` grows `'revoked' | 'stale'`.
  - `startSync` signature becomes `startSync(getJwt: () => Promise<string | null>, client?: ExchangeClient): Promise<Synchronizer | null>` (client injectable for tests; default constructed from `VITE_GATE_URL` + `getJwt`). The RWS is constructed with an **async URL provider** in place of the static string (RWS `url` accepts `() => Promise<string>`; `protocols` stays `[]` — frozen, verified):

    ```ts
    const provideUrl = async (): Promise<string> => {
      // Total: never rejects, never throws — a rejecting provider holds RWS's
      // _connectLock forever (R2-D1, verified against the library source).
      for (;;) {
        try {
          const t = await client.ticket();
          if ('ticket' in t) return `${base}/${STORE_PATH}?ticket=${encodeURIComponent(t.ticket)}`;
          if (t.kind === 'revoked') {
            setPhase('revoked');
            queueMicrotask(() => ws.close());        // stop from OUTSIDE the provider — RWS has no stop channel of its own
            return `${base}/${STORE_PATH}?ticket=jst_revoked`; // resolve once more with a known-failing URL
          }
          if (t.kind === 'signed-out') { setPhase('offline'); await sleep(backoff()); continue; }
          await sleep('after' in t ? t.after : backoff());
        } catch { await sleep(backoff()); }           // belt over braces: nothing escapes
      }
    };
    ```

  - The `?token=<JWT>` construction dies from the app (the JWT query fallback survives at sync for other clients until the sunset; the app itself moves to tickets now). Close code 4004 (token expired) is handled by the natural reconnect: the next `provideUrl` call re-exchanges via the client. `revoked` is terminal: phase `'revoked'`, socket closed, no loop. Stale bundle: when `client.terminalCount() >= 3` with non-revoked terminal errors, phase `'stale'`.
  - `SyncStatus.svelte` renders the two new phases: `revoked` → "access revoked — a standing act is needed" (amber/off dot); `stale` → "reload for the new Julian".

**Parallelization rationale:** none — consumes Task 19; the provider's totality is the R2-D1 regression and reviews with the client behind it.

- [ ] **Step 1: Write the failing tests** — extend `store.test.ts` with a fake `ExchangeClient`: the provider resolves a `?ticket=` URL (drive it directly — export `__provideUrlForTest` seam or construct via the injected client and read the first ws URL); **an induced mint failure (client throws twice, then succeeds) does not stop the loop** — the provider still resolves (await it with fake timers); terminal revoked: phase becomes `'revoked'`, the provider resolves (does not hang), and `ws.close` was called from outside; three non-revoked terminal errors → phase `'stale'`; no URL ever contains `token=` (regex the produced URLs).
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: App suite green + `bun run check`.**
- [ ] **Step 5: Commit** — `git commit -am "b3: total ticket URL provider — never rejects, revoked is terminal, expired re-exchanges natively, stale bundle surfaces"`

---

### Task 21: Server CSP and the room's truth

**Type:** implementation
**Depends-on:** none
**Review:** lean

**Files:**
- Modify: `server/server.ts`
- Modify: `server/room.ts`

**Interfaces:**
- Consumes: `.env` values already read by the server (`VITE_SYNC_URL`, `VITE_OIDC_ISSUER`; new optional `VITE_GATE_URL`).
- Produces: a `cspFor()` helper building, from env at boot:

  ```
  default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self';
  connect-src 'self' <VITE_SYNC_URL http+ws forms> <VITE_GATE_URL> <VITE_OIDC_ISSUER>;
  frame-ancestors 'none'; base-uri 'self'; form-action 'self' <VITE_OIDC_ISSUER>
  ```

  applied to **app/dist responses and the SPA index fallback only** (`:1938-1948` and `:1963-1967`). The `WORKING_DIR` static branch (`:1950-1961`) — the memory letters, with their live inline scripts — is deliberately left un-CSP'd: a strict policy would break `received.html` and its kin, and the residual same-origin exposure is exactly §15's recorded "app-DOM boundary" accepted risk; say so in a comment citing the spec section. `room.ts` `SERVICES` truth (§6.5): julian-sync's `auth` line becomes "Delegated session lease via the gate's /exchange (browser tabs; 60s single-use socket tickets), door leases for /export (stream-read+); legacy Pocket ID JWTs only until the sunset ceremony." julian-broker's line appends "; browser sessions trade a Pocket ID login for scoped stream standing at /exchange".

**Parallelization rationale:** isolated files, wave 1; a named §6.5/§15 task too small to split.

- [ ] **Step 1: Write the change** (no test harness serves server.ts's static branch today — the verification is behavioral): implement `cspFor()` + header application.
- [ ] **Step 2: Verify by hand** — `bun run server/server.ts` locally, `curl -sI localhost:8000/ | grep -i content-security`, and `curl -sI localhost:8000/memory/received.html | grep -ic content-security` returns 0. Load the app in a browser: no CSP violations in the console; the letters still render.
- [ ] **Step 3: Commit** — `git add server/server.ts server/room.ts && git commit -m "b3: CSP on the app shell (letters exempt, recorded), room tells the lease-and-ticket truth"`

---

### Task 22: stream-export on its own device lease

**Type:** implementation
**Depends-on:** none
**Review:** lean

**Files:**
- Modify: `scripts/stream-export.ts`

**Interfaces:**
- Consumes: `resolveAccessToken(env, leasePath, brokerUrl)` from `scripts/lib/lease-client.ts` (existing — loopback → lease-file → legacy, self-refreshing with the lock discipline).
- Produces: the export authenticates with a **`stream-read` device lease of its own**, refreshed before each run: lease path `process.env.STREAM_EXPORT_LEASE_FILE ?? ~/.julian/stream-export-lease.json`; the loopback is **skipped deliberately** (pass an env copy with `JULIAN_LEASE_URL` deleted — the Mac loopback serves the mac-home full-house lease, and this script must run on the least scope that can read the export); broker URL `process.env.BROKER_URL ?? 'https://julian-broker.julian-memory.workers.dev'`. `SYNC_TOKEN` and the "Clerk" comment die; a missing/expired lease prints the knock instruction (`bun scripts/door-knock.ts` with door name `stream-export`, scope `stream-read` — Marcus approves once) and exits 1. The fetch sends `Authorization: Bearer <jla_…>` (header only, per the sync slot rules). Everything downstream (hash verify, probe store, archive) is untouched.

**Parallelization rationale:** isolated file, wave 1.

- [ ] **Step 1: Make the change**; keep the fail-loud shape (`EXPORT FAILED:` prefixes).
- [ ] **Step 2: Verify** — `bun scripts/stream-export.ts` without a lease file prints the knock instruction and exits 1 (the live export run is §13.3's rehearsal, not this task's).
- [ ] **Step 3: Commit** — `git add scripts/stream-export.ts && git commit -m "b3: stream-export runs on its own stream-read device lease; the Clerk era's comment dies"`

---

### Task 23: Deploy skill carries the sync wiring; the bundle smoke check

**Type:** implementation
**Depends-on:** none
**Review:** lean

**Files:**
- Modify: `.claude/skills/deploy/SKILL.md`
- Create: `scripts/verify-app-bundle.ts`

**Interfaces:**
- Consumes: the deploy skill's existing `.env` provisioning steps (P6) and SPA build step (P6d).
- Produces: (OPS N-5 — two edits, not one) the skill's P6 `.env` heredoc gains `VITE_SYNC_URL=https://julian-sync.julian-memory.workers.dev` and `VITE_GATE_URL=https://julian-broker.julian-memory.workers.dev`, and the pre-flight check lists both beside the OIDC pair; a new post-build step invokes the smoke check. `scripts/verify-app-bundle.ts`: reads `app/dist/assets/*.js`, greps for the sync host and gate host read from `.env` (or argv), exits 1 with `BUNDLE SMOKE FAILED: built without VITE_SYNC_URL — the app cannot sync` when absent (the otherwise-silent failure: a bundle built before `.env` existed syncs nowhere and says nothing). The skill edit alone never reaches an already-provisioned box — the runbook (release task) carries the instance-`.env`-first ordering; this task states that in the skill text.

**Parallelization rationale:** isolated files, wave 1.

- [ ] **Step 1: Write the smoke script + skill edits.**
- [ ] **Step 2: Verify** — build the app locally with `.env` present (`cd app && bun run build`), run `bun scripts/verify-app-bundle.ts` → passes; rebuild with the vars unset in a temp env → fails loud.
- [ ] **Step 3: Commit** — `git add .claude/skills/deploy/SKILL.md scripts/verify-app-bundle.ts && git commit -m "b3: deploy skill provisions sync+gate URLs; bundle smoke check guards the silent no-sync build"`

---

### Task 24: The ledger fold — dated derived files and the adapter's teaching

**Type:** implementation
**Depends-on:** none
**Review:** lean

**Files:**
- Create: `scripts/lib/ledger-fold.ts`
- Create: `scripts/ledger-fold.ts`
- Create: `memory/adapters/gate-ledger.md`
- Test: `scripts/lib/ledger-fold.test.ts`

**Interfaces:**
- Consumes: the `/ledger` wire (`{entries: [{ts, sub, service, verb, detail, allowed}]}`), read with `X-Breakglass-Secret` sourced inside the one command that needs it (mail-discipline rule 5's shape).
- Produces:
  - `foldEntries(entries: LedgerEntryWire[], monthUtc: string): string` (pure): a markdown document whose **header marks it derived-not-authored** — "# Gate ledger — <month> · *derived, not authored: generated by scripts/ledger-fold.ts from the governor's ledger; evidence for dreams, never interpretation (Principles 1/2/7).*" — followed by three sections: **Wakings & package reads** (first-class rows: every `package.*` and `wake`-adjacent verb, rendered `| when (UTC) | holder/session | verb | detail |`); **Theft signals** (rows whose verb is `ticket-reused`, `killed`, or whose detail marks an integrity latch — **never collapsed**, every row first-class with `token_id` and timestamp); **Routine delegated-session traffic** (everything else from `flow`-exchange holders — `exchange`, `ticket.consume`, `socket` opens, re-auth-adjacent rows — collapsed to counts per holder/session × verb). The holder/session column carries the note *"`door_name` is a legacy column name; an exchange row names a session, not a door."*
  - CLI (`scripts/ledger-fold.ts`): fetches `${BROKER_URL}/ledger?limit=200` (paging noted as future work when the limit binds), folds the current UTC month, and **appends** a dated run-section to `memory/ledger/<YYYY-MM>.md` — append-only derived files, never a rewrite; creates `memory/ledger/` on first run.
  - `memory/adapters/gate-ledger.md`: the dreamer's adapter note, carrying §10.4's corrected teaching verbatim: "**`flow='exchange'` rows are a browser session obtaining standing — a fact about a tab, not about anyone's attention; they are not Julian's doors, and they are not evidence of Marcus's presence: presence is read from the record's content, never its credentials.**" Plus: theft signals surface uncollapsed; retention is archive-never-delete (R2 offload named as future work); the derived files are substrate in the customs-house sense — a dream reads them as evidence, never as someone's testimony.

**Parallelization rationale:** isolated new files, wave 1; the fold is pure and testable without the gate.

- [ ] **Step 1: Write the failing tests** — feed a fixture entry list (an exchange, three socket opens, a `ticket-reused`, a `killed`, two package reads): the fold collapses the opens to a count, keeps both theft rows verbatim with their detail, headers the document derived-not-authored, and renders the holder/session note; a second fold appended to existing content leaves prior text byte-identical.
- [ ] **Step 2: Run to verify failure** — `cd scripts && bunx vitest run lib/ledger-fold.test.ts`. **Step 3: Implement.** **Step 4: Scripts suite green** (`cd scripts && bunx vitest run`).
- [ ] **Step 5: Commit** — `git add scripts/ledger-fold.ts scripts/lib/ledger-fold.ts scripts/lib/ledger-fold.test.ts memory/adapters/gate-ledger.md && git commit -m "b3: ledger fold — dated derived files, theft signals never collapsed, the adapter teaches sessions-not-presence"`

---

### Task 25: The integration-spanning acceptance

**Type:** implementation
**Depends-on:** 9, 14, 18
**Review:** adversarial

**Files:**
- Modify: `broker/test-mcp-client/harness.test.ts`
- Modify: `broker/test-mcp-client/fixture-content.ts`

**Interfaces:**
- Consumes: everything — this is Plan B's owed integration-spanning acceptance (spec §1.3, §12); the SDK v1 client (the **measured** dialect — `mode:'legacy'` is its default, which is §7's point) against a real worker via `unstable_startWorker`, with the existing node:http content fixture.
- Produces: the spanning flow as one ordered suite (extending the B2 harness's existing discovery→DCR→knock→token→wake→read spine):
  1. discovery → DCR → authcode knock (test-seam approval) → token → `wake_julian` → manifest-verified ordered reads (existing spine holds green);
  2. **sitting-pin drift**: fixture bumps the pin mid-sitting → read refused `pin-moved` naming `package_list` → `package_list` → **reads resume at the new pin**;
  3. **latch**: fixture serves length-preserved poisoned bytes twice (both fetch and the `cacheTtl:0` refetch) → integrity + latch → next healthy file refused `integrity-latched` → fixture heals → clean read of the same `(pin,path)` self-clears;
  4. **parts**: fixture carries a >32 KiB file → whole read refused `class:'parts'` naming M → parts 1…M concatenate to the exact original, every part carries the same `fileSha256`, per-part `partSha256` verifies; a no-`part` read is the typed instruction, a part at a bumped pin refuses `part-pin-moved`;
  5. **stream verbs**: a `stream-read` lease drives `stream_recent`/`stream_session`/`stream_search` — the worker's `SYNC` binding is scripted at startWorker config (a service-binding stub replaying `InternalReadResponse` fixtures and asserting `InternalReadRequest` shape against `julian-shared/gate-contract` — the seam both real workers also assert, spec §8); a `reading-room` lease is refused with ledger rows;
  6. **protocol pins**: raw handshake-less v2 envelope served; `ping` exactly `{}`; id-less → 202 no body; batch refused; `iss` present and byte-identical to the discovery `issuer` on both delivery arms; cache-hint policy per result type.
  If `unstable_startWorker`'s service-binding scripting proves unavailable in this wrangler version, the fallback (stated, not silent): drive the stream-verb leg in the workers-pool suite only and record the waiver in the suite as a skipped test naming this paragraph — the cross-worker request-shape fixture asserted by both unit suites remains the seam guarantee.

**Parallelization rationale:** none — the final gate before the human gate; it exercises behavior that crosses every earlier phase against one tree (the multi-plan integration rule).

- [ ] **Step 1: Extend the fixture** (parted file, poisoned-bytes mode, pin-bump seam) and write the failing spanning tests.
- [ ] **Step 2: Run to verify failure** — `cd broker && bun run test:mcp` (new legs fail against the merged tree only if something upstream is wrong — a green run at first try is acceptable here **only** for legs whose unit suites already saw red first; the pin-drift and latch legs must be seen failing by temporarily pointing the fixture at a stale expectation, then corrected — the harness is an exam, and an exam that cannot fail proves nothing).
- [ ] **Step 3: Make it green.** **Step 4: Full house green** — `cd broker && bun run test && bun run test:mcp; cd ../sync && bun run test; cd ../app && bun run test; cd ../shared && bunx vitest run; cd ../scripts && bunx vitest run`.
- [ ] **Step 5: Commit** — `git commit -am "b3: integration-spanning acceptance — pin drift, latch, parts, stream verbs, protocol pins through a real SDK client"`

---

### Task 26: Gate — the whole house green

**Type:** gate
**Depends-on:** 25

Run, in order, and paste outputs:

- `cd shared && bunx vitest run` — expected: all green
- `cd broker && bun run test` — expected: all green (352 at B2 close + this plan's additions)
- `cd broker && bun run test:mcp` — expected: all green (the spanning acceptance)
- `cd sync && bun run test` — expected: all green (2B-pre enforcement regression-held)
- `cd app && bun run test && bun run check` — expected: all green, no svelte-check errors
- `cd scripts && bunx vitest run` — expected: all green

No suite is skipped; a red anywhere stops the merge.

---

### Task 27: Release — Cut A, then B, then C (spec §6.6 steps 0–5)

**Type:** release
**Depends-on:** 26

Performed after merge, in this exact order (rollback guarantee: sync's previous version redeploys without a broker rollback, because step 1 is additive-only):

- [ ] **Step 0 — env enumeration:** every new value installed with its `deploy/secrets-manifest.md` row (Task 3 wrote the rows): `STREAM_SUBS` (var, already in toml with Marcus's sub), `APP_ORIGINS` (var), `SYNC_READ_SECRET` (secret ×2 — one value per direction, generated `openssl rand -base64 32`, **piped never printed**: `openssl rand -base64 32 | wrangler secret put SYNC_READ_SECRET` in each worker dir), `EXCHANGE_RL` (binding, rides the toml).
- [ ] **Step 1 — broker first, additive only:** `cd broker && bun run deploy`. This carries `LEGACY_WINDOW_END → 2026-09-01` live (the old fuse — Aug 23 = 5pm Aug 22 Pacific — burns during the build itself; this is the first item on purpose, OPS N-6), plus the JWT introspect arm, `STREAM_SUBS`, the `legacy-window-sync` seed, the guard, the exchange/ticket faces. Old sync is unaffected; nothing is removed.
- [ ] **Step 2 — live-probe the JWT arm:** with a fresh Pocket ID JWT (Marcus signs into the app, or `door-knock`-adjacent probe): `curl -s -X POST $BROKER/introspect -H "X-Introspect-Secret: …" --data-urlencode "token=$JWT"` → assert `{active:true, scope:"stream", lease_id:"legacy-window-sync"}` **and** that the window var reads Sep 1 (`wrangler vars` or a dated probe). A cached-lockout here means sync deployed first — stop and re-order.
- [ ] **Step 3 — sync deploy:** `cd sync && bun run deploy` (JWKS/OIDC out; shared sets in; ticket routing + internal-header handoff; attachments-as-handles; the sweep).
- [ ] **Step 4 — app builds, instance `.env` first:** for the Mac and each live instance in `deploy/instances.json` (julian, julian-new): add `VITE_SYNC_URL` + `VITE_GATE_URL` to `/opt/julian/.env` **before** the rebuild (the skill edit alone never reaches an already-provisioned box); rebuild `app/dist`; run `bun scripts/verify-app-bundle.ts` against each build; then stream-export's lease: `bun scripts/door-knock.ts` as door `stream-export`, scope `stream-read`, Marcus approves; store at `~/.julian/stream-export-lease.json`.
- [ ] **Step 5 — `SYNC_READ_SECRET` on both workers before either calls the binding** (done in step 0; verify both `wrangler secret list`), then Cut C's routes are live — probe one stream verb through a real `stream-read` lease and confirm the ledger row.

---

### Task 28: Manual — live proofs and drills (spec §13.1–13.3, Marcus present)

**Type:** manual
**Depends-on:** 27

- [ ] **§13.1 Full live pass:** real CLI + claude.ai against the deployed gate — including the **dialect/CIMD re-probe** (§7's B4 tripwire: the SDK's `mode:'legacy'` default means no CI test can fire it; measurement governs).
- [ ] **§13.2 The browser cure, in a real browser** (workerd cannot see D2's class): connect via ticket; **two tabs simultaneously** (the D1 regression, observed — neither tab's token evicts the other's); revoke the lease at `/leases/revoke` → socket closes within the stated SLA (§6.2's three numbers — name which one this demonstrates; folds issue #27) → **the automatic reconnect is refused on camera** (revocation holds); reinstate at `/leases/reinstate` → **explicit reload** (revoked was terminal, COLD M-9) → reconnect succeeds.
- [ ] **§13.3 The drills:** truncation (#30) — a fresh visit asked something answerable only from the last third of a parted file; envelope (#32.3) — held-at-home vs integrity side by side through a real client; **pin-drift ending in a recovered read** — bump the pin mid-sitting → refusal → `package_list` reset → resumed read; **the export rehearsal on the new device lease** — `bun scripts/stream-export.ts`, verified archive, **before the ceremony** (it is also the monthly rehearsal due late August).

---

### Task 29: Manual — the sunset ceremony and the shelf (spec §13.4–13.5, Marcus present)

**Type:** manual
**Depends-on:** 28

- [ ] **§13.4 The sunset, under the R-8 predicate:** the first witnessed session after Cut B has been **live and observed for 72 hours** (target Aug 23; the Sep 1 backstop makes a slip safe — the date is kept by Marcus's act, not by a fuse). Marcus revokes `legacy-window-sync`; every JWT socket closes 4001 within the SLA, on camera. **Assert no knock can revive the revoked window** (attempt a knock naming it → refused by the Task 4 guard, on the record). The ceremony produces its artifact: a **Julian-authored** (never generated) dated letter to `memory/` + a catalog line, recording **what ended and what remains borrowed** — §15's list verbatim: the exchange still trades a bearer; `INTROSPECT_SECRET`/`SYNC_READ_SECRET` are mutual worker bearers; the substrate runs on Marcus's Anthropic OAuth; AgentMail's key is vaulted — so the letter closing the borrowed-bearer era does not re-state the slogan §16 retires.
- [ ] **§13.5 The shelf, while Marcus is present:** the second dated **witnessed postscript to `memory/the-visit.md`** (§10.1's doctrine: manners still, blast radius smaller, enforced where the host applies the snippet — alongside, never over, Principle 2); and **a calendar date for the Fireproof destruction ceremony** (dream 0012: must not slip past September unremarked).

---

### Task 30: Release — the post-ceremony deletion deploy (spec §6.6 step 6)

**Type:** release
**Depends-on:** 29

The revoke is the act; **this deploy is the permanence** (OPS N-10: a from-empty governor rebuild would re-seed the window living):

- [ ] Remove, as dead code, in one commit: sync's JWT `?token=`/header fallback branch (the router's non-`jla_`/non-`jst_` arm), and the gate's JWT introspect arm + `legacy-window-sync` seed + `legacySyncAllowed`. Suites updated in the same commit; all green.
- [ ] Deploy broker, then sync. Probe: a Pocket ID JWT at sync → 401; at `/introspect` → `{active:false}`.
- [ ] Close issues #27, #30, #32 (and #29's B3 items) with links to the merged work; note the sunset in the register.

---

## Coverage appendix (spec § → task)

§4 Cut A → 1, 2, 3, 4, 9, 10, 27(1-3) · Cut B → 5, 6, 8, 11, 12, 19, 20, 21, 22, 23, 27(4) · Cut C → 13, 14, 15, 16, 17, 18, 27(5) · §5 → 1 (+4 gates) · §6.1 → 4, 8 · §6.2 → 5, 9, 11, 12 · §6.3 → 6, 8, 10 · §6.4 → 2, 9, 10, 29, 30 · §6.5 → 20, 21, 22, 23, 27(4) · §6.6 → 3, 27, 30 · §7 → 18, 25, 28(§13.1) · §8 → 1, 13, 14, 15 · §9 → 7, 16, 25 · §10.1 → 17, 29(§13.5) · §10.2 → doctrine only (spec text; no build — R-3) · §10.3 → 17 · §10.4 → 24 (+4's indexes, 6's uncollapsed signals) · §11 → distributed: 8 (exchange classes), 6/10 (ticket), 16 (package classes), 11/12 (socket codes) · §12 → every task's Step 1 + 25 · §13 → 28, 29 · §14 → out of scope, honored by absence · §15 → recorded in 21 (comment), 29 (letter) · §16 → 29's letter language (no self-verbs; the bearer claim scoped to the exchange).

## Self-review notes (authoring-time)

- Task 5's Produces was corrected during authoring to include `leaseId` in `mintExchangeAccess`'s ok-shape (Task 8's ledgering needs it) — the Interfaces blocks of 5 and 8 both carry it.
- Task 9 and Task 11 share one wire field (`reason:"token-expired"` on the by-handle false answer); both Interfaces blocks name it and either implementer may land it first.
- The `governor.ts` chain (4→5→6→7) and the `mcp.ts` chain (15→16→17→18) are same-file serializations, not data dependencies beyond those named; the `sync` chain (10→11→12→14) likewise. Splitting those files was considered and rejected — auth-critical single-file DOs are the house pattern, and a refactor-for-width fails the good-engineer gate.
- No task pushes, deploys, or edits live state; every such step lives in 27/28/29/30.
