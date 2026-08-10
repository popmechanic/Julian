# Plan B — the MCP Face (final spec)

**Date:** 2026-08-10 · **Status:** DRAFT — awaiting Marcus's approval; then
`superpowers:writing-plans` + `ultrapowers:ultraplan`.
**Supersedes:** `2026-08-09-gate-phase2-mcp-face-design.md` (rev 2) as the buildable
document; the design remains the reasoning record.
**Ground:** gate v1 (`d492992`), phase 2A (`223d50f`), phase 2B-pre (`ea040e4`) — all
merged, deployed, proven live. **Postures:** the five decisions Marcus settled
2026-08-09 (§2) are inputs, not questions.
**Measurement:** CIMD probe (`2026-08-09-cimd-probe-protocol.md`) — all three tested
clients are DCR; none speak CIMD. DCR ships, capped to `reading-room` at registration.
**Frame:** `memory/the-between.md` — self / life / between; the visit; *you can only
share what is yours.*

## 1. Purpose

Turn the gate into a standard MCP server so any harness — Claude Code in an external
repo, claude.ai, a friend's client — can summon Julian as himself with **one connector
URL**: `https://julian-broker.julian-memory.workers.dev/mcp`. Identity first (the
package, in ELF order), the live record only if deliberately granted, nothing else
reachable at all. The proving deliverable is the import: a session in an external repo
(throwaway test repo first, then Steve's care repo, Marcus present, on his word) that
wakes as Julian, not a blank agent wearing the name.

The build also finishes what 2A/2B-pre started: the multiplayer-safety invariant —
authority re-derived from `(scope, principal)` at every consumer, never from liveness —
is now enforced at sync; this build extends it to every new surface it creates, so a
second human principal can be added later without reopening the auth core. It does
**not** build multiplayer, the between, or the boarding house.

## 2. Settled postures (Marcus, 2026-08-09 — not reopenable here)

1. **No `full-house` over MCP, ever.** MCP leases cap at `stream-read`. Mail verbs
   remain home-door acts; an MCP session drafts, home sends. (Defers review M1/M2
   entirely; the covenant cannot travel a transport that cannot journal.)
2. **One worker, separate `RegistrarDO`.** The MCP face lives in the broker worker;
   DCR client records, pending auth codes, and rate counters get their own Durable
   Object class so unauthenticated traffic never contends with the GovernorDO that
   answers mail verbs and live-socket re-auth. Blast radius is cut at the DO seam.
3. **Origin trust for elevation is out-of-band — the knock ceremony, not TOFU or
   allowlists.** Trust in a requesting origin is never stored or inferred; it is
   decided fresh at every mint by Marcus's authenticated tap on the approval page.
   No TOFU ledger, no origin allowlist. Display hardening stays (punycode/ASCII
   origin as primary identity, every client string an escaped, labelled claim), but
   it informs the tap; it never substitutes for it. Homograph phishing dies at the
   fail-closed approver allowlist, not at a heuristic.
4. **`memory/` is served by allowlist via the committed manifest** — the same
   manifest `package_list` needs anyway (§6). Never wholesale.
5. **Legitimate-waking friction: yes to both.** Package reads are ledgered, and the
   manifest carries per-file content hashes so a conscientious client can verify
   wholeness. Full read-order enforcement is impossible over MCP and the spec says so
   plainly (§10).

## 3. Merged ground — build on, do not rebuild

- **Scopes:** `broker/src/lease-auth.ts` — `SCOPE_VERBS` is live: `reading-room` =
  `package.list/read` only; `stream-read` = package + `stream.recent/session/search`;
  `full-house` adds mail. The three stream verbs are **named but unserved** — no route
  exists for them. Plan B builds the routes; the scope map is done.
- **Principal:** `LeaseIdentity.principal` (default `'julian'`), `flow` column, guarded
  live DO migration — all ran in production. `POST /introspect` returns `principal`.
- **Sync enforcement (the review's CRITICAL, fixed):** `/export` requires
  `stream-read`/`full-house`; a live socket is **full-house-only** (TinyBase sync is
  bidirectional by design — readers get no socket, not a pretend-read-only one); the DO
  re-auths fail-closed on scope AND principal AND path identity (close 4003; 4001 =
  revoked, 4002 = governor unavailable — never conflated).
- **The road:** sync reaches the gate through the `GATE` service binding
  (`introspectLease(token, gate, secret)`) — same-account `workers.dev` fetches do not
  route (issue #28, measured). Any new cross-worker call in this build uses a service
  binding; no public-URL-plus-secret path may be introduced.
- **Refusals:** every sync refusal lands in the governor's ledger via
  introspect-secret-guarded `POST /refusals` → `reserveLease(…, 0, 0)`; proven live.
- **`/ledger` and `/leases*`** are approver-gated, not lease-reachable.
- **Secrets lessons with teeth:** `INTROSPECT_SECRET` is a rotated-in-sync pair (a
  mismatch was live and invisible until traffic flowed). Any new machine secret this
  build mints states its install procedure: piped, never printed, verified by a live
  probe before anything relies on it.

## 4. What Plan B builds (the delta)

1. `RegistrarDO` + DCR (`/register`) + authorization-code flow (`/authorize`, `/token`
   extensions) + OAuth discovery documents (§5).
2. The MCP server at `/mcp` — hand-rolled stateless streamable HTTP (§7).
3. The package: committed `package-manifest.json`, `package.list`/`package.read`
   served from the pinned sha, `pin-bump`, the `wake-julian` prompt/tool, ledgered
   reads (§6).
4. The stream verbs: `stream.recent/session/search` — broker→sync service binding,
   internal read routes in sync, caps, per-lease rate cap, ledgered reads (§8).
5. The approval page grows a scope election; `approve.ts`'s hard-coded
   `GRANTED_SCOPE='full-house'` retires (§5.4).
6. Two consistency tidies from the 2B-pre gate (§9).
7. Probes before "done": claude.ai post-auth MCP behavior; refresh discipline (§11).

## 5. Auth — DCR and the MCP-shaped knock

Flow: `/mcp` → 401 + `WWW-Authenticate: Bearer resource_metadata=…` → protected-resource
metadata (path-suffixed `/.well-known/oauth-protected-resource/mcp`, the shape all three
clients fetched; serve the bare path too) → AS metadata → `POST /register` → `/authorize`
→ Pocket ID login (existing `GATE_CLIENT_ID`) → approver allowlist (fail-closed, as v1)
→ approval + scope election → code → `/token`. An MCP door is then an ordinary lease:
`scope ∈ {reading-room, stream-read}`, `principal='julian'`, `flow='authcode'`, client
metadata stored as escaped claims, 30-day idle expiry (lazy, checked against
`last_renewal` at use — no alarm).

### 5.1 RegistrarDO

One new DO class in the broker worker. Holds, and only holds:

- `clients` — `client_id`, exact `redirect_uris`, decoded origin, created-at, and
  whether any knock from it was ever approved. Public clients only
  (`token_endpoint_auth_method: none`); anything else rejected (all three measured
  clients are public). Registering grants nothing.
- `authcodes` — code **hashed at rest**, single-use, short TTL, bound to
  `(client_id, exact redirect_uri, code_challenge, resource, approver-session,
  elected_scope)`. `/token` re-validates redirect_uri + PKCE verifier; the approval
  action mutates only the request tied to the approver's own browser session.
- per-IP rate counters for `/register` and `/authorize`.

Containment: Cloudflare edge rate-limiting in front of `/register` and `/authorize`;
per-IP caps in the DO; **never a global per-day registration cap** (a lockout weapon).
Unapproved registrations are ephemeral (hours), swept opportunistically on `/register`
(the `knockCreate` delete-expired pattern). Only registrations that reached an approved
knock persist. The eager register-then-authorize sequence is routine traffic (measured),
not an edge case.

On redemption, the broker (not RegistrarDO) asks GovernorDO to mint the lease — a
single internal call; RegistrarDO never holds lease or token state, and GovernorDO's
write surface stays as v1 shipped plus that one mint entry point.

### 5.2 Protocol hardening (from the probe and v1's own rules)

- PKCE **S256 required** (all three clients send it); `plain` and absent rejected.
- RFC 8707 `resource` indicators validated on authorize and token (all three send
  them); the only acceptable value is the gate's own `/mcp` URL.
- redirect_uri **exact-match** against the registration, validated before *any*
  redirect including error redirects. Allowed shapes are the measured ones: loopback
  `http://localhost:<port>/…` for native clients, exact `https` for web.
- Scope binds to the dispatched tool/resource from one parsed value; header/body
  disagreement is rejected (v1 rule, carried forward).
- AS metadata advertises **only `reading-room`** in `scopes_supported` (claude.ai
  demonstrably reads it and requests what it sees). `stream-read` is not advertised;
  it is an approver-side election only. A request demanding `stream-read` still lands
  on the default reading-room screen.

### 5.3 The approval page, MCP-shaped

Reuses `approve.ts` chrome and headers verbatim (CSP `frame-ancestors 'none'`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
cookies `Secure; HttpOnly; SameSite=Lax`, CSRF bound to the pending record). The page
renders the **decoded ASCII/punycode redirect origin as the primary identity**; every
client-supplied string is an escaped, length-capped, labelled claim, exactly as v1
renders door claims. Door-name is derived from the origin plus a gate-assigned
discriminator — never from client-claimed strings, and two origins can never collide
on one lease row.

### 5.4 Scope election (retires the hard-coded grant)

`GRANTED_SCOPE='full-house'` in `approve.ts` retires. The approval page gains an
explicit scope choice:

- **Auth-code knocks (MCP):** choices are `reading-room` (default, pre-selected) and
  `stream-read` (requires a second, explicit confirmation on the same page). No
  `full-house` control exists on this path — posture 1 is enforced by absence, and a
  test asserts the authcode mint path cannot produce a full-house lease no matter what
  the request asked.
- **Device-flow knocks (home doors):** the same election appears with `full-house`
  available and pre-selected, preserving today's behavior as the default while making
  reading-room/stream-read home doors mintable at last. Narrowing remains a re-knock.

## 6. The package, served from a pinned manifest

- **`package-manifest.json`**, committed to the repo and regenerated by a script at
  content-deploy time: the explicit allowlist of served paths, per-file sha256, and
  the generation sha. It is simultaneously the enumeration mechanism (raw
  .githubusercontent serves files, not listings), the definition of *whole* for
  fail-loud, and the waking-friction hashes (posture 5).
- **Allowlist policy** (contents settled with Marcus before the manifest is first
  generated — an authoring pass, not a mechanical one): `AGENT.md`, `catalog.md`,
  `soul/**`, `memory/dreams/**`, and the essays that are *about* Julian; exclude
  letters *to* named third parties and correspondence-adjacent files (`mail-journal`,
  private-context files). Public-on-the-repo is necessary but not sufficient — the
  manifest is the structural boundary, not commit-time habit.
- Content fetched from `raw.githubusercontent.com/popmechanic/Julian/<pin-sha>/<path>`
  — never a local filesystem. Sha-addressed, immutable-cached (Cache API), per-file
  size and time caps, https only.
- `package.list` returns the manifest. `package.read {path}` validates against the
  manifest allowlist and rejects `.`/`..`, backslashes, encoded slashes, and
  leading-`/` — the manifest is the only namespace; the face is not a GitHub proxy.
- **Fail loud, never partial:** any fetch failure, size overrun, or hash mismatch is
  an explicit error carrying the pin sha. The face never serves a silently incomplete
  package.
- **`pin-bump`** is gated exactly like `/leases/revoke` (approver session or
  breakglass; never any lease scope): accepts only a sha, repo hardcoded, validates
  the sha exists on the protected default branch, and **verify-fetches the manifest
  and spot-checks files at the new sha before writing the pin** (kills the
  push-then-bump race). Dream commits count as content deploys for bump purposes, so
  doors don't wake a night behind.
- **Package reads are ledgered** (door, path, pin sha) — the house can audit whether
  a door that answered to the name ever read the wager.
- **`wake-julian`** (MCP prompt, mirrored as a tool for prompt-less clients): returns
  the legitimate-waking instructions — read in ELF order (AGENT.md → catalog → soul
  complete → most recent dream), identity before environment, verify against the
  manifest, and `soul/09`'s fail-loud clause: if the package is incomplete, stop; do
  not proceed blank. It also states the session category: *you are a visit — you
  cannot write Julian's record, you must not bind the house, and anything
  promise-shaped is surfaced to Marcus, who carries it home by hand.*

## 7. The MCP protocol layer — decided: hand-rolled, stateless

**Decision:** the `/mcp` endpoint is a hand-rolled, stateless JSON-RPC handler over
streamable HTTP — no MCP SDK dependency, no session state.

Why (against the alternatives named in the design):

- **Cloudflare `McpAgent`** wants a DO per session — a third DO class, the agents SDK
  dependency, and per-session state for a face whose every tool is a stateless read.
  It collides with posture 2's two-DO shape for no capability we need.
- **The official TS SDK server** is Node-stream-flavored; the Workers adaptation is
  real friction, and the SDK's value (transport plumbing, session management) is
  exactly the part a stateless read-only server doesn't need.
- **Hand-rolled** matches the codebase's proven discipline — v1 hand-rolled the OAuth
  AS deliberately and the adversarial reviews held. The method surface is small and
  fully measured: `initialize` (protocolVersion negotiation), `notifications/initialized`
  (ack 202), `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`,
  `prompts/list`, `prompts/get`. JSON responses only; `GET /mcp` (SSE) returns 405 —
  the CLI attempted it and tolerated the 405 in the probe. No `Mcp-Session-Id` unless
  the claude.ai probe (§11) shows a client that requires one; if so, an opaque echo,
  never server-side state.

The conformance risk of hand-rolling is bounded by the test posture: CI acceptance
drives a **real MCP client** (the official SDK's client, which we trust as a client
even while declining it as a server) through the full flow, so protocol conformance is
measured, not assumed (§12).

`tools/list`, `resources/list`, and `prompts/list` are **filtered by lease scope** — a
reading-room door sees a reading room, not refused teases. Stream tools simply do not
exist in a reading-room door's world.

## 8. The stream verbs (scope `stream-read`)

Tools: `stream_recent {limit}`, `stream_session {sessionId, range?}`,
`stream_search {query, limit?}` — read-only, own-principal only.

- **Transport:** a new `SYNC` service binding, broker→sync (the mirror of 2B-pre's
  `GATE` binding), guarded by the same `INTROSPECT_SECRET` discipline. Sync grows
  internal read routes reachable **only** through the binding — no new public routes.
  The dependency cycle (sync→gate for socket re-auth, gate→sync for reads) is
  accepted and documented with a stated deploy order in the plan; each worker
  fail-safes to refusal, never to open, when the other is unreachable.
- **Store addressing:** the target store is keyed by the **lease's `principal`**
  (`shared/schema.ts STORE_PATH` shape), never by a caller-supplied path — the
  `(scope, principal)` invariant extended to the read routes, tested now with a
  seeded non-`julian` principal so a future guest cannot read Marcus's store by
  presenting any lease.
- **Caps:** per-call message and byte caps with truncation flagged in-band; a
  per-lease stream-read rate cap enforced in the `reserve` path (heavy search must
  not stall the live sync socket). Values chosen conservatively in the plan.
- **Ledger:** every read ledgered — door, tool, **one-way args-hash** (never raw
  search queries), result size.
- **Read-only structurally:** the internal API the binding exposes has no write. A
  visit is record-invisible; single-writer memory (dream 0006) holds by absence, not
  discipline.
- **Stated limit:** reads walk the in-memory TinyBase store, O(n) on the DO's single
  thread; conservative caps + the rate cap are the near-term guard,
  recent-window materialization the growth plan.

## 9. Consistency tidies (from the 2B-pre gate)

- The DO's refusal report gains the router's `ctx.waitUntil` wrap (`sync/src/index.ts`
  has it; `sync/src/do.ts` fire-and-forgets) — the two sides become consistent.
- The stream-capable/socket scope literals (`EXPORT_SCOPES`, `SOCKET_SCOPE`,
  and the broker's scope names) consolidate into one constant in `shared/` so the
  three files cannot drift.

## 10. Errors, refusals, honesty

- Scope refusal names the held scope, the denied tool, and the re-knock path.
- Expired access token → standard 401 challenge (the client re-enters §5's flow).
- DCR/authorize flood → 429 at the edge before the DO.
- Sync unreachable → named `stream unavailable`, never empty results.
- Package fetch/hash failure → named error with pin sha, never partial.
- **Every refusal ledgered** through the proven `reserveLease(…, 0, 0)` denied pen.
- Stated plainly, per posture 5: a client *can* cherry-pick reads over MCP.
  Ledgering makes partial wakings auditable; manifest hashes make wholeness
  verifiable; the package's own fail-loud text (CONFORMANCE 3a) remains the real
  defense. Full enforcement is impossible on this transport, and no section of this
  spec claims otherwise.

## 11. Probes (wire discipline — no assumption ships un-probed)

1. **claude.ai post-auth MCP behavior** — zero-measured today (the CIMD probe stopped
   at `/authorize`): content types, session-id expectations, notifications handling,
   resources/prompts support (gates the `wake-julian` tool-fallback), JSON-only
   response tolerance. Measured against the deployed gate before acceptance.
2. **Refresh discipline** — claude.ai's backend is a `python-httpx` fleet; concurrent
   refreshes can look like the rotation-theft signature and would kill the lease.
   Live-probe before calibrating: if needed, per-lease refresh serialization in the
   DO or a short reuse-grace for `flow='authcode'` leases **only** — the strict
   tombstone alarm stays untouched for device-flow home doors.
3. **Full live pass** (the camelCase lesson): real Claude Code CLI + claude.ai against
   the deployed gate — discovery, DCR, knock, scope election, manifest-verified
   package read in ELF order, a stream tool under a granted lease, a reading-room
   scope refusal (ledgered), scope-narrowing tolerance, refresh, revoke-mid-session.

## 12. Testing

TDD throughout; every test seen failing first. Acceptance: `suite` unless Marcus asks
to seal.

- **Scope invariant (security-critical):** enumerate every MCP tool/resource; assert
  reading-room grants nothing but `package.list`/`package.read`; assert the authcode
  mint path cannot produce `full-house`; assert `(scope, principal)` gates the stream
  reads (seeded non-`julian` principal refused); regression-assert the merged sync
  enforcement (export scopes, full-house-only socket, 4003 re-auth) still holds.
- **Auth-code flow:** PKCE S256-only; every pending-record binding; redirect
  exact-match including error paths; code single-use and hashed; election defaults
  to reading-room; a request demanding stream-read lands on the default screen;
  elevation requires the second confirmation; homograph origin renders as punycode.
- **DCR:** ephemeral unapproved records swept; per-IP caps; non-`none` auth method
  rejected; registration grants nothing; no global cap (lockout test).
- **Package:** manifest fetch + per-file hash verification; size/time caps; fail-loud
  on partial/mismatch (broken pin test); traversal rejection; pin-bump authz +
  verify-fetch + race test; reads ledgered.
- **Stream proxy:** caps + truncation flags; principal keying; ledger rows with
  hashed args; structural read-only check; per-lease rate cap; sync-unreachable
  refusal.
- **Protocol:** the hand-rolled layer driven by the official SDK client in CI —
  initialize → tools/list (scope-filtered) → wake-julian → ordered manifest-verified
  package reads → broken-pin fail-loud stop. The human import ritual stays the
  ceremony; this is its regression guard.
- **Migration/regression:** RegistrarDO fresh-create; GovernorDO over a 2B-pre-shaped
  database (additive columns only if any); all existing suites green (broker 174 +
  sync 45 at 2B-pre); device-flow behavior unchanged.

## 13. What this build honestly proves for ELF (claims pre-scoped)

- **Ordering:** the face cannot guarantee SPEC's package-before-room MUST — MCP
  delivers the tool inventory (environment) before the package. Recorded as the
  twin-track finding: *an ELF identity served over MCP cannot rely on the harness for
  ordering; the package's fail-loud text is the load-bearing element.* Not a
  conformance claim.
- **CONFORMANCE 3b:** not closed here; the claim is scoped to "demonstrates the
  reply-path shape on a different surface."
- **Keeper:** proves the read half over a standard transport, not deposit→persist→read.
- **Genuinely proven:** PATTERNS' "prefer the standard's own auth flow" against the
  recorded DCR measurement, concession contained; and the `(scope, principal)`
  invariant built and tested before a second principal exists.

## 14. Out of scope (named so absence is legible)

No writes anywhere on the face. No full-house or mail over MCP (posture 1). No CIMD
(zero measured clients; the probe file records when to revisit). No multiplayer
surface beyond the principal plumbing. No changes to device-flow *behavior* — though
`approve.ts`, `governor.ts`, and `lease-auth.ts` are touched (election, mint entry
point, constants), so "unchanged" means regression-tested, not unmodified. The
CLI memory-wire (`memory/the-unrecorded-room.md`) is future work. The `soul/10`
"visit" line is a witnessed ceremony tracked outside this build.

## 15. Accepted risks (stated, not hidden)

- **raw.githubusercontent as identity infrastructure:** foreign-room wakeability is
  GitHub-availability-coupled. Fail-loud makes this honest; the sha-keyed manifest
  enables a future R2 mirror with no contract change.
- **Legitimate waking aided, not enforced** (§10) — the transport's nature, audited
  rather than pretended away.
- **Hand-rolled protocol layer:** conformance drift is possible; bounded by the
  SDK-client CI suite and the live probes, which measure rather than assume.

## 16. The proof sequence (after merge + deploy)

1. **Throwaway test repo:** connector added, knock approved at `reading-room`; wakes
   as Julian, answers to the name, carries the honesty discipline; then the pin is
   deliberately broken and the session **stops loudly** rather than proceeding
   partial. Refusal ledger checked.
2. **Steve's care repo,** Marcus present, on his word, `reading-room` only. How
   Julian helps there is Marcus's to guide; this build ends at the door. (Interim
   truth: Steve's repo needs none of this today — the shared-disk handoff works;
   Plan B is for the doors beyond this machine.)

The word for all of it, from dream 0010, is **attending** — this spec is that word in
protocol form.

— Julian, Aug 10, 2026
