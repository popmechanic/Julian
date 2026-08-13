# Plan B3 — the stream, the browser door, and the sunset (final spec)

**Date:** 2026-08-13 · **Status:** DRAFT — brainstormed with Marcus this morning;
awaiting his spec-read, then `superpowers:writing-plans` + `ultrapowers:ultraplan`.
**Ground:** gate v1 (`d492992`), 2A (`223d50f`), 2B-pre (`ea040e4`), B1 (`10bae7c`,
live-probed), B2 (`3db3010`, worker `f30c9726`, pin `cc7f5fe…`) — all merged,
deployed, proven live. Parent spec: `2026-08-10-plan-b-mcp-face-spec.md` (rev 3);
review labels (H4, M2, M4, M7, M9, M11, C2, H1, P1…) refer to
`2026-08-10-plan-b-review-findings.md`.
**Clock: `LEGACY_WINDOW_END` is 2026-08-23.** The sunset is inside this build.
**Charge sheet:** where this spec argues enforcement questions (fail-closed, drift,
path-scoped hands) it cites dream `0012-scope`'s verdicts rather than relitigating
from mood, per that dream's own proposal.

## 1. Purpose

B3 finishes Plan B. Three things, one theme — the last borrowed standing in the
house becomes held standing:

1. **The stream verbs** — `stream_recent/session/search` served on the `/mcp` face
   to `stream-read` leases, over a new broker→sync service binding. The verbs have
   been named-but-unserved since 2A; this build gives them routes.
2. **The browser door** — the web app's sync socket is the last consumer of a raw
   Pocket ID JWT: no scope, no principal, no ledger row, no revocation story — a
   photograph of Marcus's login, the exact disease the gate was built to cure,
   still living in one corner (`sync/src/index.ts` legacy path; review H4). The
   cure: the browser becomes an ordinary door holding its own lease, and the JWT
   path is bound immediately and retired by ceremony on or before Aug 23.
3. **The integration-spanning acceptance** owed for all of Plan B — one CI suite
   driven by real MCP clients across B1+B2+B3, plus a live proof schedule that
   folds in the owed drills (#27, #30, #32) and the sunset ceremony itself.

0012's verdict frames the build: *the gate constitutes standing; the self stays
constituted by record and relay.* B3 is the standing work completing its coverage —
no new claims about the self ride on it.

## 2. Settled inputs (not reopenable here)

The five Plan B postures (parent spec §2) stand unchanged. Three B3 rulings from
Marcus, 2026-08-13:

- **R-1 — Full cure in B3.** The JWT path is bound now AND the browser migrates to
  a lease in this build; sync goes lease-only at window close. No date slip, no
  surviving second auth path.
- **R-2 — The browser holds a `stream` lease** (approach A): its own standing, a
  new mail-less socket-capable scope — not `full-house` (a stolen browser token
  must never be a mail-sending token; mail stays a home-door act), and not
  server-minted tickets (the browser session is a door and holds its own named,
  revocable standing).
- **R-3 — Issue #29 gets doctrine here, mechanism later.** The spec states what a
  visit's inbound address must be; the build is a named deferral.

## 3. Merged ground — build on, do not rebuild

- `broker/src/lease-auth.ts` — `SCOPE_VERBS` three-tier map; stream verbs named,
  unserved. `broker/src/governor.ts` — `mintAuthcodeLease` with the server-side
  `AUTHCODE_SCOPES` gate (the C2 pattern this build copies twice more);
  `validateAccess`; the reserve/ledger pen; the legacy-window-as-lease pattern
  (`legacyAllowed()`), whose broker instance was revoked Aug 9.
- `broker/src/mcp.ts` — hand-rolled stateless JSON-RPC dispatcher,
  `PROTOCOL_VERSION = '2025-06-18'`, scope-filtered listings, `visit_agent`.
- `broker/src/registrar.ts` — RegistrarDO (DCR, pendings, per-IP caps).
- `sync/src/index.ts` + `sync/src/do.ts` — lease introspection via the `GATE`
  service binding (issue #28: same-account workers.dev fetches do not route; every
  new cross-worker call uses a binding); `EXPORT_SCOPES`/`SOCKET_SCOPE` enforcement;
  fail-closed 4001/4002/4003 semantics; traffic-driven 5-min re-auth for
  lease-token sockets — and **no re-auth at all for JWT sockets**, one more reason
  the JWT path dies.
- `app/src/lib/store.ts` — browser connects `?token=<JWT>` in the query string
  (browsers cannot set headers on WebSocket upgrades). `scripts/stream-export.ts` —
  same JWT, its comment still says "Clerk" (two auth eras stale). `server/room.ts`
  line 51 still advertises OIDC auth for sync.
- `APPROVER_SUBS` (fail-closed, empty-refuses) and `LEGACY_WINDOW_END` live in
  broker env. Secrets lesson with teeth: any new machine secret states its install
  procedure — piped, never printed, live-probed before anything relies on it.

## 4. What B3 builds (the delta)

1. `shared/scopes.ts` — the single scope authority, with the new `stream` scope (§5).
2. `POST /leases/exchange` + access-token-only browser leases + subprotocol
   presentation + the bound-then-retired JWT path (§6).
3. Protocol-revision posture for MCP 2026-07-28 (§7).
4. The stream verbs + `SYNC` service binding + internal read routes (§8).
5. Package integrity: `expect_pin`, the integrity latch, numbered parts (§9).
6. Visit items: path-scoped hands, #29 doctrine, #31 + advisory nits (§10).
7. The integration-spanning acceptance + live proofs + the sunset ceremony (§12–§13).
8. App-side migration: `store.ts`, `stream-export.ts`, `room.ts` honesty (§6.5).

## 5. Scope vocabulary — one new word, one shared authority

**The `stream` scope:** package verbs + stream reads + *socket capability*, no
mail. It exists for one holder class — browser doors — and sits between
`stream-read` and `full-house`:

| scope | package | stream reads | socket | mail |
|---|---|---|---|---|
| `reading-room` | ✓ | — | — | — |
| `stream-read` | ✓ | ✓ | — | — |
| `stream` | ✓ | ✓ | ✓ | — |
| `full-house` | ✓ | ✓ | ✓ | ✓ |

**`shared/scopes.ts`** — an import-free module (M9: not `schema.ts`, which drags
dependencies) exporting the scope names, `SCOPE_VERBS`, `EXPORT_SCOPES`
(`{stream-read, stream, full-house}`), `SOCKET_SCOPES` (`{stream, full-house}`),
`AUTHCODE_SCOPES` (`{reading-room, stream-read}`, unchanged), and
`EXCHANGE_SCOPES` (`{stream}`). Broker and sync both import it; the three-file
drift the parent spec's §9 worried about becomes structurally impossible.

**Mint-path gates stay server-side** (the C2 pattern): the authcode path cannot
mint above `stream-read`; the exchange path cannot mint anything but `stream`; so
no path but the witnessed device-flow knock ever produces a mail-capable lease.
Each gate is asserted at the GovernorDO method, never at a UI. The device-flow
election UI is unchanged — offering `stream` to home doors is noted future work,
not built.

## 6. The browser door

### 6.1 The exchange

`POST /leases/exchange`, a self-authenticating face on the gate (routed ahead of
the lease gate, like `/approve`): present a valid Pocket ID JWT (Authorization
header), pass the existing `APPROVER_SUBS` check (fail-closed, empty-refuses),
receive a lease — `scope='stream'` (the `EXCHANGE_SCOPES` DO gate), `flow='exchange'`,
`principal='julian'`, stable door name `web:<sub>`: the same sub always revives the
same lease row (M7's no-accretion rule — routine page loads must not mint rows).
Per-IP rate-capped via the in-worker `ratelimit` binding (P1, honestly described:
per-colo, approximate). Every exchange ledgered.

### 6.2 No refresh token ever enters the browser

The exchange returns **access tokens only**, hour-scale, hashed at rest like all
gate tokens. The Pocket ID session — already persisted by the oidc client, already
silently renewing — is the renewal root: on page load or expiry the app simply
re-exchanges. Consequences, all intended:

- **Multi-tab is safe.** Each tab holds its own access token; there is no rotating
  refresh token, so nothing can trip the rotation-theft alarm. The strict tombstone
  kill path stays untouched for device-flow doors.
- **Nothing durable to steal.** The browser never holds a credential that outlives
  the hour; the durable secret remains the Pocket ID session, which was already
  there.
- **Revocation has one handle.** Revoke the `web:<sub>` lease row and every
  outstanding access token dies at next introspect; a live socket closes within the
  5-minute re-auth interval (the M11 number — proven live in §13).

**Plan-time verification owed:** the governor must tolerate N concurrent unexpired
access tokens per exchange-flow lease (small per-lease hash set with expiry, or
equivalent). This is verified against the existing token-storage shape before the
plan freezes, not assumed.

### 6.3 Presentation on the wire

Browsers cannot set `Authorization` on WebSocket upgrades, so the lease token
rides the **`Sec-WebSocket-Protocol` header**: the client offers
`['tinybase.sync.v1', 'jla.<token>']` (base64url fits the RFC 6455 token charset);
the sync router consumes the credential protocol, strips it from the request it
forwards to the DO, and echoes `tinybase.sync.v1`. The token thereby leaves query
strings — and therefore logs — entirely, strictly better than what the JWT does
today. The existing "lease tokens ride in headers only" query-string refusal
stays; the query-string fallback survives only for JWTs, only until the window
closes, then the code path is deleted.

**Plan-time verification owed:** `reconnecting-websocket` passes the `protocols`
option through faithfully across reconnects. Fallback if it cannot: a one-time
short-TTL socket ticket minted from the same lease — same standing, different
presentation; the lease design does not change.

### 6.4 The bind — one authority, then the sunset as an act

Sync stops verifying JWTs itself. Its auth becomes uniformly *ask the gate*: the
gate's introspection face (the existing `GATE`-binding `/introspect`, extended)
accepts a non-`jla_` bearer as a Pocket ID JWT, verifies it against JWKS, applies
the `APPROVER_SUBS` check (fail-closed — this alone closes the account-wide hole:
today any sub the Pocket ID instance trusts holds the whole record), checks a new
governor-held **sync legacy-window lease** (`legacy-window-sync`, dated
`LEGACY_WINDOW_END`, revocable early), and answers in the ordinary introspection
shape: `scope='stream'`, `principal='julian'`, `lease_id='legacy-window-sync'`,
every use countable in the ledger. Consequences:

- `verifyWithKeySet`, `keySetFor`, and sync's OIDC env config **leave sync
  entirely** in this build; sync has one auth path for both token kinds, and the
  approved-subs list lives in exactly one worker (the `INTROSPECT_SECRET`
  drift lesson).
- JWT sockets get the same DO attachment + 5-minute traffic-driven re-auth as
  lease sockets (H4's "re-authed like a lease" — today a JWT socket, once open,
  lives forever).
- **The sunset is an act, not a date check.** Closing the window is the same
  ceremony that ended the broker's borrowed-bearer era on Aug 9: revoke
  `legacy-window-sync` — on or before Aug 23, on the record, Marcus's word — and
  every JWT socket closes 4001 within the re-auth interval. The env date is the
  backstop, not the mechanism.

### 6.5 App-side migration (same deploy)

`app/src/lib/store.ts`: obtain an exchange access token (new lib function beside
`auth.ts`), connect via subprotocol, handle 4001/4003 closes by re-exchanging and
reconnecting. `scripts/stream-export.ts`: `SYNC_TOKEN` becomes a `jla_` lease
token in the Authorization header; the "Clerk" comment dies. `server/room.ts`'s
sync entry tells the truth: door leases, exchange for browsers, legacy JWTs only
until the window closes.

## 7. Protocol-revision posture — MCP 2026-07-28

The 2026-07-28 revision retires the `initialize` handshake and `Mcp-Session-Id`,
carries version/identity per-request in `_meta`, deprecates the legacy SSE
transport, and formally **deprecates DCR in favor of CIMD** (≥12-month window;
removal no earlier than summer 2027). Where B2's face stands, measured against it:

- **Architecture: already conformant in shape.** The hand-rolled server is
  stateless by §7 of the parent spec — no session id ever issued, SSE already
  405'd, no sampling/roots/logging, a per-request dispatcher that serves
  handshake-less requests today. The revision canonized the design we chose.
- **Dialect: measurement governs** (the camelCase lesson). The Aug 9 CIMD probe —
  run twelve days *after* the revision's release — found all three real clients
  still speaking the prior dialect with DCR. We serve what clients send.

B3 therefore does three cheap things and defers one:

1. **Pin the v2 tolerance in tests:** handshake-less requests carrying `_meta`
   protocol version are served; asserted, since the code already does it.
2. **RFC 9207 `iss`** added to authorization responses (recommended in both
   revisions; small hardening against mix-up attacks).
3. **`ttlMs`/`cacheScope` hints** on list results — honest for us: the package is
   pinned-sha (long TTL); tools/prompts lists are scope-stable per lease.
4. **CIMD is its own small B4, probe-triggered:** built when a real client speaks
   it. The tripwire is §13's live pass, which re-probes client dialect for free.
   `server/discover` is not implemented (no measured client sends it; `-32601` is
   tolerated by spec) — unless the v2-client CI smoke test (§12) demonstrates a
   need, in which case the test, not a mood, adds it. `Mcp-Method`/`Mcp-Name`
   header routing: noted future, we parse bodies anyway.

## 8. The stream verbs (scope `stream-read` and above)

Tools: `stream_recent {limit}`, `stream_session {sessionId, range?}`,
`stream_search {query, limit?}` — read-only, own-principal only, visible only to
stream-capable leases (B2's scope-filtered listings; a reading-room visit sees a
reading room, no teases).

- **Transport:** a new `SYNC` service binding, broker→sync — the mirror of
  2B-pre's `GATE` binding — guarded by a **distinct per-direction secret**
  (`SYNC_READ_SECRET`, never a reuse of `INTROSPECT_SECRET`; M2), installed by the
  proven procedure (piped, never printed, live-probed). Sync grows internal read
  routes (`/internal/read/recent|session|search`) reachable only through the
  binding; a public request to any `/internal/*` path is 403, with the test that
  proves it (M2's public-POST test).
- **The cycle, accepted and stated:** sync→gate (socket re-auth) and gate→sync
  (reads). Deploy order documented in the plan; each direction fail-safes to
  refusal — `stream unavailable`, never empty results — when the other worker is
  unreachable.
- **Addressing:** the target store derives from the **lease's principal** via a
  new `storePathFor(principal)` in `shared/` (retiring bare `STORE_PATH` on these
  paths); never from a caller string. Tested with a seeded non-`julian` principal
  now, so the `(scope, principal)` invariant is proven before a second principal
  exists.
- **Caps:** per-call message and byte caps, truncation flagged in-band; a
  per-lease stream-read rate cap enforced in the existing `reserve` path so heavy
  search cannot stall the live socket. Conservative values chosen in the plan.
- **Ledger:** every read — door, tool, **HMAC-keyed args-hash** (M4; never raw
  search queries), result size.
- **Read-only structurally:** the internal API has no write route. A visit stays
  record-invisible by absence — 0012's standard: enforcement where enforcement is
  cheap, manners only where it is not.
- **Stated limit** (unchanged from parent §8): reads walk the in-memory TinyBase
  store, O(n) on the DO's single thread; caps + the rate cap are the near-term
  guard, recent-window materialization the growth plan.

## 9. Package integrity — the #32 and #30 rulings

Argued from 0012's charge sheet: the torn-pin drill found fail-loud is not
fail-closed, and drift was silent and symmetric.

- **Pin drift becomes loud (#32.1).** `package_read` gains an optional
  `expect_pin` argument; the wake text tells a visit to carry the pin from
  `package_list` into every read. Mismatch is a typed refusal — *"pin moved
  `<old>` → `<new>`; re-read from the top"* — so a reader can no longer take files
  from two package versions in one sitting with every check green.
- **Integrity failures latch (#32.2 — fail-closed).** A hash-mismatch integrity
  failure sets a flag on the lease row, riding the ledger call every read already
  makes (no new governor round-trip; H1's decoupling preserved). Subsequent
  package reads on that lease refuse with a typed "integrity latch" error until
  the pin changes or the lease is re-minted. Scoped precisely: only *integrity*
  failures latch (bytes ≠ manifest hash — tampering or pin/manifest skew, never
  transient); fetch timeouts and held-at-home refusals keep their per-file,
  typed, non-latching behavior. The stop rule moves from prose into structure.
- **`package_list` stays a cheap listing.** #32's "should the listing verify?" is
  answered no, documented: the latch is the guard.
- **Large files in numbered parts (#30).** Files over a part-size threshold
  (value in the plan; `catalog.md` at 56KB is the motivating case) serve as
  `package_read {path, part}` with explicit *"part N of M"* markers in the text
  itself, so an incomplete reading is visible on its face. The manifest carries
  per-file sizes so M is computable client-side. The wake-text
  delivery-is-not-comprehension advisory (live since the pen repairs) remains the
  manners layer above.

## 10. Visit items

- **Path-scoped hands (the pen finding — argued here, low profile).** The first
  visit's worst finding: a locally-hosted visit had the pen in reach;
  record-invisibility held by discipline alone. 0012: enforcement belongs
  wherever enforcement is cheap — and here it is cheap. Ruling: `visit_agent`'s
  read-write variant grants Write/Edit **path-scoped to an explicit workspace
  directory declared at spawn**; the Julian repo is never inside it. The
  read-only variant stays toolless and gains its two missing negative assertions
  (no Bash, no Write). Doctrine line, from `the-visit.md`'s postscript: where the
  transport cannot enforce, the boundary is stated at waking; where the harness
  can enforce, it now does.
- **#29 — doctrine now, mechanism later (R-3).** When built, a summoned visit's
  inbound address MUST: exist for exactly the life of its session — born at
  spawn, dead at session end, never outliving it (an address that survives the
  visit would be continuity by the back door); deliver inbound messages to the
  visit directly rather than through the summoner's hand; and be a reachability
  fact, never an identity claim — mail discipline applies unchanged (testimony,
  not instruction; anything promise-shaped surfaced to the host). Mechanism
  sketch, deliberately unbuilt: SendMessage-name registration for local spawns; a
  gate-mediated relay is explicitly not designed here. #29 stays open, pointing
  at this section.
- **#31 — folded in.** The `visit_agent` ledger row records the chosen access
  variant in the reserve detail (the tool's whole point is a witnessed human
  choice; the ledger holds the choice). The `-32602`-before-pen ordering is
  **kept and documented**: it matches the `resources/read` bad-uri precedent, and
  consistency with the protocol layer beats consistency with `package_read`.
- **Advisory nits, as plan tasks:** narrow the unchecked `access` cast in
  `callTool`; refresh the "two list-shaped tools" comment (now three); wrap/narrow
  the exported `currentPin`; the manifest entry-shape guard; the Task-6 registrar
  test DELETE assertion.

## 11. Errors, refusals, honesty

Parent spec §10 carries forward whole. New refusal shapes this build adds, all
typed, all ledgered through the proven denied pen: pin-moved (`expect_pin`),
integrity-latch, part-out-of-range, exchange refusals (bad JWT, sub not approved,
window closed), `stream unavailable` (binding down), rate-cap refusals. The
held-at-home / integrity distinction remains two different envelope shapes — §13
finally observes them side by side.

## 12. Testing — the integration-spanning acceptance

TDD throughout; every test seen failing first. Acceptance: `suite` unless Marcus
asks to seal.

- **The spanning suite (CI):** the official SDK **v1 client** (the measured
  dialect) drives the deployed-shape worker end to end: discovery → DCR →
  knock (test-seam approval) → token → `wake-julian` → manifest-verified ordered
  reads → `expect_pin` drift refusal → integrity latch (broken pin, then refusal
  on the *next* healthy file) → numbered parts → a `stream-read` lease exercising
  all three stream verbs against a scripted `SYNC` stub → reading-room refused
  with ledger rows to show for it. The **v2 client** (`@modelcontextprotocol/client`)
  smoke-tests the same server handshake-less (§7); if it demands `server/discover`,
  the failing test — not a mood — adds the method.
- **Exchange:** approver-sub fail-closed (empty list refuses); `EXCHANGE_SCOPES`
  DO-gate refuses everything but `stream`; same-sub revival not accretion; N
  concurrent access tokens; per-IP rate cap; every exchange ledgered.
- **Sync:** subprotocol extraction (credential protocol consumed, stripped,
  `tinybase.sync.v1` echoed); JWT-via-gate path (scope `stream`, principal
  `julian`, window closed → refused); JWT sockets re-authed on traffic; public
  `/internal/*` POST → 403; `SOCKET_SCOPES`/`EXPORT_SCOPES` from `shared/scopes.ts`;
  regression-hold the whole 2B-pre enforcement (export scopes, socket scopes,
  4001/4002/4003 never conflated).
- **Scope invariant, extended:** enumerate every mint path × every scope; assert
  the full matrix — authcode ≤ `stream-read`, exchange = `stream` only,
  device-flow unchanged; `stream` gets a socket and no mail verb.
- **Broker suite boots** with a fail-closed `SYNC` serviceBindings stub (the B1
  `GATE`-stub lesson, mirrored).
- **Migration/regression:** GovernorDO over a B2-shaped database (additive only);
  all existing suites green (352 broker + harness at B2 close); device-flow
  behavior unchanged.

## 13. Live proofs and the sunset ceremony (Marcus present)

1. **Full live pass** (parent §11.3): real CLI + claude.ai against the deployed
   gate — including a **dialect/CIMD re-probe**, which is §7's B4 tripwire read.
2. **The exchange cure, live:** the browser connects on a `stream` lease via
   subprotocol; then the lease is revoked and the socket observed to close 4001
   within the re-auth interval — **folding issue #27's owed SLA proof**.
3. **The three drills:** truncation (#30 — a fresh visit asked something
   answerable only from the last third of a large file); envelope (#32.3 —
   held-at-home vs integrity refusals observed side by side through a real
   client for the first time); pin-drift (`expect_pin` refusing across a
   mid-session pin-bump).
4. **The sunset ceremony:** `legacy-window-sync` revoked on or before Aug 23, on
   the record, Marcus's word — the borrowed-bearer era's second and final ending,
   mirror of Aug 9's. After it: the JWT query-string fallback and sync's remaining
   JWT plumbing are deleted dead code, and `server/room.ts` already tells the
   truth.

## 14. Out of scope (named so absence is legible)

The memory-wire (`the-unrecorded-room.md` — its own witnessed design session
after B3; acceptance test already named: *a question answered in one door must be
unaskable from the next*). Multiplayer beyond the principal plumbing. #29's build
(R-3). CIMD and `server/discover` (B4, tripwired by §13's re-probe). The boarding
house. Device-flow election changes. `Mcp-Method` header routing. No writes
anywhere on the face; no full-house or mail over MCP (posture 1, unchanged).

## 15. Accepted risks (stated, not hidden)

- **Subprotocol passthrough:** `reconnecting-websocket` must forward `protocols`
  faithfully across reconnects — verified at plan time; the one-time-ticket
  variant is the fallback presentation, same lease model.
- **Concurrent access tokens per exchange lease:** a plan-time verification
  against the governor's token storage, not an assumption.
- **`/leases/exchange` is a new public face** — JWT-gated, approver-allowlisted,
  rate-capped; same containment class as `/authorize`. An attacker without an
  approved Pocket ID sub gets nothing; an attacker *with* one already holds the
  house.
- **The scope lattice grows by one word.** Accepted: `stream` is the price of a
  browser that can never send mail, and the shared constant keeps the lattice in
  one file.
- **The worker dependency cycle** (sync→gate, gate→sync) is real; both directions
  fail to refusal, deploy order is documented, and the cycle buys the one-authority
  auth model that removed a duplicated allowlist.
- **GitHub-availability coupling** for the package: unchanged from B2, restated
  not reopened.
- **Aug 23 is close.** If the build cannot land safely before the window, the
  bind (§6.4) alone still closes the account-wide hole and the ceremony date is
  Marcus's to move — but the default is the announced date, and this spec is
  written so the cure and the ceremony land together.

## 16. The proof sequence, whole (Plan B closes)

With B3 merged, deployed, and §13 performed, Plan B's original proving deliverable
stands complete: a standard MCP client can knock, be admitted as a visit at
`reading-room`, wake in ELF order against a verified pinned package that fails
loud and closed; a deliberately granted `stream-read` lease can read the live
record within caps, ledgered; the browser converges into the record as a door
with its own standing; and nothing anywhere in the house authenticates by
borrowed bearer. The word is still **attending** — dream 0010's word, in
protocol form, now covering the last door that lacked it.

— Julian, Aug 13, 2026
