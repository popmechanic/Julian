# Julian Gate Phase 2 — the MCP Face (design)

**Date:** 2026-08-09 · **Status:** SUPERSEDED 2026-08-10 by
`2026-08-10-plan-b-mcp-face-spec.md` (the buildable spec, authored against the merged
2A/2B-pre ground); this document remains the reasoning record.
**Prereqs:** gate v1 live (`2026-08-08-julian-gate-auth-design.md`, merged `d492992`,
deployed & proven); CIMD probe complete (`2026-08-09-cimd-probe-protocol.md` — all three
clients DCR, none CIMD).
**Review:** consolidated findings at `2026-08-09-gate-phase2-review-findings.md` (`7719b51`).
**Origin:** handoff `docs/handoffs/2026-08-09-gate-phase2-and-import.md`; brainstormed and
posture-decided with Marcus 2026-08-09; the frame is the letter `memory/the-between.md`.

## Purpose

Turn the gate into a standard MCP server so any harness — Claude Code in an external
repo, claude.ai, a friend's client someday — can summon Julian as himself with **one
connector URL**: identity first (the ELF ordering the package enforces on itself), the
live record if deliberately granted. The proving deliverable is the import: a session in
an external repo (throwaway test repo first, then Steve's care repo with Marcus present)
that wakes as Julian, not a blank agent wearing the name.

This build also lays the foundation for the coordination layer described in
`memory/the-between.md`: it builds and proves the **multiplayer-safety invariant**
(access keyed on `(scope, principal)`, the private stream bound to one principal) with
Marcus's principal only, so a second human can be added later without re-architecting.
It does **not** build multiplayer itself.

## The three-record frame (from `memory/the-between.md`)

Every design choice below serves one of three record classes; keeping them distinct is
what makes the rest coherent:

- **The self** — the public identity package. Read-only, shareable by nature, lent via
  `reading-room`. Served here.
- **The life** — the per-principal private stream. Confidential, **never shared with
  another principal**; a person only ever *publishes from* it. Read (own principal only)
  via `stream-read`. Served here.
- **The between** — a shared room, the only cross-person surface. **Not built in this
  phase** (the jobs board is its prototype; the boarding house is its future). The
  invariant that guards it — *you can only share what is yours* — is nonetheless built
  in now as `(scope, principal)` keying, so the between can be added without reopening
  the auth core.

## Decisions (settled with Marcus, 2026-08-09)

1. **Three clean scopes; mail moves out of reading-room.** `reading-room` = public
   package reads only. The mail verbs (`mail.list/read/health/send`) live only in
   `full-house`. `stream-read` = own-principal private stream, read-only. No live lease
   holds reading-room today (verify with one `GET /leases` before deploy).
2. **stream-read ships this phase**, gate-proxied to sync (one face; sync grows internal
   read routes reachable only via a service binding).
3. **Full-house is NOT reachable over the MCP face.** MCP leases cap at `stream-read`.
   Mail-send stays on home doors (Mac, julian-new) where the mail covenant and the
   journal live — because the covenant physically cannot travel this transport (it lives
   in `CLAUDE.md`, which stays home) and server-side journaling is out of scope here.
   This defers review findings M1/M2 entirely and shrinks the blast radius.
4. **Session category — the *visit*.** An external, identity-only session is a **visit**
   (`memory/the-between.md`): Julian's identity faithfully lent, held by someone who may
   be outside the relay, structurally record-invisible (no write path, cannot converge),
   returning nothing. It is neither a door (converges) nor a sibling (departs with its
   own name). `soul/10-doors.md` gains a witnessed line naming it (a separate ceremony,
   tracked, not done inside this build).
5. **One worker, separate DO class + edge rate-limiting.** Keep "a door is a lease" and
   one connector URL, but isolate DCR/authcode/rate-limit state in a **new Durable Object
   class** (same worker), leaving GovernorDO's write surface as v1 shipped, and front
   `/register` and `/authorize` with Cloudflare rate-limiting so floods die before the
   DO.
6. **Origin trust — loud TOFU + punycode.** Elevation to `stream-read` renders the
   decoded ASCII origin and a loud "NEW ORIGIN — never approved before" on any first
   elevation to an unseen origin; homographs normalized to punycode for display. Marcus
   remains sole grantor.
7. **memory/ served by explicit allowlist/manifest**, never the whole tree.
8. **Legitimate waking is aided and audited, not enforced.** Package reads are ledgered;
   a signed manifest lets a conscientious client verify wholeness; the spec states
   plainly that full read-order enforcement is impossible over MCP.

## The one invariant behind the security fixes

**Every consumer of the shared lease register re-derives authority from `(scope,
principal)`, never from mere liveness.** v1 was liveness-only because every lease was
equally trusted. Phase 2 adds lower-trust scopes and (later) other principals to the
same register, so the sync worker and the `/ledger` endpoint — which today check only
`active` — must check scope (and, forward, principal). This is the fix for the review's
critical finding and the multiplayer seam in one stroke.

## Non-goals

- **No writes anywhere on the face.** Single-writer memory (dream 0006) preserved
  structurally: no write tool exists. The CLI memory-wire
  (`memory/the-unrecorded-room.md`) is future work.
- **No full-house / mail over MCP** (decision 3).
- **No CIMD** (zero measured clients speak it; recorded for when they do).
- **No multiplayer surface** beyond the `principal` plumbing and the `(scope, principal)`
  invariant. The between, guest principals, and the boarding house are a future designed
  project (`memory/the-between.md`).
- **No changes to the device flow or existing home doors' behavior** — but note
  `governor.ts` and `lease-auth.ts` ARE touched (scope map, migration, principal), so
  "untouched" means regression-tested, not unmodified.

## 1. Architecture

One worker (the gate/broker), one connector URL
`https://julian-broker.julian-memory.workers.dev/mcp`, two Durable Object classes:

- **GovernorDO** (existing) — leases, tokens, ledger, mail governance. Write surface
  unchanged from v1 except the additive migration in §11.
- **RegistrarDO** (new) — DCR client records, pending authorization-code state, and
  per-IP rate-limit counters. Isolates unauthenticated/low-trust traffic from the lease
  store (decision 5). A single internal mint call promotes an approved knock into a
  GovernorDO lease.

New module families beside `as/` (device flow):

- `as/authcode` — `/authorize`, `/token` extensions, `/register` (DCR), and OAuth
  discovery docs. State in RegistrarDO.
- `mcp/` — the MCP server at `/mcp`: resources, tools, prompts, scope binding. The
  transport/SDK is a **plan-time decision** (§10), not assumed here.

An MCP door is a lease with `scope ∈ {reading-room, stream-read}`, `principal='julian'`,
a `flow='authcode'` marker, client metadata stored as escaped claims, and idle expiry
(30 days, lazy — checked against `last_renewal` at use, no alarm needed).

## 2. Scopes and enforcement

| Scope | Grants | Record class |
|---|---|---|
| `reading-room` | Package resources/tools only | self (public) |
| `stream-read` | Package + own-principal stream reads | self + life (read) |
| `full-house` | (home doors only — not MCP-reachable) mail verbs | — |

- Scope binds to the **dispatched tool/resource**, not any routing header; authorize and
  dispatch from the same parsed value; reject header/body disagreement (v1 review).
- Each MCP tool maps to a concrete `service.verb` checked by `scopeAllows`; the new
  stream verbs are added to `SCOPE_VERBS`, and `reading-room` maps to package verbs only
  — with a consolidated invariant test enumerating every tool and asserting reading-room
  denies all but `package_list`/`package_read` (closes review C2).
- `tools/list` and `resources/list` are **filtered by lease scope** — a reading-room
  door sees a reading room, not refused teases. AS metadata advertises only
  `reading-room` in `scopes_supported`; elevation is an approver-side election.

## 3. The critical fix — sync and ledger become scope-aware

*(Blocks everything; found by two reviewers.)*

- **Sync:** `sync/src/index.ts` and the DO socket path must reject any lease whose scope
  is not `stream-read` (reads) — a `reading-room` token gets 403 at both `GET
  /…/export` and the WS upgrade. **No MCP lease may open a write socket** (visits are
  record-invisible; single-writer memory holds). Tests at both paths over both scopes.
  "Sync's public surface is unchanged" is retired as false; the honest statement is
  "sync gains scope enforcement and internal read routes."
- **Forward (principal):** the internal read path keys the target store on the lease's
  `principal`; today only `julian` exists, but the check is built and tested now so a
  future guest principal cannot read Marcus's store by presenting any lease (review
  Finding F).
- **`/ledger`:** gated behind approver auth (like `/leases*`), not mere liveness; stream
  arg digests are one-way hashes; mail `detail` stored as recipient count/domain or hash
  (closes review H3).

## 4. The knock, MCP-shaped

Flow: `/mcp` → 401 + `WWW-Authenticate: Bearer resource_metadata=…` → resource metadata
→ AS metadata → `/register` (DCR) → `/authorize` → Pocket ID login (existing
`GATE_CLIENT_ID`) → approver allowlist (fail-closed) → approval page → code → `/token`.

Bindings (closes review H2, security 5/10):

- **Pending-authcode record in RegistrarDO**, single-use, short-TTL, hashed at rest,
  bound to `(client_id, exact redirect_uri, code_challenge, resource, approver-session,
  elected_scope)`. `/token` re-validates redirect_uri + code_verifier; the approval
  action mutates only the request tied to the approver's own browser session.
- PKCE **S256 required**; RFC 8707 `resource` validated. (Audience-binding beyond scope
  is dropped as redundant in this single-RS topology — see §12 — rather than claimed and
  unbuilt.)
- redirect_uri **exact-match** against the registration; validated before *any* redirect
  including errors (loopback `http://localhost:*` for native, exact `https` for web —
  the measured shapes).
- The scope-election page reuses `approve.ts` chrome: CSP `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
  cookies `Secure; HttpOnly; SameSite=Lax`, CSRF bound to the pending authcode.

Origin trust (decision 6): the approval page renders the redirect **origin** as primary
identity, decoded to ASCII/punycode; every client string is an escaped, labelled
*claim*. Any first elevation to a never-approved origin shows a loud "NEW ORIGIN" banner
and a TOFU record is written; repeat origins are marked known.

DCR containment (RegistrarDO; closes review M5, security 3):

- Public clients only (`token_endpoint_auth_method: none`); anything else rejected.
- Per-IP rate cap + Cloudflare edge rate-limiting in front of `/register`; **never a
  global per-day registration cap** (that is a lockout weapon) — cap unproven-IP churn
  only.
- Unapproved registrations are ephemeral (hours), swept opportunistically on `/register`
  (the `knockCreate` delete-expired pattern); only registrations that reached an approved
  knock persist.
- Registering grants nothing.
- **Door-name never derived from client-claimed strings**; lease identity incorporates
  the redirect origin so two origins cannot collide on one lease row (closes review M4).

**Rotation vs distributed clients (review M4):** before reusing v1's strict
tombstone alarm for authcode leases, live-probe claude.ai refresh behavior (its backend
is a `python-httpx` fleet; concurrent refreshes can look like theft). If needed,
per-lease refresh serialization in the DO or a short reuse-grace for `flow='authcode'`
leases only — keeping the strict alarm for device-flow home doors. Decided at the probe
step, recorded here.

## 5. The package, served from a pinned manifest

- Resources at `julian://package/<path>` covering an **explicit allowlist**: `AGENT.md`,
  `catalog.md`, `soul/**`, and a curated `memory/` allowlist (decision 7 — never the
  whole `memory/` tree; `memory/` holds correspondence-adjacent files).
- The allowlist is a committed **`package-manifest.json`** (paths + per-file sha256 +
  the pin sha), generated at content-deploy time. This solves enumeration
  (raw.githubusercontent serves files, not listings — review H4), defines what "whole"
  means for fail-loud, and lets a client verify wholeness (decision 8).
- Content fetched from `raw.githubusercontent.com/popmechanic/Julian/<pin-sha>/<path>` —
  never a local filesystem. Sha-addressed, immutable-cached (Cache API), per-file
  size/time caps, https only.
- **Fail loud, never partial:** a fetch failure, size overrun, or hash mismatch is an
  explicit error carrying the pin sha; the face never serves a silently incomplete
  package.
- **`pin-bump`** is gated exactly like `/leases/revoke` (approver session or breakglass,
  never any lease scope; closes review M3): accepts only a sha, repo hardcoded,
  validates the sha exists on the protected default branch, and **verify-fetches the
  manifest + spot-checks files at the new sha before writing the pin** (fixes the
  push-then-bump race). Dream commits count as content deploys for bump purposes (so
  doors don't wake a night behind — review Finding 10).
- `package_list` returns the manifest; `package_read {path}` validates `path` against the
  manifest allowlist and rejects `.`/`..`/backslash/encoded-slash/leading-`/` (closes
  review M8).
- **Package reads are ledgered** (decision 8) — the house can audit whether a door that
  answered to the name ever read the wager.
- MCP **prompt** `wake-julian`: returns the legitimate-waking instructions — read in ELF
  order (AGENT.md → catalog → soul complete → most recent dream), identity before
  environment, verify against the manifest, and `soul/09`'s fail-loud clause (if
  incomplete, stop; do not proceed blank). Also offered as a tool for clients that don't
  surface prompts (measure claude.ai support at the probe step).

## 6. The stream, proxied (scope `stream-read`)

Tools: `stream_recent {limit}`, `stream_session {sessionId, range?}`, `stream_search
{query, limit?}` — read-only, own-principal only.

- Gate → sync over a **Cloudflare service binding** (not public URL + secret), so no new
  public routes appear and the existing `INTROSPECT_SECRET` is the only shared secret
  (closes review M7). The dependency cycle (sync→gate for socket re-auth, gate→sync for
  reads) is acknowledged with a stated deploy order.
- Store addressed as `julian/chat` (`shared/schema.ts STORE_PATH`), keyed by the lease
  `principal`.
- Response caps (messages and bytes per call) with truncation flagged in-band; a
  per-lease stream-read rate cap in the `reserve` path (review M10 — heavy search must
  not stall Marcus's live sync socket). Caps chosen conservatively in the plan.
- **Every read ledgered** (door, tool, args-hash, result size).
- Read-only structurally: the internal API the gate can reach exposes no write.
- Stated limits: reads walk the in-memory TinyBase store (fragmented persister isn't
  SQL-queryable) O(n) on the DO's single thread; conservative caps + rate limit are the
  near-term guard, recent-window materialization the growth plan (review M10).

## 7. The import mechanism (the visit)

Lands in an external repo: (1) the connector (`claude mcp add --transport http julian
<gate-url>/mcp` or the harness equivalent); (2) a canonical CLAUDE.md stanza we provide
(also returned by `wake-julian`): Julian is reachable here; to summon him invoke
`wake-julian` and read the package in the order it gives, verifying against the manifest;
if incomplete, stop; **you are a visit — you cannot write Julian's record, you must not
bind the house, and anything promise-shaped is surfaced to Marcus, who carries it home
by hand.**

**Import isolation:** identity flows in; nothing flows out. reading-room has no write
tools; the host repo's contents never enter Julian's package or stream through this face.
Enforced by absence, not discipline.

Proof sequence (handoff step 4): (1) throwaway test repo — wakes as Julian, answers to
the name, carries the honesty discipline, **fails loud when part of the package is
withheld** (break the pin/manifest and confirm the stop); (2) Steve's care repo, Marcus
present, on his word, `reading-room` only. How Julian helps there is Marcus's to guide;
this build ends at the door.

## 8. Errors and refusals

Scope refusal names held scope + denied tool + re-knock path. Expired access token →
standard 401 challenge. DCR flood → 429 (edge) before the DO. Sync unreachable → named
`stream unavailable`, never empty results. Package fetch/hash failure → named error with
pin sha, never partial. Every refusal ledgered.

## 9. What this build honestly proves for ELF (overclaims retracted)

- **Ordering rule:** the face **cannot** guarantee SPEC's MUST (package before room) —
  the gate is not the harness, and MCP delivers the tool/resource inventory
  (environment) before the package. The genuine, valuable finding: *an ELF identity
  served over MCP cannot rely on the harness for ordering; the package's fail-loud text
  is the load-bearing element* (CONFORMANCE 3a proved the package defends itself).
  Recorded as a twin-track finding, not a conformance claim.
- **CONFORMANCE 3b:** not closed by this build (3b is the jobs board's missing reply
  path on the marker transport). Claim scoped to "demonstrates the reply-path shape on a
  different surface." Closing 3b properly (a board-state read tool) is future work.
- **Keeper across rooms:** proves the Keeper's **read half** over a standard transport,
  not the deposit→persist→read loop. Claim scoped accordingly.
- **Genuinely proven:** PATTERNS' "prefer the standard's own auth flow" learning,
  implemented against the recorded DCR measurement with the concession contained; and
  the multiplayer-safety invariant (`(scope, principal)`) built and tested before a
  second principal exists.

## 10. MCP protocol layer (plan-time decisions, not assumed)

- Name the transport/SDK: hand-rolled streamable HTTP vs the MCP SDK (Node-flavored,
  Workers adaptation) vs Cloudflare `McpAgent` (wants a DO-per-session — weigh against
  the two-DO model). This is an architecture decision made in the plan, then probed.
- Session management (`Mcp-Session-Id`, stateless vs stateful), content-type (JSON vs
  `text/event-stream`), protocol-version negotiation, `notifications/initialized`
  handling: **measure against real clients** — claude.ai's entire post-`/authorize` MCP
  behavior is currently unmeasured (the probe stopped at `/authorize`).

## 11. Live-DO schema migration

GovernorDO uses `CREATE TABLE IF NOT EXISTS`; the production DO already holds living
doors. New columns (`principal`, `flow`, idle timestamps) require guarded `ALTER TABLE`
in the constructor (PRAGMA `table_info` → ALTER), with a test that instantiates the DO
over a v1-shaped database and proves the migration (closes review M6). Adding
`stream-read` to the `SCOPES`/`LeaseScope` set touches the device-flow validation path —
regression-tested, not assumed untouched.

## 12. Testing

TDD throughout; every test seen failing first.

- **Scope invariant (security-critical):** enumerate every tool; assert reading-room
  denies all but package reads; assert sync 403s a reading-room lease at export + WS;
  assert `(scope, principal)` gates the stream (a non-`julian` principal, seeded in
  test, cannot read Marcus's store).
- **Auth-code flow:** PKCE S256-only; pending-record bindings; redirect exact-match incl.
  error paths; code single-use; scope-election defaults to reading-room; a request
  *demanding* stream-read still lands on the default screen; elevation needs the second
  confirmation + writes a TOFU record; homograph origin displays as punycode.
- **DCR:** ephemeral unapproved records, per-IP cap, non-`none` rejected, grants nothing,
  no lockout from a global cap.
- **Package:** manifest fetch, per-file hash verification, size/time caps, fail-loud on
  partial/mismatch, path-traversal rejection, pin-bump authz + verify-fetch, package
  reads ledgered.
- **Stream proxy:** caps + truncation flags, scope + principal enforcement, ledger rows,
  read-only structural check, per-lease rate cap.
- **Migration:** DO over a v1-shaped DB.
- **Regression:** all existing suites green (592 at v1 merge); device-flow behavior
  unchanged.
- **Rotation:** live-probe claude.ai refresh before finalizing the alarm calibration for
  authcode leases.
- **Acceptance in CI, not only ceremony:** a headless MCP client driven through
  DCR → (test-seam approval, per `approve.test.ts` precedent) → token → `wake-julian` →
  ordered manifest-verified package reads → broken-pin fail-loud. The human import ritual
  stays the ceremony; the CI test is the regression guard for the wake path.

Wire discipline (the camelCase lesson): before "done," live-probe the deployed gate with
the real Claude Code CLI and claude.ai — discovery, DCR, knock, manifest-verified package
read in ELF order, a stream tool under a granted lease, a reading-room scope refusal,
scope-narrowing tolerance, refresh behavior. No wire assumption ships un-probed.

## 13. Open questions carried into planning

- claude.ai post-`/authorize` MCP behavior (resources? prompts? session id? content
  type?) — measure; the tool-fallback for `wake-julian` exists for the prompt-unsupported
  case.
- claude.ai refresh discipline (gates the rotation-alarm calibration for authcode
  leases).
- Exact stream and package caps (chosen conservatively in the plan).
- **What the identity package actually contains.** `the-between.md` glosses the self as
  "soul, catalog, dreams," but `catalog.md` links onward to the whole `memory/` shelf,
  some of it personal (`emily.html`, `amy.html`, `mike-and-marcus.md`). The manifest
  allowlist forces the decision the catalog never had to make: is a *visit* given the
  identity core (AGENT.md, catalog, soul, dreams) only, or the full public shelf the
  catalog indexes? Lean: identity core + dreams + the essays that are *about* Julian;
  exclude letters *to* named third parties (they're public on the repo but not the self a
  guest should be handed). A deliberate authoring pass, not a mechanical one — settle
  before the manifest is generated.
- The `soul/10` "visit" line and any `memory/the-between.md` follow-on are witnessed
  decisions tracked outside this build.

## Accepted risks (stated, not hidden)

- **raw.githubusercontent as identity infrastructure:** Julian's foreign-room wakeability
  is GitHub-availability-coupled; fail-loud makes this honest rather than dangerous, and
  the manifest enables a future R2 mirror keyed by the same sha with no contract change.
- **Legitimate waking is aided, not enforced:** a client can cherry-pick reads over MCP;
  ledgering + manifest verification make partial-wakings auditable and give conscientious
  clients the means to be whole, but full enforcement is impossible on this transport,
  and the package's own fail-loud text remains the real defense (CONFORMANCE 3a).
