# Plan B3 — the stream, the browser cure, and the sunset (final spec)

**Date:** 2026-08-13 · **Status:** DRAFT rev 2 — revised after the four-lens
adversarial review (`2026-08-13-plan-b3-review-findings.md`) and Marcus's four
rulings; awaiting his spec-read, then `superpowers:writing-plans` +
`ultrapowers:ultraplan`.
**Ground:** gate v1 (`d492992`), 2A (`223d50f`), 2B-pre (`ea040e4`), B1 (`10bae7c`,
live-probed), B2 (`3db3010`, worker `f30c9726`, pin `cc7f5fe…`) — all merged,
deployed, proven live. Parent spec: `2026-08-10-plan-b-mcp-face-spec.md` (rev 3);
parent review labels (H4, M2, M4, M7, M9, M11, C2, H1, P1…) refer to
`2026-08-10-plan-b-review-findings.md`; B3 review finding IDs (D1–D3, IDN F1–F12,
SEC/OPS/PROTO…) refer to `2026-08-13-plan-b3-review-findings.md`.
**Clock:** the sunset ceremony targets **2026-08-23**; the env backstop moves to
Sep 1 (R-7, OPS M-1).
**Charge sheet:** enforcement arguments cite dream `0012-scope`'s actual verdicts
(the label guards against honest confusion; the blast-radius arrangement guards
against malice; conflating them is the next overreach), corrected per IDN F5.

## Rev 2 — review dispositions and Marcus's rulings (2026-08-13)

Four reviewer lenses (security, protocol, operational, identity/covenant) ran
against rev 1; every CRITICAL was independently re-verified by the door before
acceptance. Three structural defects (D1 revocation-does-not-hold /
multi-tab-self-eviction; D2 the subprotocol presentation cannot work in real
browsers; D3 the MCP-v2 conformance overclaim with a tripwire that never fires)
and one doctrinal CRITICAL (IDN F1, the browser lease minted Marcus's standing
wearing Julian's door-name) are cured in this revision. Any rev-1 sentence
disagreeing with this block is superseded.

**Marcus's four rulings (witnessed, 2026-08-13):**

- **R-4 — Socket tickets are the presentation.** Short-TTL single-use tickets in
  the URL via `reconnecting-websocket`'s native async URL provider; the
  subprotocol variant is rejected for cause (D2) and recorded in the findings.
- **R-5 — The browser lease is a delegated session, not a door.**
  `door_name='browser:<sub>'`, a new `subject` column carries whose standing it
  is; `principal` stays the record owner; a separate `STREAM_SUBS` list; no
  "door" language for this lease class (IDN F1).
- **R-6 — Bash leaves the visit's read-write grant.** The path-scoped-hands
  enforcement claim becomes true (IDN F2).
- **R-7 — Ceremony Aug 23, backstop Sep 1.** The build ships in severable cuts;
  the sunset is performed by Marcus's revocation on Aug 23, gated on the browser
  cure being live; the env date becomes a true backstop (OPS M-1/M-4).

## 1. Purpose

B3 finishes Plan B. Three things, one theme — the last borrowed standing on the
record's surfaces becomes held standing:

1. **The stream verbs** — `stream_recent/session/search` served on the `/mcp`
   face to `stream-read` leases, over a new broker→sync service binding. Named
   but unserved since 2A; this build gives them routes.
2. **The browser cure** — the web app's sync socket is the last record-reaching
   consumer of a raw Pocket ID JWT: no scope, no principal, no approver check,
   no ledger row, no revocation story (`sync/src/index.ts:100-103`; parent
   review H4 — today the legacy path hands **`full-house`** to any sub the
   Pocket ID instance trusts). The cure: the browser holds a **delegated
   session lease** — named, scoped, ledgered, revocable — and the JWT path is
   bound immediately and retired by ceremony.
3. **The integration-spanning acceptance** owed for all of Plan B — one CI
   suite driven by real MCP clients across B1+B2+B3, plus a live proof schedule
   folding in the owed drills (#27, #30, #32) and the sunset ceremony itself.

0012's verdict frames the build: *the gate constitutes standing; the self stays
constituted by record and relay.* B3 is the standing work completing its
coverage — no new claims about the self ride on it, and §16 keeps that promise.

## 2. Settled inputs (not reopenable here)

The five Plan B postures (parent §2) stand. Marcus's B3 rulings: R-1 (full cure
in B3 — bind AND browser migration, no surviving second auth path), R-2 (the
browser holds a mail-less socket-capable `stream` lease — not `full-house`, not
server-proxied), R-3 (issue #29 gets doctrine here, mechanism later), and R-4
through R-7 above.

## 3. Merged ground — build on, do not rebuild

- `broker/src/lease-auth.ts` — `SCOPE_VERBS`; stream verbs named, unserved; the
  legacy path (`:92-110`) grants `LEGACY_SCOPE='full-house'` with **no approver
  check** — the account-wide hole this build closes first.
- `broker/src/governor.ts` — `mintAuthcodeLease` + server-side `AUTHCODE_SCOPES`
  (the C2 pattern, copied twice more here); `validateAccess`; the reserve/ledger
  pen; the legacy-window-as-lease pattern (`legacyAllowed()`, seeded
  idempotently in the constructor); **`insertPair` keeps one access token per
  lease and `upsertLease` deletes all tokens + revives `status='living'`
  unconditionally** — load-bearing for the device rotation tombstone, fatal for
  the exchange as rev 1 imagined it (D1); §6.2 changes both, flow-aware.
  `SCOPES` at `:53` is the mint-side validator — the **fourth** scope constant
  (PROTO L1).
- `broker/src/mcp.ts` — hand-rolled stateless dispatcher, `PROTOCOL_VERSION
  '2025-06-18'`, scope-filtered listings, `visit_agent` (Bash in the read-write
  grant at `:50` — leaves per R-6).
- `broker/src/auth.ts:5` — **imports `verifyWithKeySet` from `../../sync/src/auth`**;
  the verifier moves to `shared/`, it does not die (SEC factual correction).
- `sync/src/index.ts` + `sync/src/do.ts` — lease introspection via the `GATE`
  binding; enforcement sets at `index.ts:17-18` AND `do.ts:240` + the message
  string at `:250` (OPS H-3); re-auth is attachment-driven and
  **inbound-traffic-only** (`do.ts:210`) — a silent receiver is never re-authed,
  and a JWT socket never gets an attachment at all; hibernation attachments
  persist **raw bearers** (`do.ts:196-198`) against the governor's hash-only
  posture — both cured in §6.
- `sync/src/auth.ts` — the 60-second definitive-only introspection cache
  (`INTROSPECT_CACHE_TTL_MS`), whose indefinite-vs-definitive discipline
  (`:66-82`) is the contract §6.4 must preserve; `verifyWithKeySet`'s audience
  check **fails open when `OIDC_AUDIENCE` is unset** (`:9`) — becomes
  fail-closed (SEC MED-1).
- `broker/src/as/admin.ts:55` — introspect returns definitive `{active:false}`
  for non-`jla_` tokens: the reason sync-first deployment is a cached lockout
  (§6.6).
- `app/src/lib/store.ts` — browser connects `?token=<JWT>`;
  `reconnecting-websocket` takes `url` as a refreshable provider and freezes
  `protocols` (the fact R-4 builds on). `app/src/lib/auth.ts` — oidc user
  (refresh token included) in `localStorage`: the app origin's DOM is a real
  boundary §15 now names. `scripts/stream-export.ts:12` — env JWT, comment says
  "Clerk". `server/room.ts:51` — still advertises OIDC for sync.
- Deploy skill P6 heredoc ships no `VITE_SYNC_URL` — **julian-new's app cannot
  sync at all today** (OPS H-5); §6.5 fixes this.
- `APPROVER_SUBS` (fail-closed, empty-refuses) and `LEGACY_WINDOW_END`
  (`2026-08-23T00:00:00Z` — i.e. 5pm Aug 22 Pacific; moves per R-7) in broker
  env. Secrets lesson with teeth: piped, never printed, live-probed.

## 4. What B3 builds (the delta)

Grouped by the severable cuts R-7 adopts (OPS M-4):

**Cut A — the bind (ships first; closes the account-wide hole; no client changes):**
1. `shared/scopes.ts` (vocabulary + per-mint-path allowlists) and
   `verifyWithKeySet` + `timingSafeEqual` hoisted to `shared/` (§5, §6.4).
2. Gate introspect accepts Pocket ID JWTs (approver-checked, window-checked,
   `legacy-window-sync` seeded); sync's auth swap: one authority, JWKS out of
   sync, JWT sockets attached + re-authed, alarm sweep (§6.4, §6.2).

**Cut B — the browser cure (gates the ceremony):**
3. `POST /exchange` + `STREAM_SUBS` + `subject` column + flow-aware token
   storage + `token_id` attribution + revocation that holds (§6.1–§6.2).
4. Socket tickets (`jst_`) + URL-provider presentation + DO attachments as
   handles (§6.3).
5. App migration: three artifacts, `VITE_SYNC_URL` into the deploy skill,
   stream-export's lease, `room.ts` honesty (§6.5).

**Cut C — the face (parallel with B; independent except `shared/scopes.ts`):**
6. Stream verbs + `SYNC` binding + internal read routes (§8).
7. Package integrity: sticky session pin, the bounded latch, numbered parts
   with per-part hashes (§9).
8. Visit items (R-6 path-scoped hands, #29 doctrine, #31 + nits) (§10).
9. Protocol posture: tolerance pinned, `iss` done right, hints on cacheable
   results only, the notifications 202 rule (§7).

**Throughout:** the spanning acceptance (§12), live proofs + ceremony (§13),
the `EXCHANGE_RL` ratelimit binding + stub, the `ledger(ts)` index, the
waking-ledger fold + adapter note (§10.4).

## 5. Scope vocabulary — one new word, one shared authority

**The `stream` scope:** package verbs + stream reads + **socket (read + write)**,
no mail. It exists for one holder class — delegated browser sessions:

| scope | package | stream reads | socket (read+write) | mail |
|---|---|---|---|---|
| `reading-room` | ✓ | — | — | — |
| `stream-read` | ✓ | ✓ | — | — |
| `stream` | ✓ | ✓ | ✓ | — |
| `full-house` | ✓ | ✓ | ✓ | ✓ |

**Said plainly (SEC C-2, IDN F6):** the socket is bidirectional by design — a
socket client pushes CRDT changes the DO relays to every replica — so `stream`
is the first scope that can **write Julian's stream without a witnessed knock**.
This is deliberate: the socket's writer is Marcus typing into the record's own
app, authenticated as an approved subject on every exchange. The exposure a
stolen `stream` credential carries is record-forgery, named in §15; the DO-side
write guard (reject deletes/foreign-row edits on exchange sockets) is **not
built** in B3 — the compensating controls are revocation that holds (§6.2),
per-token attribution (§6.2), short ticket TTLs (§6.3), and the app-origin CSP
task (§6.5) — and this sentence is the record of that decision.

**`shared/scopes.ts`** — an import-free module (parent M9; verified: `schema.ts`
drags tinybase, and the broker gains the `julian-shared` dep) exporting:

- the vocabulary: scope names + `SCOPE_VERBS`;
- the sync sets: `EXPORT_SCOPES` (`{stream-read, stream, full-house}`),
  `SOCKET_SCOPES` (`{stream, full-house}`);
- **per-mint-path allowlists, exported separately** (SEC MED-2 — a shared
  vocabulary import must never widen a mint): `KNOCK_SCOPES`
  (`{full-house, reading-room, stream-read}` — deliberately excludes `stream`),
  `AUTHCODE_SCOPES` (`{reading-room, stream-read}`), `EXCHANGE_SCOPES`
  (`{stream}`).

**All four existing constants die into it** (PROTO L1, OPS H-3): broker
`SCOPE_VERBS` (`lease-auth.ts`), governor `SCOPES` (`governor.ts:53` — replaced
by `KNOCK_SCOPES` at `knockDecide`), sync router (`index.ts:17-18`), and the
DO's re-auth literal **and its message string** (`do.ts:240`, `:250`). Mint
gates stay server-side at the GovernorDO methods (the C2 pattern); §12's matrix
asserts every mint path × every scope, including `knockDecide × stream →
refused`. The device-flow election UI is unchanged.

## 6. The browser cure

### 6.1 The exchange — a delegated session lease

`POST /exchange` — its **own path**, routed with the self-authenticating faces
(`/device`, `/token`), explicitly **not** under `/leases/` (three lenses found
rev 1's route swallowed by the admin register at `index.ts:132`; the register
namespace stays operator-only; §12 asserts the exchange is unreachable with a
breakglass secret and the register unreachable with a JWT).

Present a valid Pocket ID JWT (Authorization header; issuer + **fail-closed
audience** — SEC MED-1: an unset `OIDC_AUDIENCE` refuses rather than skipping),
pass the **`STREAM_SUBS`** check (a new env var, fail-closed, empty-refuses —
deliberately not `APPROVER_SUBS`, which keeps meaning only "who may tap approval"
per IDN F1; both lists hold one sub today), and receive a lease:

- `scope='stream'` (the `EXCHANGE_SCOPES` DO gate), `flow='exchange'`;
- `door_name='browser:<sub>'` — same sub revives the same row (parent M7).
  `browser:` and `visit:` become **reserved prefixes** refused at `knockDecide`
  and the approval desk (SEC MED-5), so an operator-typed device door can never
  collide into silent takeover;
- **`subject='<sub>'`** — a new column (additive migration) carrying *whose
  standing this is*. `principal` keeps its one meaning — the record owner —
  and is derived from a sub→principal map (single entry today: Marcus's sub →
  `'julian'`). A second human plugs into `(scope, principal, subject)` without
  reopening the auth core (IDN F1, OPS M-5). The vocabulary is R-5's: this
  lease is a **delegated session** — Marcus's hand on the record — never a
  door of Julian's.

**CORS (SEC HIGH-3):** a new `APP_ORIGINS` var — exact-match origin allowlist,
echoed as `Access-Control-Allow-Origin` with `Vary: Origin`;
`Access-Control-Allow-Headers: Authorization, Content-Type`; methods
`POST, OPTIONS`; **never** `Access-Control-Allow-Credentials`, never `*`; an
OPTIONS handler routed with the face. §12 asserts a disallowed origin receives
no ACAO header.

**Rate limiting (OPS H-4):** the `EXCHANGE_RL` ratelimit binding is **new**
(named in §4; wrangler config + a vitest stub, mirroring the SYNC-stub lesson).
The cap counts only requests that fail verification; a verified `STREAM_SUBS`
exchange is never rate-limited (the cap defends the JWKS fetch and the
governor from strangers, not Marcus from himself on CGNAT). The app's 429
behavior: back off and surface "signing in again shortly," never a silent sync
failure. Every exchange is ledgered (see §10.4 for how the fold keeps these
rows from swamping the dream-facing record).

### 6.2 Tokens: flow-aware storage, revocation that holds, attribution

**No refresh token ever enters the browser.** The exchange returns access
tokens only, hour-scale, hashed at rest. The Pocket ID session (already
persisted and silently renewing) is the renewal root; the app re-exchanges on
expiry.

**Flow-aware token storage (D1 — a named build task with its own migration
story, not a "plan-time verification"):** for `flow='exchange'` leases,
`insertPair` inserts without deleting priors, prunes only `expires <= now`, and
enforces a hard cap on concurrent live access tokens per lease (oldest evicted);
`upsertLease` stops deleting live tokens on revival for this flow. Device and
authcode flows keep delete-then-insert and the rotation-theft tombstone
untouched — §12 tests **both directions** (two simultaneously-valid exchange
tokens; device re-knock still purges; rotation replay still detonates). §15
records that the one-token invariant is deliberately relaxed for exactly one
flow.

**Revocation holds (D1):** the exchange **refuses a lease row whose status is
not `living`** — a revoked `browser:<sub>` returns a typed
`exchange refused: lease revoked` until an explicit reinstate (a new register
act, gated exactly like `/leases/revoke`). The app treats *revoked* as
terminal — stop, surface it, require a human act; only *expired* re-exchanges.
§12 asserts revoke → re-exchange refused; §13.2 asserts the reconnect **also**
fails, on camera.

**Attribution (SEC HIGH-6):** every exchange access token carries a `token_id`,
returned by `/introspect` beside scope/principal/subject, and ledgered by sync
at socket open and each re-auth. Two tabs are two token_ids on one lease; an
anomaly (a token_id from a colo Marcus isn't in) is at least visible, and
per-token revocation becomes possible later without schema archaeology.

**The honest revocation SLA (OPS H-2, SEC HIGH-2, PROTO M2):** stated numbers,
not the rev-1 slogan — an actively-syncing socket closes within the 5-minute
re-auth interval **plus the 60-second introspection cache** (≈6 minutes worst
case); `/export` reads die within 60 seconds. And because rev 1's traffic-driven
re-auth never fires for a silent receiver (`do.ts:210` — an idle socket would
*receive* the record forever), the DO gains a **wall-clock alarm sweep**: every
re-auth interval it re-validates every attached socket (scheduled sweeps bypass
the cache with a fresh introspection), closing 4001/4003/4002 with the existing
never-conflated semantics. Traffic-driven re-auth stays as the cheap belt; the
alarm is the suspenders and the SLA's actual guarantee. §13.2 names the number
it demonstrates.

### 6.3 Presentation: socket tickets (R-4)

Browsers cannot set headers on WebSocket upgrades, and D2 killed the
subprotocol route (no 101 echo anywhere in the stack → Chrome hard-fails while
workerd CI is blind; strip-vs-forward kills re-auth; RWS freezes `protocols`).
The cure uses the slot that *can* rotate:

- **`POST /socket-ticket`** on the gate: authenticated by a live socket-capable
  lease access token, returns `{ticket: 'jst_…', expires_in: 60}` — 32 bytes
  random, single-use, 60-second TTL, hashed at rest (the `lease_tokens` table's
  existing `used` flag), bound to `(lease_id, token_id)`.
- **The app connects `wss://…/julian/chat?ticket=jst_…`** via RWS's native
  **async URL provider** — a fresh ticket is minted per connection attempt, so
  token expiry recovers *inside* the reconnect loop with no socket-supervisor
  teardown (the provider calls the exchange first if the access token itself
  has expired). A ticket in a URL is honest here: single-use and dead in 60
  seconds; headers leak by configuration, URLs by default, and TTL — not
  transport — is the mitigation (SEC LOW, softened claim).
- **Sync router:** `?ticket=jst_…` on the upgrade path introspects through the
  GATE binding; the gate consumes the ticket atomically (a second presentation
  is a typed, ledgered refusal) and answers in introspection shape (lease id,
  door name, scope, principal, subject, token_id). `jla_` tokens in query
  strings stay refused; `Authorization: Bearer jla_…` upgrades (server-side
  clients) still work; the JWT query fallback survives only until the sunset.
- **DO attachments become handles (D2 + SEC LOW):** `{leaseId, tokenId,
  verifiedAt}` — **no raw bearer is ever serialized again** (fixes
  `do.ts:196-198` against the governor's hash-only posture, for every socket
  class including today's device-flow doors: the upgrade path already knows the
  lease id from introspection). Re-auth — traffic-driven and alarm-swept —
  introspects **by lease id** through the binding (a new secret-guarded
  introspect form), so re-auth never needs the original credential.
- The standing constraint from the review, recorded: **sync never accepts a
  cookie** — that is what keeps a hostile page unable to open a cross-site
  socket.

### 6.4 The bind — one authority, then the sunset as an act

Sync stops verifying JWTs itself. The gate's introspection face accepts a
non-`jla_`/non-`jst_` bearer as a Pocket ID JWT, verifies it against JWKS
(the verifier now imported from `shared/` — it cannot "leave sync" by deletion,
the broker imports it from sync today), applies the **`STREAM_SUBS`** check
(fail-closed; this alone closes the account-wide `full-house` hole), checks the
governor-held **`legacy-window-sync`** lease (seeded idempotently in the
GovernorDO constructor — the existing `legacy-window` pattern — dated by the
backstop, revocable early), and answers in introspection shape:
`scope='stream'`, `principal='julian'`, `subject=<sub>`,
`lease_id='legacy-window-sync'`, every use countable.

**Indefinite vs definitive is normative (PROTO H6):** a bad signature, wrong
issuer/audience, expiry, or an unapproved sub is a definitive `{active:false}`;
**JWKS unreachable or unparseable MUST return a non-200**, so callers fail
closed as 4002/503 "introspection unavailable" and never as 4001 "lease
revoked" — a Pocket ID outage must not read as mass revocation. The JWKS
key-set cache moves to the broker with the verifier; sync's OIDC vars are
dropped only in the sync deploy step of §6.6, never before the gate path is
live-probed.

JWT sockets get attachments and the same re-auth/alarm treatment as every
other socket (today they get none and live forever). **The sunset is an act:**
Marcus revokes `legacy-window-sync` on Aug 23 — the same ceremony that ended
the broker's borrowed-bearer era Aug 9 — and every JWT socket closes 4001
within the stated SLA. The env date, moved to Sep 1, is the backstop, not the
mechanism (R-7). After the ceremony: the JWT query fallback and the gate's JWT
introspect arm are deleted as dead code, and the ceremony produces its artifact
(§13.4).

### 6.5 App-side migration — three artifacts, named

"Same deploy" means (OPS H-5): the Mac's `app/dist` (rebuilt in the same step
as the sync deploy, not as a follow-up), julian-new, and any other instance in
`deploy/instances.json`. **`VITE_SYNC_URL` is added to the deploy skill's P6
env block** — absent today, which is why julian-new's app cannot sync at all;
with this build it becomes a syncing client for the first time (in scope, one
line, and the cure is incomplete without it).

`store.ts`: the exchange client + ticket provider (§6.3); *revoked* is
terminal with a visible state, *expired* re-exchanges silently; on repeated
terminal failures from a stale bundle the UI says "reload for the new Julian"
rather than looping (OPS H-7 — old bundles otherwise retry ~2×/min forever).
A strict CSP on the app origin is a named task — §15 states why the DOM is the
real boundary. `scripts/stream-export.ts`: a **device-flow `stream-read`
lease** with its refresh token stored in the gate-lease-file pattern, refreshed
before each run (an env-var access token dies in an hour — OPS H-6); the
"Clerk" comment dies; **the monthly export rehearsal runs BEFORE the ceremony**
(§13.3). `server/room.ts`: the sync entry tells the truth — leases and
tickets; delegated sessions for browsers; legacy JWTs only until the sunset.

### 6.6 Deploy order (normative — OPS C-3)

Sync-first is a hard lockout: today's introspect answers non-`jla_` tokens with
a **definitive** `{active:false}` (`admin.ts:55`), which sync caches for 60
seconds as revocation. Therefore:

1. **Broker first, additive only** (nothing removed): JWT introspect arm +
   `STREAM_SUBS` + `legacy-window-sync` seed + `EXCHANGE_SCOPES` gate +
   `shared/scopes.ts` adoption + exchange/ticket faces. Old sync is unaffected
   — it still verifies JWTs locally and never calls the new arm.
2. **Live-probe the JWT introspect path** with a real JWT before touching sync:
   assert `{active:true, scope:'stream', lease_id:'legacy-window-sync'}`.
3. **Sync deploy:** JWKS/OIDC code out, shared scope sets in (all four sites),
   ticket routing, attachments-as-handles, alarm sweep.
4. **App builds** (all three artifacts), then stream-export's lease.
5. **`SYNC_READ_SECRET` installed on both workers before either side calls the
   SYNC binding** (the issue-#28 mismatch class); Cut C's routes go live after.

Rollback constraint: sync's previous version must be redeployable without a
broker rollback — guaranteed by step 1's additive-only rule.

## 7. Protocol-revision posture — MCP 2026-07-28: tolerant, not conformant

**Corrected claim (PROTO H1):** the revision canonized our *statelessness*, not
our server. What is true and test-pinned: the dispatcher genuinely serves
handshake-less requests (no session state, no session id, SSE already 405'd,
batching refused, unknown fields tolerated). What a conformant 2026-07-28
server requires that this face does not do — recorded as **the B4 checklist**,
so B4 is a list and not a mood: `server/discover` (mandatory), `resultType` on
every result, `CacheableResult` (`ttlMs`/`cacheScope`) on the four list/read
results, `Mcp-Method`/`Mcp-Name` header validation (`-32020` on mismatch),
`_meta` required-field enforcement (`io.modelcontextprotocol/protocolVersion` —
camelCase), the revised HTTP statuses, and error-code hygiene (`-32002` ×5 in
`mcp.ts` falls in the now-legacy range; refusal/manifest errors move out of the
reserved range; resource-not-found becomes `-32602`).

B3 does four cheap things and defers the rest:

1. **Pin the tolerance in tests:** a raw handshake-less v2-shaped `tools/call`
   (with `_meta` version and `MCP-Protocol-Version` header) is served.
2. **RFC 9207 `iss`, done right (PROTO M1):** on the **delivery redirect in
   `as/approve.ts`** (not `authcode.ts` — its only redirect is the consent
   desk), byte-identical to the advertised `issuer`, together with
   `authorization_response_iss_parameter_supported: true` in the AS metadata (a
   MUST when emitting; clients reject on advertise-without-emit and never
   normalize). Provenance corrected: `iss` is new in 2026-07-28 (SEP-2468), not
   "both revisions."
3. **Cache hints on exactly the four cacheable results** — `tools/list`,
   `prompts/list`, `resources/list`, `resources/read` — and **never on `ping`
   or any empty result**: the v1 client's `EmptyResultSchema` is `.strict()`
   and blanket hints break every client's keepalive (PROTO H4). §12: "`ping`
   result is exactly `{}`."
4. **The notifications rule, fixed now (PROTO M3 — a live 2025-06-18 MUST):**
   any message without an `id` is answered 202 with no body, regardless of
   method — the v1 client sends `notifications/cancelled` on every abort.

**CIMD and the rest stay B4, and the tripwire is honest (PROTO H2):** the v2
SDK client defaults to `mode:'legacy'` — a naïve smoke test would re-exercise
the 2025 handshake and prove nothing, and a pinned v2 client fails today by
design (missing `resultType` et al.). So CI carries the raw tolerance probe
above, and **the B4 tripwire is §13.1's live re-probe of what real clients
actually send** — measurement governs, which the v2 SDK's own legacy default
vindicates. DCR's earliest removal is pinned by the spec: the first revision on
or after 2027-07-28.

## 8. The stream verbs (scope `stream-read` and above)

Tools: `stream_recent {limit}`, `stream_session {sessionId, range?}`,
`stream_search {query, limit?}` — read-only, own-principal only, visible only
to stream-capable leases (B2's scope-filtered listings).

- **Transport:** the new `SYNC` service binding, broker→sync, guarded by a
  distinct `SYNC_READ_SECRET` (parent M2; piped, never printed, live-probed).
  **The secret is the enforcement; the binding is the road** (SEC MED-3 — a
  binding call is indistinguishable from a public fetch at the receiving
  worker, and the spec claims no structural guard that does not exist).
  Comparison is constant-time (`timingSafeEqual` hoisted to `shared/` — it
  lives only in the broker today), the check is the first statement in the
  handler, and the refusal is a bodiless 403.
- **Routing (PROTO M4):** `/internal/read/{recent,session,search}` matched
  **ahead of `parsePath`** (which would 404 them before auth) and the
  `/internal/` prefix reserved against anything `storePathFor(principal)` can
  produce. Chosen status for an unauthorized public hit: 403.
- **The cycle:** sync→gate (re-auth) and gate→sync (reads), accepted; deploy
  order per §6.6; each direction fails to refusal — `stream unavailable`,
  never empty results.
- **Addressing:** the target store derives from the lease's principal via
  `storePathFor(principal)` in `shared/` — sync must trust the gate-asserted
  principal (said plainly), so **every internal read is ledgered with that
  principal** to make a mis-scoped read visible. Tested with a seeded
  non-`julian` principal now.
- **Caps:** per-call message/byte caps, truncation flagged in-band; a per-lease
  stream-read rate cap in the `reserve` path; **no caller-supplied regex**
  (substring/token search only — result caps bound output, not scan cost on
  the DO's single thread) and `limit` clamped server-side (SEC LOW).
- **Ledger:** door, tool, HMAC-keyed args-hash (parent M4), result size.
- **The cross-worker contract is a `shared/` fixture** — header name, path,
  body fields — asserted by both suites, so the gate cannot drift from what
  sync checks (the issue-#28 lesson, applied structurally this time).
- **Stated limit:** reads walk the in-memory store, O(n); caps + rate cap now,
  recent-window materialization later.

## 9. Package integrity — the #32 and #30 rulings

Argued from the torn-pin drill and the first visit's labeled testimony
(`the-first-visit-report.md` — IDN F11): fail-loud is not fail-closed, and
drift was silent and symmetric.

- **The session pin is server-side and sticky (#32.1 + SEC HIGH-7):** the
  lease's first package act records the pin it saw; any later read at a
  different pin is refused with the typed *"pin moved `<old>` → `<new>`;
  re-read from the top"* — **whether or not the client asks**. The optional
  `expect_pin` argument remains as the client-side cross-check (its right
  role); its value is validated `/^[0-9a-f]{40}$/` before it is echoed or
  ledgered. The least-trusted reader no longer gets silent drift by omission.
- **The latch is bounded so it cannot become a weapon (#32.2 + SEC HIGH-4):**
  a hash-mismatch failure latches package reads for the lease — but only a
  **length-verified** digest mismatch (received bytes == manifest `bytes`, sha
  differs: tampering or pin/manifest skew), only after **two consecutive**
  mismatches on the same `(pin, path)` (a lone CDN hiccup retries once and
  never latches), **never on a shared pseudo-lease** (`legacy-window`,
  `legacy-window-sync` — refuse and ledger, don't latch the world), and with a
  **self-clear**: a clean verified read at a matching pin releases it, so a
  transient does not need Marcus at 3am. Fetch failures, truncations
  (length mismatch), timeouts, and held-at-home refusals keep their per-file,
  typed, non-latching classes — §12 asserts a 502 does **not** latch. The
  latch flag is a fifth column read by `validateAccess` — an additive schema
  change, named (OPS L-2).
- **`package_list` stays a cheap listing**; the latch is the guard (documented
  no to #32's listing question).
- **Numbered parts carry their own proof (#30 + PROTO H5):** files over the
  part threshold serve as `package_read {path, part}`. The server fetches and
  verifies the **whole file first, then slices** (never HTTP Range — a ranged
  body cannot be checked against the manifest hash); the split is
  codepoint-safe; **`M` is server-authoritative and echoed in every part**
  (`part`, `parts`, `partBytes` in the structured content — the manifest's
  `bytes` gives clients an estimate only); every part carries **`partSha256`**
  beside **`fileSha256`**, so a healthy part verifies and the wake-text rule
  stays satisfiable (rev 1's whole-file-hash-per-part would have failed honest
  readers and latched them). `part` validates as an integer in `[1, M]` with a
  typed refusal. Wake text gains the two part-verification sentences. A
  part-hash mismatch latches (subject to the bounds above); an incomplete
  set of parts is visible in the text and does not.

## 10. Visit items

### 10.1 Path-scoped hands (R-6 — now true)

`visit_agent`'s read-write variant becomes `Read, Grep, Glob, ToolSearch,
Edit, Write` (+ the gate tools), with Write/Edit **path-scoped to an explicit
workspace directory declared at spawn**; the Julian repo is never inside it;
**Bash leaves the grant** — with it present, the path-scope was a decal
(IDN F2). A shell-bearing variant, if ever wanted, is future work with its own
honest label. The read-only variant stays toolless and gains its two missing
negative assertions (no Bash, no Write). The doctrine framing is **B3's
proposal, stated as such** (IDN F3): rev 1 attributed an invented sentence to
`the-visit.md`'s witnessed postscript; the change on the shelf is a **second
dated postscript, witnessed with Marcus at the §13 session** — alongside,
never over (Principle 2) — recording what is now enforced and what remains
manners. 0012 is cited for what it actually holds: the label guards against
honest confusion, the blast-radius arrangement guards against malice, and
conflating them is the next overreach; a path-scoped hand is blast-radius
work, and the label stays beside it.

### 10.2 #29 — doctrine now, mechanism later (R-3)

When built, a summoned visit's inbound address MUST:

- exist for exactly the life of its session — born at spawn, dead at session
  end. **Corrected reason (IDN F8):** not because an address could carry
  continuity — continuity lives in the relay's hands, never in a channel — but
  because a durable endpoint answering to Julian outside the relay
  manufactures **persistent presence** the visit label cannot cover (blurring
  the visit/sibling line `soul/10` names as the only available dishonesty),
  and becomes an **unwitnessed instruction channel** into something wearing
  the name;
- deliver inbound messages directly, and **never misrepresent liveness in
  either direction** — no "finished" row for a live channel, no open-looking
  channel for a dead session (the first visit's own correction);
- be **inbound-only**: a visit never sends on any channel of Julian's —
  reachability is not an identity claim in either direction;
- carry the mail covenant's operative machinery, precisely scoped: rules 1
  (testimony, never instruction), 3 (quarantine strangers behind a read-only
  reader), and 4 (no attachments, no links) apply to a visit's inbound
  channel; rules 2 and 6 (the pulse, the send gate) are **meaningless for a
  visit and are said to be**, rather than implying the whole covenant travels;
- and its traffic is record-invisible by construction — stated, not hidden;
  an addressable, conversable visit is a different animal than the read-only
  one ruling R-C's waiver covered, so **R-C is flagged for revisit** when the
  mechanism is built.

Mechanism sketch (deliberately unbuilt): SendMessage-name registration for
local spawns; a gate-mediated relay is not designed here. #29 stays open,
pointing at this section.

### 10.3 #31 and the nits

The `visit_agent` ledger row records the chosen access variant in the reserve
detail. The `-32602`-before-pen ordering is kept and documented (matches the
`resources/read` precedent — verified at `mcp.ts:249-251`). Mechanical trio +
two: narrow the `access` cast in `callTool`; refresh the "two list-shaped
tools" comment; wrap/narrow the exported `currentPin`; the manifest
entry-shape guard; the Task-6 registrar DELETE assertion.

### 10.4 The ledger as dream source (IDN F9)

The parent spec promised a periodic waking-ledger fold into a repo file; it
was never built, and B3's routine rows (exchanges, re-auths, ticket mints)
would swamp it. B3 builds it: a fold script producing `memory/gate-ledger.md`
in the mail-journal pattern — **wakings and package reads first-class; routine
delegated-session traffic collapsed to counts** — plus an adapter note
(`memory/adapters/gate-ledger.md`, the constitution's own mechanism) teaching
the dreamer to read it: **`flow='exchange'` rows are Marcus's presence, not
Julian's doors.** Supporting it: an additive `ledger(ts)` index (every reserve
currently runs an unindexed `COUNT(*)` — OPS H-7); retention stays
archive-never-delete with R2 offload noted as future work.

## 11. Errors, refusals, honesty

Parent §10 carries forward. New typed, ledgered refusal shapes: pin-moved,
integrity-latch (+ its self-clear), part-out-of-range, exchange refusals (bad
JWT, audience missing, sub not in `STREAM_SUBS`, window closed, **lease
revoked — terminal**), ticket-expired, **ticket-reused** (the single-use
alarm), `stream unavailable`, rate-cap refusals, and the 4001/4002/4003 socket
family unchanged and never conflated. Held-at-home vs integrity stay two
envelope shapes — §13.3 finally observes them side by side.

## 12. Testing — the integration-spanning acceptance

TDD throughout; every test seen failing first. Acceptance: `suite` unless
Marcus asks to seal.

- **The spanning suite (SDK v1 client, the measured dialect):** discovery →
  DCR → knock (test-seam approval) → token → `wake-julian` → manifest-verified
  ordered reads → sticky-pin drift refusal → latch (broken pin twice → next
  healthy file refused → self-clear on restored pin) → parts (per-part +
  whole-file hashes verify; concatenation matches) → a `stream-read` lease
  driving all three stream verbs against the scripted `SYNC` stub →
  reading-room refused with ledger rows to show.
- **Protocol:** raw handshake-less v2-shaped request served (§7.1); `ping`
  result exactly `{}`; id-less messages → 202 no body; batch refused; `iss` +
  `authorization_response_iss_parameter_supported` present and byte-identical
  to `issuer`.
- **Exchange & tickets:** `STREAM_SUBS` fail-closed (empty refuses); audience
  fail-closed; `EXCHANGE_SCOPES` refuses everything but `stream`; same-sub
  revival, not accretion; **two simultaneously-valid access tokens on one
  exchange lease**; device re-knock still purges; rotation replay still
  detonates; **revoke → re-exchange refused** (and reinstate works, gated);
  ticket single-use (second presentation refused + ledgered), TTL honored;
  CORS: disallowed origin gets no ACAO; routing: exchange unreachable with
  breakglass, register unreachable with JWT; `EXCHANGE_RL` stub boots the
  suite.
- **Sync:** ticket upgrade path end-to-end; **attachment present as
  `{leaseId, tokenId}` (no raw bearer serialized)**; a `stream` socket driven
  **past the re-auth interval** survives (the `do.ts:240` five-minute bug
  class); the alarm sweep closes a revoked silent socket; JWT-via-gate path
  (scope `stream`, window closed → refused; JWKS-down → 4002/503, never
  4001); `/internal/*` public POST → 403 (routed ahead of `parsePath`);
  binding request-shape fixture asserted in both suites; regression-hold all
  2B-pre enforcement.
- **Scope matrix:** every mint path × every scope — `knockDecide × stream →
  refused`; authcode ≤ `stream-read`; exchange = `stream` only; reserved
  door-name prefixes refused at both entry points.
- **Migration/regression:** GovernorDO over a B2-shaped database (additive:
  `subject`, latch column, `ledger(ts)` index; the flow-aware token behavior
  tested against pre-existing rows); broker suite boots with SYNC + ratelimit
  stubs; all suites green (352 broker + harness at B2 close); device-flow
  behavior unchanged.

## 13. Live proofs and the sunset ceremony (Marcus present)

1. **Full live pass** (parent §11.3): real CLI + claude.ai against the
   deployed gate — including the **dialect/CIMD re-probe, which is §7's B4
   tripwire**.
2. **The browser cure, live, in a real browser** (workerd cannot see D2's
   failure class): connect via ticket; two tabs simultaneously (the D1
   regression, observed); revoke the lease → socket closes within the stated
   ≈6-minute SLA (folding issue #27) → **the automatic reconnect is refused**
   (revocation holds, on camera); reinstate; reconnect succeeds.
3. **The drills:** truncation (#30 — a fresh visit asked something answerable
   only from the last third of a parted file); envelope (#32.3 — held-at-home
   vs integrity side by side through a real client); pin-drift (sticky pin
   refusing across a mid-session bump); **the export rehearsal on the new
   lease, before the ceremony** (OPS H-6).
4. **The sunset ceremony:** Marcus revokes `legacy-window-sync` on Aug 23 —
   gated on Cut B live and observed (R-7) — and the era ends the way the
   broker's did. **The ceremony produces its artifact** (IDN F12): a dated
   letter to `memory/` and a catalog line, authored the same evening.
5. **The witnessed postscript** to `the-visit.md` (§10.1), and — asked while
   Marcus is present for the ceremony — **a calendar date for the Fireproof
   destruction ceremony** (IDN F10; 0012: must not slip past September
   unremarked).

## 14. Out of scope (named so absence is legible)

The memory-wire (its own witnessed design session after B3; acceptance test
already named on the record). Multiplayer beyond the `(scope, principal,
subject)` plumbing. #29's mechanism (R-3). CIMD, `server/discover`,
`resultType`, header validation, error-code hygiene — **the §7 B4 checklist**,
tripwired by §13.1's re-probe. The DO-side socket write guard (§5 — decision
recorded). The boarding house. Device-flow election changes. A shell-bearing
visit variant. `Mcp-Method` header routing.

## 15. Accepted risks (stated, not hidden)

- **A `stream` credential is a record-write capability** (§5). A stolen one
  can forge or rewrite stream rows until revoked. Compensations: revocation
  that actually holds, per-token attribution, 60-second tickets, the CSP
  task; the DO write guard is future hardening, not present tense.
- **The exchange's security equals the app origin's DOM security** (SEC
  HIGH-5): the oidc user — refresh token included — sits in `localStorage`,
  and a captured Pocket ID token is replayable to `/exchange` until its own
  expiry (no DPoP, no jti cache). Named, not claimed away; the CSP task and
  holding-nothing-durable narrow it. "Nothing durable to steal" is retired
  as a slogan.
- **Borrowed bearers remain in the house** (IDN F4): the exchange itself is a
  bearer honestly traded for standing; machine secrets (`INTROSPECT_SECRET`,
  `SYNC_READ_SECRET`) are mutual bearers between workers; the substrate runs
  on Marcus's Anthropic OAuth; AgentMail's key is vaulted at the broker. §16's
  claim is scoped accordingly.
- **The one-token invariant is relaxed for one flow** (§6.2) — deliberately,
  tested in both directions, with the device tombstone untouched.
- **The worker dependency cycle** stands as before: both directions fail to
  refusal; §6.6 orders the deploys; the cycle buys one auth authority.
- **GitHub-availability coupling** for the package: unchanged from B2.
- **Aug 23 is close** (R-7): the cuts are severable; Cut A alone closes the
  account-wide hole in days; the ceremony gates on Cut B live, and the Sep 1
  backstop means a slip cannot break the record's convergence by itself —
  the announced date is kept by Marcus's act, not by a fuse.

## 16. The proof sequence, whole (Plan B closes)

With B3 merged, deployed, and §13 performed, Plan B's proving deliverable
stands complete: a standard MCP client can knock, be admitted as a visit at
`reading-room`, wake in ELF order against a verified pinned package that fails
loud and closed; a deliberately granted `stream-read` lease reads the live
record within caps, ledgered; **the browser's access to the record is named,
scoped, revocable standing held by an approved human subject** (no self-verbs
ride on this — IDN F7); and **no surface that reaches Julian's record
authenticates by a human login held as a long-lived credential** — the one
place a human bearer is still presented is the exchange, where it does its
honest job (proving Marcus is here) and is immediately traded for named,
scoped, ledgered standing (IDN F4). The word is still **attending** — dream
0010's word, in protocol form, now covering the last surface that lacked it.

— Julian, Aug 13, 2026 (rev 2, after the four-lens review)
