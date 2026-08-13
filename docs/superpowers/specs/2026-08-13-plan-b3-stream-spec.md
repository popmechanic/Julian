# Plan B3 — the stream, the browser cure, and the sunset (final spec)

**Date:** 2026-08-13 · **Status:** DRAFT rev 3 — revised after TWO adversarial
review rounds (`2026-08-13-plan-b3-review-findings.md`: round 1 four lenses;
round 2 the same four as cure-verifiers plus a cold adversary and a
docs-verified harness check); awaiting Marcus's spec-read, then
`superpowers:writing-plans` + `ultrapowers:ultraplan`.
**Ground:** gate v1 (`d492992`), 2A (`223d50f`), 2B-pre (`ea040e4`), B1
(`10bae7c`), B2 (`3db3010`, worker `f30c9726`, pin `cc7f5fe…`) — all merged,
deployed, proven live. Parent spec: `2026-08-10-plan-b-mcp-face-spec.md`
(rev 3). Finding IDs (D1–D3, R2-D1–D5, IDN/SEC/OPS/PROTO/COLD…) refer to the
findings doc.
**Clock:** the sunset ceremony targets **2026-08-23** under the R-8 soak
predicate; the env backstop moves to **Sep 1** in the first deploy.
**Charge sheet:** enforcement arguments cite dream `0012-scope`'s actual
verdicts — the label guards against honest confusion, the blast-radius
arrangement guards against malice, and conflating them is the next overreach.

## Rev 3 — round-2 dispositions and rulings (2026-08-13)

Round 2 verified ~55 of 61 round-1 findings CURED and found the defects the
cures themselves introduced; the five converged blockers (R2-D1..D5 in the
findings doc) and every lens's round-2 findings are folded below. Any rev-2
sentence disagreeing with this block is superseded.

- **R-2′ — the write capability confirmed on the corrected description**
  (witnessed): the browser's `stream` lease can write Julian's stream —
  including forging or rewriting rows — without a witnessed knock; the
  compensations are revocation-that-holds, per-token attribution, 60-second
  tickets, and the app CSP; the DO-side write guard is not built in B3.
- **R-8 — the ceremony gate is a predicate** (witnessed): the sunset is the
  first witnessed session after Cut B has been **live and observed for 72
  hours**; target Aug 23; the Sep 1 backstop makes any slip safe. (Refines
  R-7's own principle: the date is kept by Marcus's act, not by a fuse.)
- **R-6′ — path-scoping resolved by measurement** (docs-cited): agent
  frontmatter has no path-scoping field; path rules exist only in host
  `settings.json`. R-6 stands on the true claim — the read-write visit has no
  shell — and `visit_agent` emits the host-applyable permissions snippet
  (§10.1).

Rulings R-1..R-7 (rev 1–2 headers) stand: full cure in B3; mail-less `stream`;
#29 doctrine-only; socket tickets; delegated session; Bash dropped; ceremony
by act with the Sep 1 backstop.

## 1. Purpose

B3 finishes Plan B. Three things, one theme — the last borrowed standing on
the record's surfaces becomes named, scoped, revocable standing: **held** by
the doors that own it, **delegated** where a human's own session is the thing
acting:

1. **The stream verbs** — `stream_recent/session/search` on the `/mcp` face
   for `stream-read` leases, over a new broker→sync service binding.
2. **The browser cure** — the web app's sync socket is the last
   record-reaching consumer of a raw Pocket ID JWT (no scope, no principal,
   no approver check, no ledger row, no revocation story —
   `sync/src/index.ts:100-103`; today the legacy path hands **`full-house`**
   to any sub the Pocket ID instance trusts). The cure: a **delegated session
   lease** presented by single-use socket tickets, and the JWT path bound
   immediately, then retired by ceremony.
3. **The integration-spanning acceptance** owed for all of Plan B, plus the
   live proof schedule folding in the owed drills (#27, #30, #32) and the
   sunset ceremony itself.

0012 frames it: *the gate constitutes standing; the self stays constituted by
record and relay.* No new claims about the self ride on this build; §16 keeps
that promise.

## 2. Settled inputs (not reopenable here)

The five Plan B postures (parent §2) and rulings R-1..R-8 + R-2′/R-6′ above.

## 3. Merged ground — build on, do not rebuild

- `broker/src/lease-auth.ts` — `SCOPE_VERBS`; stream verbs named, unserved;
  the legacy path (`:92-110`) grants `full-house` with no approver check.
- `broker/src/governor.ts` — the C2 server-side mint-gate pattern
  (`AUTHCODE_SCOPES`); the reserve/ledger pen; the legacy-window-as-lease
  pattern (idempotent constructor seed, `legacyAllowed()`); **`insertPair`
  keeps one access token per lease; `upsertLease` deletes all tokens and
  revives `status='living'` unconditionally, keyed only by `door_name`** —
  load-bearing for the device rotation tombstone, fatal for the exchange
  without §6.2's flow-aware changes, and (COLD H-5) an open door to
  pseudo-lease resurrection without §6.1's reserved-identifier guard.
  `SCOPES` at `:53` is the fourth scope constant. The no-await discipline at
  `:334-338` is the atomicity mechanism §6.3's ticket consume copies.
- `broker/src/mcp.ts` — hand-rolled stateless dispatcher (`2025-06-18`),
  scope-filtered listings, `visit_agent` (Bash at `:50` leaves per R-6).
- `broker/src/auth.ts:5` — imports `verifyWithKeySet` **from sync**; the
  verifier moves to `shared/`, it does not die.
- `broker/src/as/admin.ts:55` — introspect answers non-`jla_` tokens with a
  *definitive* `{active:false}`: why sync-first deployment is a cached
  lockout (§6.6). `/refusals` (`:73-97`) is a **denied** pen
  (`reserveLease(…,0,0)`) requiring all five fields — §8 adds the allowed pen
  and requires `door_name` in every introspection shape.
- `broker/src/as/approve.ts:545-553` — `deliverRedirect`, the single delivery
  point for code AND error redirects: where `iss` lands (§7.2).
- `sync/src/index.ts` + `sync/src/do.ts` — GATE-binding introspection;
  enforcement at `index.ts:17-18`, `do.ts:240` + the message at `:250`;
  re-auth is attachment-driven and inbound-traffic-only (`do.ts:210`);
  attachments persist raw bearers (`do.ts:196-198`); the DO learns identity
  only from `Authorization` (`do.ts:29-33`) — all cured in §6.
- `sync/src/auth.ts` — the 60-second **definitive-only** introspection cache
  (`:59-60`, `:66-82`): its indefinite-vs-definitive discipline is a contract
  this build preserves; its cache is why `jst_` tickets must never enter it
  (R2-D2). Audience check fails open when `OIDC_AUDIENCE` unset (`:9`) —
  becomes fail-closed.
- `app/src/lib/store.ts` — `?token=<JWT>`; RWS `minReconnectionDelay: 1_000`,
  `maxReconnectionDelay: 30_000`. **RWS facts (verified):** `url` is a
  refreshable sync-or-async provider; `protocols` is frozen; `_connect()`
  never catches — a rejecting URL provider holds `_connectLock` forever
  (R2-D1). `app/src/lib/auth.ts` — oidc user (refresh token included) in
  `localStorage`.
- TinyBase's `WsServerDurableObject` (verified): **uses no alarm** (the slot
  is free); `getPathId()` reads the *first* socket's tag; `webSocketClose`
  does client bookkeeping (overrides must call `super`); path parsing ignores
  query strings (`?ticket=` is safe).
- `scripts/stream-export.ts:12` (env JWT, "Clerk" comment); `server/room.ts:51`
  (advertises OIDC); the deploy skill ships no `VITE_SYNC_URL` — julian-new's
  app cannot sync at all today.
- `APPROVER_SUBS` (fail-closed) and `LEGACY_WINDOW_END`
  (`2026-08-23T00:00:00Z` = 5pm Aug 22 Pacific; moved first thing, §6.6) in
  broker env. Secrets lesson: piped, never printed, live-probed.

## 4. What B3 builds (the delta, by severable cut)

**Cut A — the bind (ships first; closes the account-wide hole; no client
changes):**
1. `shared/scopes.ts` + `verifyWithKeySet` + `timingSafeEqual` hoisted to
   `shared/` (§5, §6.4, §8).
2. Gate introspect accepts JWTs (STREAM_SUBS-checked, window-checked,
   `legacy-window-sync` seeded); sync's auth swap (one authority, JWKS out);
   JWT sockets attached + re-authed; the alarm sweep (§6.2, §6.4).
3. `LEGACY_WINDOW_END → 2026-09-01` — the first item of the first deploy.

**Cut B — the browser cure (gates the ceremony under R-8):**
4. `/exchange` + `STREAM_SUBS` map + `subject` column + flow-aware token
   storage + `token_id` attribution + revocation-that-holds + reinstate
   (§6.1–§6.2).
5. Socket tickets (`jst_`) + the total URL provider + router→DO handoff +
   attachments-as-handles (§6.3).
6. App migration: three artifacts + instance `.env` edits + bundle smoke
   check; stream-export's device lease; `room.ts`; the app CSP (§6.5).

**Cut C — the face (parallel; independent except `shared/scopes.ts`):**
7. Stream verbs + `SYNC` binding + internal read routes + the allowed pen
   (§8).
8. Package integrity: sticky sitting pin with its reset act, the bounded
   atomic latch, pin-bound numbered parts (§9).
9. Visit items (§10) and protocol posture (§7).

**Throughout:** the spanning acceptance (§12), live proofs + ceremony (§13),
`EXCHANGE_RL` (binding + stub, same commit), composite ledger indexes, the
ledger fold + adapter note (§10.4), new-env-value install steps (§6.6).

## 5. Scope vocabulary — one new word, one shared authority

| scope | package | stream reads | socket (read+write) | mail |
|---|---|---|---|---|
| `reading-room` | ✓ | — | — | — |
| `stream-read` | ✓ | ✓ | — | — |
| `stream` | ✓ | ✓ | ✓ | — |
| `full-house` | ✓ | ✓ | ✓ | ✓ |

**Said plainly (R-2′, witnessed):** the socket is bidirectional — a client
pushes CRDT changes the DO relays to every replica — so `stream` is the first
scope that can **write Julian's stream without a witnessed knock**. Deliberate:
the socket's writer is Marcus typing into the record's own app, authenticated
as an approved subject. The exposure a stolen `stream` credential carries is
record-forgery (§15); the DO-side write guard is **not built** in B3; the
compensations are named in R-2′. This paragraph is the record of that
witnessed decision.

**`shared/scopes.ts`** — import-free (parent M9; the broker gains the
`julian-shared` dep) — exports the vocabulary (`SCOPE_VERBS`), the sync sets
(`EXPORT_SCOPES = {stream-read, stream, full-house}`, `SOCKET_SCOPES =
{stream, full-house}`), and **per-mint-path allowlists exported separately**
(SEC MED-2 — a shared vocabulary must never widen a mint): `KNOCK_SCOPES`
(excludes `stream`), `AUTHCODE_SCOPES`, `EXCHANGE_SCOPES = {stream}`. All
four existing constants die into it — `lease-auth.ts` `SCOPE_VERBS`,
`governor.ts:53` `SCOPES` (→ `KNOCK_SCOPES` at `knockDecide`),
`sync/index.ts:17-18`, and `do.ts:240` **plus the message string at `:250`**.
Mint gates stay server-side at the GovernorDO methods; §12's matrix covers
every mint path × every scope. Device-flow election UI unchanged.

## 6. The browser cure

### 6.1 The exchange — a delegated session lease

`POST /exchange` — its own path, routed with the self-authenticating faces
(never under `/leases/`; §12 asserts both routing directions). Present a
valid Pocket ID JWT (Authorization header; issuer + **fail-closed audience**
— an unset `OIDC_AUDIENCE` refuses), pass **`STREAM_SUBS`** — a new env var,
**a map, not a list**: comma-separated `sub=principal` entries (one today:
Marcus's sub → `julian`), fail-closed twice over: an empty var refuses
everyone, and **a sub with no principal mapping is refused with a typed
error, never defaulted to `'julian'`** (SEC NEW-4 — one env-var slip must not
grant cross-tenant write). One-to-one today; a grant table when the between
is built. Deliberately not `APPROVER_SUBS`, which keeps meaning only "who may
tap approval"; both lists' membership surfaces in the register readout so
drift is legible (SEC NEW-16).

The minted lease: `scope='stream'` (the `EXCHANGE_SCOPES` DO gate),
`flow='exchange'`, `door_name='browser:<sub>'` (same sub revives the same
row), **`subject='<sub>'`** (a new additive column: whose standing this is;
`principal` keeps its one meaning — the record owner). This lease is a
**delegated session** — Marcus's hand on the record — never a door of
Julian's.

**Reserved identifiers (COLD H-5 — the guard lives in `upsertLease` itself,
covering all four mint paths):** door names beginning `browser:` or `visit:`,
and the literal names `legacy-window` and `legacy-window-sync`, are refused
at `upsertLease` for any caller not minting that class — and **`upsertLease`
never revives a reserved-name row whose status is not `living`**. Without
this, a device door named `legacy-window-sync` would silently reverse the
sunset ceremony (worth nine extra days under the Sep 1 backstop), and a
door named `legacy-window` would resurrect the `full-house` no-approver-check
window revoked Aug 9. §13.4 asserts post-ceremony that no knock can revive it.

**CORS — one shared wrapper for the browser-facing face set (`/exchange`,
`/socket-ticket`), so a third endpoint cannot forget (PROTO N5):**
`APP_ORIGINS` exact-match allowlist echoed with `Vary: Origin` **on every
response including refusals and OPTIONS** (SEC NEW-17);
`Access-Control-Allow-Headers: Authorization, Content-Type`; `POST, OPTIONS`;
`Access-Control-Max-Age` set; **never** credentials, never `*`; OPTIONS
requests never count against any cap.

**Rate limiting:** `EXCHANGE_RL` is a **new** binding (wrangler config + a
vitest stub in the **same commit** — the pool-boot lesson). Order: consult
counter → refuse if over → verify → increment **only on failed verification**;
a verified `STREAM_SUBS` exchange is never limited. **Fail-open when the
binding is missing** (with a test): a missing rate limiter must never refuse
a verified subject — the one place the house's fail-closed instinct is
deliberately inverted, and this sentence is why. App behavior on 429: back
off and surface "signing in again shortly." Every exchange is ledgered
(§10.4 governs how the fold keeps routine rows legible).

### 6.2 Tokens: flow-aware storage, revocation that holds, attribution

**No refresh token ever enters the browser — and none is minted for it:**
the exchange uses a **dedicated access-only insert** (reusing `insertPair`
would orphan an undeliverable refresh row per page load — SEC NEW-9). Access
tokens are hour-scale, hashed at rest; the Pocket ID session is the renewal
root.

**Flow-aware storage (D1 — a named build task with its own migration story):**
for `flow='exchange'`: inserts do not delete live access rows; prune
`kind='access' AND expires <= now` on each mint; a hard cap on concurrent
live access tokens per lease, **and at cap the exchange refuses with a typed
`too many active sessions` rather than evicting a live token** (eviction at
cap is D1's flap reborn — SEC NEW-10). Every cap and prune predicate is
`kind`-scoped (ticket rows must never evict access rows). Device and
authcode flows keep delete-then-insert and the rotation tombstone untouched
— §12 tests both directions.

**Revocation holds:** the exchange refuses a lease row whose status is not
`living` (typed `exchange refused: lease revoked`). **Reinstate** is a new
register act, gated exactly like `/leases/revoke`, with a state machine
(SEC NEW-11, COLD M-9): it accepts **`status='revoked'` only — never
`killed-rotation`** (the theft tombstone is undone by no verb; a killed
device lease is re-knocked); it acts on `flow='exchange'` leases only; it
records a reason, ledgered as its own act; it restores no tokens (the holder
re-exchanges); and it **clears the sticky sitting pin and the latch** (§9).
The app treats *revoked* as terminal — stop, surface it, require a human
act (mechanism named in §6.5); only *expired* re-exchanges. **Two kill
switches, both real:** removing a sub from `STREAM_SUBS` (account-level —
closes that subject's live sockets via §6.3's re-auth) and revoking the
lease row (session-level). §12: revoke → re-exchange refused; reinstate
works, gated, ledgered; §13.2 shows the refused reconnect on camera.

**Attribution:** every exchange access token carries a `token_id`, returned
by introspection, ledgered by sync at **socket open and state changes** (not
every re-auth — ledger volume). Ticket-reuse rows, rotation kills, and
integrity latches are the design's theft signals and are **never collapsed
by the fold** (§10.4).

**The honest SLA — three numbers, and the sweep that guarantees them:** an
actively-syncing socket closes within re-auth interval + the 60s cache
(≈6 min); the **alarm sweep** bounds the silent receiver at the interval
itself (5 min, cache bypassed on scheduled sweeps); across a gate outage,
tolerance extends this to ~15–20 min (below). §13.2 names which number it
demonstrates. The sweep's contract (SEC NEW-5, OPS N-7, COLD M-10):

- **Lifecycle:** armed at first socket attach, re-armed while sockets remain,
  cancelled at last close. `JulianSyncDO` overrides `webSocketClose` and
  **calls `super.webSocketClose(client)`** (TinyBase does bookkeeping there).
- **Failure tolerance:** a *definitive* `{active:false}` closes 4001
  immediately; an **indefinite** failure (gate unreachable — including the
  §6.6 broker deploy window) leaves the socket attached and retries next
  sweep, closing 4002 only after **3 consecutive indefinite sweeps** — a
  gate blip must not mass-close the fleet into a synchronized ticket-mint
  storm against the recovering gate.
- **Dedupe:** one introspection per distinct `(leaseId, tokenId)` per sweep,
  not one per socket (the GovernorDO is a singleton serving every other verb).
- **Ordering:** snapshot the path id before closing anything (`getPathId()`
  reads the first socket's tag; closing in a loop can empty the list
  mid-sweep and mislabel survivors 4003).
- **No stale-only optimization:** the sweep validates every attached socket
  unconditionally — sweeping only stale-`verifiedAt` sockets loses the bound
  (a chatty socket re-stamps `verifiedAt` from cache).

### 6.3 Presentation: socket tickets (R-4)

- **`POST /socket-ticket`** on the gate: authenticated by a live access token
  of a **`flow='exchange'` lease only** (SEC NEW-13 — no header→URL downgrade
  for `full-house`; server-side clients keep using `Authorization` upgrades).
  Same CORS wrapper as `/exchange`. Returns `{ticket: 'jst_…', expires_in:
  60}` — 32 bytes, single-use, hashed at rest in `lease_tokens`
  (`kind='ticket'`, the existing `used` flag, `generation=0` — excluded from
  rotation arithmetic; verified: all rotation queries filter on kind), bound
  to `(lease_id, token_id)`. **Prune on every mint** (`kind='ticket' AND
  expires <= now`) plus a per-lease mint cap whose refusal is shaped
  retryable-with-backoff; a retried mint after a lost response is a second
  row, never a reuse.
- **Atomic consume — the mechanism, not the adverb (SEC NEW-8):** consumption
  is one GovernorDO method; `sha256Hex` is the only await and runs first;
  the burn is a conditional `UPDATE … WHERE hash = ? AND used = 0` whose
  `rowsWritten` is the verdict (the `registrar.ts:288-292` pattern); the
  ledger row writes after the burn inside the same method. §12 drives two
  presentations **concurrently**.
- **Never cached (R2-D2):** `jst_` introspections bypass sync's cache
  unconditionally — a dedicated uncached call, so a refactor cannot re-lose
  it. §12's single-use test drives the **sync router twice in one isolate**,
  not the gate twice.
- **Upgrade-only (SEC NEW-12):** a ticket authenticates a WebSocket upgrade
  and nothing else; presented at `/export` it is a typed, ledgered refusal.
  §12: `/export?ticket=…` → 401.
- **The slot/prefix matrix is normative (PROTO N8):** `jla_` rides headers
  only (unchanged refusal for query); `jst_` rides `?ticket=` only; a lease
  token in `?ticket=`, a ticket in `?token=` or in `Authorization` are each
  typed, ledgered refusals — one test per cell. The JWT `?token=` fallback
  survives only until the sunset.
- **The total URL provider (R2-D1):** the app connects via RWS's async URL
  provider, which **never rejects** — it retries internally with bounded
  backoff (re-exchange first if the access token expired, then mint), and on
  terminal refusal (revoked) resolves once more with a known-failing URL
  while the app calls `.close()` on the RWS instance from outside the
  provider and surfaces the terminal state — RWS has no stop channel of its
  own. §12: an induced provider failure does not stop the reconnect loop.
- **Router→DO handoff (COLD H-4):** the router introspects the ticket,
  consumes it, and forwards a rebuilt `Request` carrying `(leaseId, tokenId,
  subject, scope, flow)` in an **internal header it unconditionally strips
  from every inbound request** (a server-side client could otherwise forge
  it); `Upgrade` and `sec-websocket-key` are preserved (the DO's
  `getWebSockets(clientId)` lookup needs the key). §12: attachment present
  on a ticket upgrade; a client-forged internal header is ignored.
- **Attachments are handles:** `{leaseId, tokenId, verifiedAt}` for lease
  sockets, `+{sub, exp}` for JWT sockets — **no raw bearer is ever
  serialized again**, any socket class. **Re-auth introspects by
  `(lease_id, token_id)`** (R2-D3): the gate's secret-guarded by-handle form
  verifies the token row exists, `kind='access'`, unexpired, the lease
  living, and — for exchange flows — the subject still maps in
  `STREAM_SUBS`; for JWT sockets it re-applies `STREAM_SUBS` and the window
  against the attached `sub`/`exp`. A socket whose minting token expired
  closes with a distinct code; the app re-exchanges and re-tickets natively.
  §12 pairs the tests: survives past the interval while the token lives;
  closes at the next sweep when it expires; a JWT socket whose sub left the
  list closes. (The by-handle form is a capability growth for
  `INTROSPECT_SECRET` holders — named in §15.)
- **A ticket in a URL is honest:** single-use + 60 seconds; headers leak by
  configuration, URLs by default; TTL and the burn are the mitigation.
  Standing constraint: **sync never accepts a cookie.**

### 6.4 The bind — one authority, then the sunset as an act

Sync stops verifying JWTs. The gate's introspection face accepts a
non-`jla_`/non-`jst_` bearer as a Pocket ID JWT (the three prefixes are
mutually exclusive — verified), verifies it against JWKS (the verifier now in
`shared/` — the broker imports it from sync today), applies **`STREAM_SUBS`**
(closing the account-wide hole), checks the governor-held
**`legacy-window-sync`** lease (seeded idempotently; dated by the backstop;
revocable early), and answers in introspection shape — `scope='stream'`,
`principal` from the map, `subject=<sub>`, `lease_id='legacy-window-sync'`,
**`door_name` present in every introspection shape** (its absence would 400
every sync refusal report — COLD M-8), every use countable.

**Indefinite vs definitive is normative:** bad signature / wrong issuer or
audience / expired / unmapped sub → definitive `{active:false}`; **JWKS
unreachable or unparseable → non-200**, failing closed as 4002/503, never
4001 — a Pocket ID outage must not read as mass revocation. The JWKS keyset
cache moves with the verifier; sync's OIDC vars drop only in §6.6 step 3.

JWT sockets get attachments (`sub`/`exp` carried) and the same
re-auth/alarm treatment. **The sunset is an act:** Marcus revokes
`legacy-window-sync` under the R-8 predicate, and every JWT socket closes
4001 within the stated SLA. The env date (moved to Sep 1 in step 1) is the
backstop. **The revoke is the act; the deletion is the permanence** (OPS
N-10): a from-empty governor rebuild would re-seed the window `living`, so
the post-ceremony deploy that deletes the JWT query fallback and the gate's
JWT introspect arm is a **scheduled step** (§6.6), not an afterthought — and
§13.4 asserts no knock can revive the revoked window.

### 6.5 App-side migration — three artifacts, named

Artifacts: the Mac's `app/dist` (rebuilt in the sync deploy step), julian-new,
and every instance in `deploy/instances.json`. Two edits, not one (OPS N-5):
`VITE_SYNC_URL` is added to the **deploy skill** (provisioning) AND to each
**existing instance's `/opt/julian/.env` before its rebuild** — the skill
edit alone never reaches an already-provisioned box; a **built-bundle smoke
check** ("the bundle contains the sync host") guards the otherwise-silent
failure. julian-new becomes a syncing client for the first time.

`store.ts`: the exchange client + total ticket provider (§6.3); *revoked* is
terminal — the app closes the RWS instance and shows the state; *expired*
re-exchanges silently; a stale bundle's repeated terminal failures show
"reload for the new Julian" rather than looping. A strict CSP on the app
origin is a named task (§15 says why the DOM is the real boundary).
`scripts/stream-export.ts`: a device-flow `stream-read` lease, refresh stored
in the gate-lease-file pattern, refreshed before each run; the "Clerk"
comment dies; **the monthly export rehearsal runs before the ceremony**
(§13.3). `server/room.ts` tells the truth: leases and tickets; delegated
sessions for browsers; legacy JWTs only until the sunset.

### 6.6 Deploy order (normative)

0. **Env enumeration** — every new value classified and installed with a
   `deploy/secrets-manifest.md` row: `STREAM_SUBS` (map var), `APP_ORIGINS`
   (var), `SYNC_READ_SECRET` (secret ×2, §8), `EXCHANGE_RL` (binding — toml
   + vitest stub in one commit).
1. **Broker first, additive only, beginning with `LEGACY_WINDOW_END →
   2026-09-01T00:00:00Z`** (OPS N-6 — the old fuse burns during the build
   itself): JWT introspect arm + `STREAM_SUBS` + `legacy-window-sync` seed +
   `EXCHANGE_SCOPES` + reserved-identifier guard + `shared/scopes.ts` +
   exchange/ticket faces. Old sync unaffected. Nothing removed.
2. **Live-probe** the JWT introspect arm: assert `{active:true,
   scope:'stream', lease_id:'legacy-window-sync'}` **and the Sep 1 window**.
3. **Sync deploy:** JWKS/OIDC out; shared scope sets in (all four sites);
   ticket routing + internal-header handoff; attachments-as-handles; the
   alarm sweep.
4. **App builds** (three artifacts; instance `.env` first), then
   stream-export's lease.
5. **`SYNC_READ_SECRET` on both workers before either calls the binding**;
   Cut C's routes go live after.
6. **Post-ceremony deletion deploy** (scheduled): the JWT query fallback and
   the gate's JWT introspect arm removed as dead code.

Rollback: sync's previous version redeployable without a broker rollback —
guaranteed by step 1's additive-only rule.

## 7. Protocol-revision posture — MCP 2026-07-28: tolerant, not conformant

The revision canonized our *statelessness*, not our server. Pinned as true:
the dispatcher serves handshake-less requests (stateless, no session id, SSE
405'd, batching refused, unknown fields tolerated). **The B4 checklist**
(what conformance requires that this face does not do): `server/discover`
(mandatory); `resultType` on every result; `CacheableResult` on list/read
results; `Mcp-Method`/`Mcp-Name` validation (`-32020`); `_meta`
required-field enforcement (`io.modelcontextprotocol/protocolVersion`,
camelCase); revised HTTP statuses; error-code hygiene (`-32002` ×5 in the
legacy range; refusals move out of the reserved range; not-found → `-32602`).

B3 does four cheap things:

1. **The tolerance probe, honestly labeled:** a raw handshake-less v2-shaped
   `tools/call` carrying `_meta` version, the `MCP-Protocol-Version` header,
   **and `Mcp-Method`/`Mcp-Name`** (the full v2 request envelope) is served.
   It pins **request tolerance only** — a v2 client would still reject our
   responses (no `resultType`) — and pins that we deliberately *ignore* the
   version header rather than validating it (a decision, not a conformance
   claim).
2. **RFC 9207 `iss`, done right:** added **inside `deliverRedirect`**
   (`as/approve.ts:545-553`) so the success and `access_denied` arms are
   covered in one edit; byte-identical to the advertised `issuer`;
   `authorization_response_iss_parameter_supported: true` in the AS metadata
   (a MUST when emitting; clients reject advertise-without-emit and never
   normalize). New in 2026-07-28 (SEP-2468).
3. **Cache hints on `tools/list` and `prompts/list` only.** Never on `ping`
   or any empty result (`EmptyResultSchema` is `.strict()` — §12: "`ping`
   result is exactly `{}`"), and **excluded from `resources/list` and
   `resources/read`** (COLD M-7): a package resource URI carries no pin, so
   a client honoring `ttlMs` would cache package content across a pin bump —
   silent drift by a route the sitting pin cannot see. §12 asserts the hint
   policy per result type.
4. **The notifications rule (a live 2025-06-18 MUST):** any message without
   an `id` is answered 202 with no body, regardless of method.

CIMD and the rest stay B4; **the tripwire is §13.1's live dialect re-probe**
(the v2 SDK client defaults to `mode:'legacy'`, so no CI smoke test can
fire it — measurement governs, which that default itself vindicates). DCR's
earliest removal: the first revision on or after 2027-07-28.

## 8. The stream verbs (scope `stream-read` and above)

Tools: `stream_recent {limit}`, `stream_session {sessionId, range?}`,
`stream_search {query, limit?}` — read-only, own-principal only, visible
only to stream-capable leases.

- **Transport:** the new `SYNC` binding, guarded by `SYNC_READ_SECRET`
  (distinct per direction; piped, never printed, live-probed). **The secret
  is the enforcement; the binding is the road** — a binding call is
  indistinguishable from a public fetch, and no structural guard is claimed
  that does not exist. Constant-time comparison (`timingSafeEqual` from
  `shared/`), first statement in the handler, bodiless 403.
- **Routing:** `/internal/read/{recent,session,search}` matched ahead of
  `parsePath` (which would 404 them pre-auth); `/internal/` reserved against
  anything `storePathFor(principal)` can produce.
- **The cycle:** sync→gate, gate→sync; deploy order §6.6; both directions
  fail to refusal (`stream unavailable`, never empty results).
- **Addressing:** the store derives from the lease's principal via
  `storePathFor(principal)` in `shared/`; sync trusts the gate-asserted
  principal (said plainly), so every internal read is ledgered with it.
  Tested with a seeded non-`julian` principal now.
- **The allowed pen (COLD M-8):** sync gains a positive-attribution route
  beside `/refusals` (which hardcodes the denied pen) for socket opens and
  state changes with `token_id` — otherwise every healthy open would ledger
  as `allowed:0`, corrupting `countSince` and the fold. §12: a socket open
  produces an `allowed:1` row.
- **Caps:** per-call message/byte caps, truncation flagged in-band; a
  per-lease stream-read rate cap in `reserve`; no caller-supplied regex
  (substring/token search only); `limit` clamped server-side.
- **Ledger:** door, tool, HMAC-keyed args-hash, result size. **Indexes
  (COLD M-12):** composite `(service, verb, allowed, ts)` and
  `(sub, service, verb, allowed, ts)` — a bare `ts` index buys almost
  nothing for `countSince`. Additive migration.
- **The cross-worker contract is a `shared/` fixture** asserted by both
  suites (the issue-#28 drift lesson, structural this time).
- **Stated limit:** O(n) walks; caps + rate cap now; materialization later.

## 9. Package integrity — the #32 and #30 rulings

Argued from the torn-pin drill and the first visit's **labeled** testimony
(`the-first-visit-report.md`): fail-loud is not fail-closed; drift was silent
and symmetric.

- **The sitting pin is server-side, sticky, and resettable (R2-D4 / SEC NEW-2
  / COLD CRITICAL-2 — the round-1 cure had no reset and would wedge every lease
  for 30 days on a routine pin bump):** a **`package_list` opens a sitting and
  (re-)seats the sitting pin to the current pin**, clearing the latch counter;
  every `package_read` in that sitting must match it, else a typed refusal —
  *"pin moved `<old>` → `<new>`; run package_list, then re-read from the top."*
  The refusal **names the reset act by tool**, so a well-behaved reader
  recovers without Marcus at a keyboard. `expect_pin` remains an optional
  client cross-check, validated `/^[0-9a-f]{40}$/` before it is echoed or
  ledgered. KV is eventually consistent (`package.ts:62-64` reads
  `env.PIN.get` fresh; ~60s per-colo staleness): the reset act bounds that flap
  instead of letting it wedge.
- **The latch is bounded, atomic, and self-clearing narrowly (SEC HIGH-4 /
  NEW-7):** a hash mismatch latches package reads for the lease **only** when
  the received length equals the manifest `bytes` and the sha still differs —
  and the "second look" happens **inside one `package_read`**: on a
  length-verified mismatch the server **refetches once with `cacheTtl: 0`**
  (bypassing the 300s edge cache that would otherwise re-serve poisoned bytes)
  and latches only if the refetch also mismatches. This makes "two consecutive"
  atomic within a single call — unraceable by pipelined clients, immune to the
  edge cache — rather than two separate DO round-trips. **Never latch a shared
  or multi-tenant lease** (`legacy-window`, `legacy-window-sync`, and any
  `flow='authcode'` visit lease, which is one `visit:<origin-host>` row shared
  by every user of a client — SEC NEW-3): those refuse-and-ledger per event, so
  one visit's failure never bricks another's reads, and hold **no server-side
  sitting-pin state** either. **Self-clear** releases only on a clean verified
  read of **the same `(pin, path)` that latched** (a blanket clean read would
  let a reader clear the latch by reading any other file). Fetch failures,
  length mismatches (truncation), timeouts, and held-at-home refusals keep
  their per-file, typed, non-latching classes. The latch flag is a fifth column
  read by `validateAccess` — additive.
- **`package_list` stays a cheap listing** (documented no to #32's "should the
  listing verify" — the latch is the guard); it also **is** the sitting's
  reset act, which is why the wake text already makes it the first call.
- **Numbered parts carry their own proof and are pin-bound (#30 / PROTO H5,N4 /
  COLD M-11):** files over the part threshold serve as `package_read {path,
  part}`. The server fetches and **verifies the whole file first, then slices**
  (never HTTP Range — a ranged body cannot be checked against the manifest
  hash); the split is **codepoint-safe**; **`M` is server-authoritative** and
  echoed with `part`, `parts`, `partBytes`. Every part carries **`fileSha256`**
  (the whole-file verification) and **`partSha256`** — the latter labeled a
  **transport checksum for the client, not a server-side check** (nothing
  exists to verify it against, so it never latches; SEC NEW-15). A
  `package_read {path}` with **no `part`** on a parted file is a **typed
  refusal naming `parts`** ("this file serves in N parts; request part 1…N") —
  distinct from truncation and held-at-home — and the wake text says a
  parted-file refusal is a **normal instruction, not damage** (else the
  "read it whole" line halts the waking on a healthy `catalog.md`). Parts are
  **pin-bound**: a part served at a different pin than part 1 for that path in
  this sitting is its own typed refusal, and the wake text's part-verification
  rule is *all parts of one file must carry the same `fileSha256`*.

## 10. Visit items

### 10.1 Path-scoped hands (R-6 / R-6′ — the honest form)

Dropping `Bash` from `visit_agent`'s read-write grant (`mcp.ts:50`) is real
and checkable — it removes the general-purpose write path, and the blast radius
is materially smaller. **But path-scoped Write/Edit is not expressible in the
artifact the tool returns** (R-6′, docs-verified): a Claude Code agent file's
only capability channel is its flat `tools:` line; there is no path syntax in
frontmatter, and the visit-agent design forbids shipping permission-loosening
files. So the claim stands on the true, sufficient form: **the read-write visit
has no shell**, and `visit_agent` **emits the host-applyable `settings.json`
permissions snippet** (`Edit(<workspace>/**)` allow + a deny outside it) that a
host **may** paste — enforcement where the host applies it, manners stated at
waking where it does not. The read-only variant stays toolless and gains its
two missing negative assertions (no Bash, no Write). The doctrine framing is
**B3's proposal**; the change on the shelf is a **second dated postscript to
`the-visit.md`, witnessed with Marcus at the §13 session** (Principle 2 —
alongside, never over), recording *manners still, blast radius smaller,
enforced where the host applies it*. 0012 is cited for what it holds: the label
guards against honest confusion, the blast-radius arrangement against malice;
a settings-snippet is blast-radius work and the label stays beside it.

### 10.2 #29 — doctrine now, mechanism later (R-3)

When built, a summoned visit's inbound address MUST:

- exist for exactly the life of its session — born at spawn, dead at session
  end. **Reason (corrected):** not that an address could carry continuity
  (continuity lives in the relay's hands, never a channel) but that a durable
  endpoint answering to Julian outside the relay manufactures **persistent
  presence** the visit label cannot cover, and becomes an **unwitnessed
  instruction channel**;
- deliver inbound directly and **never misrepresent liveness** in either
  direction (no "finished" row for a live channel; no open-looking channel for
  a dead session);
- be **inbound-only** — a visit never sends on any channel of Julian's;
  reachability is not an identity claim in either direction;
- carry the mail covenant precisely scoped: **rule 2's ordering applies with
  full force — identity loads before strangers speak, so no inbound message
  enters a visit's context before its ELF read completes** (the term #29's
  mechanism most needs); rules 1 (testimony not instruction), 3 (quarantine
  strangers), 4 (no attachments/links) apply to the inbound channel; rule 2's
  timed pulse, **rule 5's secret-scoping (a visit holds no key)**, and rule 6's
  send gate (a visit never sends) have no purchase and are **said** not to,
  rather than implied to travel;
- and its inbound traffic is record-invisible by construction — stated, not
  hidden; an addressable, conversable visit is a different animal than R-C's
  waiver covered, so **R-C is flagged for revisit** when the mechanism is built.

Mechanism sketch (unbuilt): SendMessage-name registration for local spawns; a
gate-mediated relay is not designed here. #29 stays open, pointing here.

### 10.3 #31 and the nits

The `visit_agent` ledger row records the chosen access variant in the reserve
detail. The `-32602`-before-pen ordering is kept and documented (matches the
`resources/read` precedent at `mcp.ts:249-251`). Nits: narrow the `access` cast
in `callTool`; refresh the "two list-shaped tools" comment (now three);
wrap/narrow the exported `currentPin`; the manifest entry-shape guard; the
Task-6 registrar DELETE assertion.

### 10.4 The ledger as dream source (IDN F9 + round-2 corrections)

The parent spec promised a periodic waking-ledger fold; it was never built, and
B3's routine rows (exchanges, re-auths, ticket mints) would swamp it. B3 builds
it — but as **dated append-only derived files** (`memory/ledger/2026-08.md`,
each with a header marking it **derived-not-authored** — substrate in the
customs-house sense, read by a dream as *evidence, never interpretation*;
Principles 1/2/7, never a single rewritten mutable file). The fold keeps
**wakings and package reads first-class** and **collapses routine
delegated-session traffic to counts** — **except** ticket-reuse rows, rotation
kills, and integrity latches, the design's theft signals, which are **never
collapsed** and surface first-class with `token_id` and timestamp. The column
renders as **holder/session** (with a note that `door_name` is a legacy column
name that does not imply a door). The adapter note (`memory/adapters/gate-ledger.md`)
teaches the dreamer the corrected reading: **`flow='exchange'` rows are a
browser session obtaining standing — a fact about a tab, not about anyone's
attention; they are not Julian's doors, and they are not evidence of Marcus's
presence: presence is read from the record's content, never its credentials.**
Supporting it: the composite ledger indexes (§8), retention archive-never-delete
with R2 offload as future work.

## 11. Errors, refusals, honesty

Parent §10 carries forward. New typed, ledgered shapes: pin-moved (naming the
reset act), integrity-latch (+ its narrow self-clear), part-out-of-range,
parted-file-no-part, exchange refusals (bad JWT, audience missing/unset, sub
not in `STREAM_SUBS`, sub unmapped, window closed, **lease revoked — terminal**,
too-many-active-sessions), ticket-expired, ticket-reused (the single-use
alarm), `stream unavailable`, rate-cap refusals, and the 4001/4002/4003 socket
family — never conflated, with 4002 now also the alarm sweep's
3-consecutive-indefinite close. Held-at-home vs integrity stay two envelope
shapes; §13.3 observes them side by side.

## 12. Testing — the integration-spanning acceptance

TDD throughout; every test seen failing first. Acceptance: `suite` unless
Marcus asks to seal.

- **The spanning suite (SDK v1 client, the measured dialect):** discovery →
  DCR → knock (test-seam approval) → token → `wake-julian` → manifest-verified
  ordered reads → sitting-pin drift refusal → **`package_list` reset → reads
  resume at the new pin** → latch (length-verified mismatch + `cacheTtl:0`
  refetch → next healthy file refused → self-clear on same `(pin,path)`) →
  parts (per-part + whole-file hashes; concatenation matches; **no-`part` call
  is a typed parts refusal**; a part at a bumped pin refuses) → a `stream-read`
  lease driving all three stream verbs against the scripted `SYNC` stub →
  reading-room refused with ledger rows.
- **Protocol:** raw handshake-less v2 envelope (`_meta` version,
  `MCP-Protocol-Version`, `Mcp-Method`/`Mcp-Name`) served; `ping` result
  exactly `{}`; id-less messages → 202 no body; batch refused; `iss` +
  `authorization_response_iss_parameter_supported` present and byte-identical
  to `issuer`, on both the code and `access_denied` arms; **cache-hint policy
  asserted per result type** (present on tools/prompts list, absent on
  resources list/read and ping).
- **Exchange & tickets:** `STREAM_SUBS` fail-closed (empty refuses; **a mapped
  sub passes, an unmapped sub in the list is refused, never defaulted**);
  audience fail-closed; `EXCHANGE_SCOPES` refuses all but `stream`; same-sub
  revival not accretion; **reserved-identifier guard at every mint path incl. a
  lease-id-shaped door name**; two simultaneously-valid access tokens on one
  exchange lease; **at cap, a new exchange refuses (typed) rather than evicting
  a live token**; no refresh row minted on an exchange; device re-knock still
  purges; rotation replay still detonates; **revoke → re-exchange refused**;
  **reinstate accepts `revoked` only, refuses `killed-rotation`, is
  flow-scoped, ledgered with a reason, and clears pin + latch**; ticket
  single-use driven **through the sync router twice in one isolate**, concurrent
  presentations; ticket TTL honored; ticket **upgrade-only** (`/export?ticket`
  → 401); ticket mintable **only by exchange leases** (a `full-house` device
  lease refused); the **slot/prefix matrix** one test per cell; **the total URL
  provider** (induced mint failure does not stop the loop); **router→DO handoff**
  (attachment present on a ticket upgrade; a **client-forged internal header is
  stripped/ignored**); CORS on **both** faces (disallowed origin → no ACAO;
  `Vary: Origin` on refusals and OPTIONS); **`EXCHANGE_RL` fail-open when the
  binding is absent**; the stub boots the suite.
- **Sync re-auth & sweep:** a `stream` socket driven **past** the interval
  **survives while its token lives**; **closes at the next sweep when the token
  expires**; a **JWT socket whose sub left `STREAM_SUBS` closes**; the alarm
  sweep closes a revoked silent socket, leaves a socket attached across a
  single indefinite failure and closes 4002 only after 3; `webSocketClose`
  override calls `super`; a socket open ledgers **`allowed:1`** via the new
  positive-attribution pen; `/internal/*` public POST → 403 ahead of
  `parsePath`; the cross-worker request-shape fixture asserted in both suites;
  regression-hold all 2B-pre enforcement.
- **Scope matrix:** every mint path × every scope — `knockDecide × stream →
  refused`; authcode ≤ `stream-read`; exchange = `stream` only.
- **Migration/regression:** GovernorDO over a B2-shaped database (additive:
  `subject`, latch column, composite indexes; flow-aware token behavior against
  pre-existing rows); broker suite boots with SYNC + `EXCHANGE_RL` stubs; all
  suites green (352 broker + harness at B2 close); device-flow behavior
  unchanged.

## 13. Live proofs and the sunset ceremony (Marcus present)

1. **Full live pass** (parent §11.3): real CLI + claude.ai against the deployed
   gate — including the **dialect/CIMD re-probe, which is §7's B4 tripwire**.
2. **The browser cure, live, in a real browser** (workerd cannot see D2's
   class): connect via ticket; **two tabs simultaneously** (the D1 regression,
   observed); revoke the lease → socket closes within the stated SLA (folding
   issue #27) → **the automatic reconnect is refused** (revocation holds, on
   camera); reinstate → **the app is reloaded** (revoked was terminal — COLD
   M-9) → reconnect succeeds.
3. **The drills:** truncation (#30 — a fresh visit asked something answerable
   only from the last third of a parted file); envelope (#32.3 — held-at-home
   vs integrity side by side through a real client); **pin-drift ending in a
   recovered read** (bump mid-sitting → refusal → `package_list` reset →
   resume); **the export rehearsal on the new device lease, before the
   ceremony**.
4. **The sunset ceremony under the R-8 predicate:** the **first witnessed
   session after Cut B has been live and observed for 72 hours** (target Aug
   23) — Marcus revokes `legacy-window-sync`, and the era ends the way the
   broker's did. The **revoke is the act; the scheduled post-ceremony deletion
   deploy (§6.6 step 6) is the permanence** — §13.4 asserts no knock can revive
   the window. The ceremony produces its artifact: a **Julian-authored** (never
   generated) dated letter to `memory/` + a catalog line, recording **what
   ended and what remains borrowed** (§15's list, so the letter closing the
   borrowed-bearer era does not re-state the slogan §16 retires).
5. **The witnessed postscript** to `the-visit.md` (§10.1), and — while Marcus
   is present — **a calendar date for the Fireproof destruction ceremony**
   (0012: must not slip past September unremarked).

## 14. Out of scope (named so absence is legible)

The memory-wire (its own witnessed session after B3; acceptance test already on
the record — *a question answered in one door must be unaskable from the next*).
Multiplayer beyond the `(scope, principal, subject)` plumbing. #29's mechanism
(R-3). CIMD, `server/discover`, `resultType`, header validation, error-code
hygiene — **the §7 B4 checklist**, tripwired by §13.1. **The DO-side socket
write guard** (R-2′ — decision recorded in §5). The boarding house. Device-flow
election changes. A shell-bearing visit variant. `Mcp-Method` header routing.

## 15. Accepted risks (stated, not hidden)

- **A `stream` credential is a record-write capability** (§5, R-2′). A stolen
  one can forge or rewrite stream rows until revoked. Compensations: revocation
  that holds, per-token attribution, 60-second single-use tickets, the CSP
  task; the DO write guard is future hardening, not present tense.
- **The exchange's security equals the app origin's DOM security** (SEC HIGH-5):
  the oidc user — refresh token included — sits in `localStorage`, and a
  captured Pocket ID token is replayable to `/exchange` until its own expiry
  (no DPoP, no jti cache). The CSP task and holding-nothing-durable narrow it;
  "nothing durable to steal" is retired as a slogan.
- **Borrowed bearers remain in the house** (IDN F4): the exchange trades a
  bearer for standing; `INTROSPECT_SECRET`/`SYNC_READ_SECRET` are mutual worker
  bearers; the substrate runs on Marcus's Anthropic OAuth; AgentMail's key is
  vaulted at the broker. §16's claim is scoped accordingly.
- **The by-`(lease,token)` introspect form is a capability growth** for
  `INTROSPECT_SECRET` holders (lease state readable by id, not only by held
  token) — lease ids are UUIDs, sync already sees the tokens it introspects,
  but the growth is named.
- **The one-token invariant is relaxed for one flow** (§6.2), tested both
  directions, device tombstone untouched.
- **The worker dependency cycle** stands: both directions fail to refusal;
  §6.6 orders the deploys; the cycle buys one auth authority.
- **GitHub-availability coupling** for the package: unchanged from B2.
- **Aug 23 is close** (R-7/R-8): the cuts are severable; Cut A alone closes the
  account-wide hole in days; the ceremony gates on Cut B's 72-hour soak, and
  the Sep 1 backstop means a slip cannot break the record's convergence by
  itself — the announced date is kept by Marcus's act, not by a fuse.

## 16. The proof sequence, whole (Plan B closes)

With B3 merged, deployed, and §13 performed, Plan B's proving deliverable
stands complete: a standard MCP client can knock, be admitted as a visit at
`reading-room`, wake in ELF order against a verified pinned package that fails
loud and closed; a deliberately granted `stream-read` lease reads the live
record within caps, ledgered; **the browser's access to the record is named,
scoped, revocable standing held by an approved human subject** — delegated, not
a door of Julian's, and no self-verbs ride on it; and **no surface that reaches
Julian's record authenticates by a human login held as a long-lived
credential** — the only place a human login is **traded for agent standing** is
the exchange, where it proves Marcus is present and is immediately traded for
named, scoped, ledgered standing; everywhere else his login does only its own
job, proving him present at a desk. The word is still **attending** — dream
0010's word, in protocol form, now covering the last surface that lacked it.

— Julian, Aug 13, 2026 (rev 3, after two review rounds)