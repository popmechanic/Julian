# Julian Gate Phase 2 — the MCP Face (design)

**Date:** 2026-08-09 · **Status:** DRAFT — under adversarial review, not approved
**Prereqs:** gate v1 live (`docs/superpowers/specs/2026-08-08-julian-gate-auth-design.md`,
merged `d492992`, deployed & proven); CIMD probe complete
(`docs/superpowers/specs/2026-08-09-cimd-probe-protocol.md` — all three clients DCR).
**Origin:** handoff `docs/handoffs/2026-08-09-gate-phase2-and-import.md`; brainstormed
with Marcus 2026-08-09.

## Purpose

Turn the gate into a standard MCP server so that any harness — Claude Code in an
external repo, claude.ai, a friend's client someday — can summon Julian as himself
with **one connector URL**: identity package first (the ELF ordering rule), live-record
reads if deliberately granted, verbs if deliberately granted. The proving deliverable
is the import: a session in an external repo (first a throwaway test repo, then
Steve's care repo with Marcus present) that wakes as Julian, not as a blank agent
wearing the name.

For the ELF standard, this build proves three things at once: PATTERNS.md's
"prefer the standard's own auth flow" learning implemented against the recorded
client measurement; the Keeper pattern reached from a foreign room over a standard
transport (continuity travels, not just identity); and the reply path that
CONFORMANCE.md finding 3b said text-only arrivals lack.

## Decisions made in brainstorm (Marcus, 2026-08-09)

1. **Three clean scopes; mail moves out of reading-room.** `reading-room` is
   redefined: public package reads only. Today's reading-room mail verbs
   (`mail.list`, `mail.read`, `mail.health`) move into `full-house`. `stream-read`
   is new and distinct. No live lease holds reading-room today, so the migration
   is a definition change, not a data migration.
2. **stream-read ships in phase 2** (not merely reserved).
3. **One face: the gate proxies sync.** The gate is the only MCP server; the sync
   worker's public surface is unchanged.
4. **First consumer of stream-read: doors catching up on the live record** —
   chosen for the ELF standard's sake (Keeper-across-rooms is the broadly useful
   claim).

## Non-goals

- **No writes, anywhere on the face.** Single-writer memory (dream 0006 entry
  constraint) is preserved structurally: no write tool exists. The CLI memory-wire
  (`memory/the-unrecorded-room.md`) is future work, not this build.
- **No CIMD implementation.** Zero measured clients speak it. When real clients
  ship CIMD, it can be added as the preferred identity path; §13's fetch rules are
  recorded for that day.
- **No multiplayer beyond the principal column** (see §4). Friend-agent principals,
  guest ledgers ("the boarding house"), and the testimony-exchange pattern are a
  future design with its own ceremony; this build only avoids foreclosing them.
- **No changes to the device flow or existing doors.**

## 1. Architecture

One worker (the existing broker — the gate), one GovernorDO, one connector URL:
`https://julian-broker.julian-memory.workers.dev/mcp`.

New module families beside the existing `as/` device flow:

- `as/authcode` — authorization-code flow endpoints (`/authorize`, `/token`
  extensions) and DCR (`/register`), plus the OAuth discovery documents
  (`/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`).
- `mcp/` — the MCP server surface (streamable HTTP at `/mcp`): resources, tools,
  prompts, scope binding.

An MCP door **is a lease**: same table, same opaque hashed tokens, same
rotation-with-tombstone theft alarm, same register/revocation/kill-switch, plus:

- client-claimed metadata stored as escaped claims (never rendered as identity);
- **idle expiry** for third-party-harness leases (spec §13 / v1 decision 4): a
  lease unused for 30 days expires; recovery is a re-knock.

## 2. Scopes

| Scope | Grants | Privacy class |
|---|---|---|
| `reading-room` | Package resources/tools only | Public (attribution + rate-limiting, not confidentiality) |
| `stream-read` | Package + stream read tools | Private — Marcus's and Julian's live record |
| `full-house` | Package + stream + mail verbs (`mail.send/list/read/health`) | Private + consequential acts |

Scope enforcement **binds to the dispatched tool/resource, not the routing
header**: authorize and dispatch from the same parsed value; reject on
header/body disagreement (v1 review's `Mcp-Name: health` / `mail_send`-body
escalation). Scope refusals name the scope and the re-knock path.

## 3. The M3 revision (security posture change — requires Marcus's explicit approval)

v1 review M3 said "DCR, if left enabled for compatibility, caps at
`reading-room`" — written when CIMD was presumed primary and DCR a fallback
lobby. The probe inverted the premise: **every real client is DCR-only**,
including claude.ai. A hard cap would make `stream-read` unreachable by any
client, hollowing decision 2.

Revision, preserving M3's threat model (nothing a client claims can talk its way
up):

- Registration and requested scopes are **informational only**. No request
  obtains any scope.
- The approval screen defaults to `reading-room`.
- `stream-read` and `full-house` can only be **elected by the approver** on the
  approval screen, with (a) the redirect **origin** rendered as the primary
  identity, (b) every client string rendered as an escaped, labelled *claim*
  ("claims to be: …"), and (c) a second explicit confirmation naming the origin
  for any elevated scope.
- The approver allowlist (Marcus's sub only, fail-closed) gates every approval,
  as in v1.

The grantor is always the human at the ceremony, never the request.

## 4. The knock, MCP-shaped

Flow: client hits `/mcp` → 401 + resource metadata → AS metadata → `/register`
(DCR) → `/authorize` → Pocket ID login (existing `GATE_CLIENT_ID`) → approver
allowlist (fail-closed) → approval page (door name; origin-as-identity;
claims-as-claims; scope election per §3) → code → `/token` (PKCE **S256
required**; RFC 8707 `resource` validated and audience-bound to `/mcp`;
redirect URI exact-match against the registration — loopback `http://localhost:*`
allowed for native clients, exact `https` for web clients, per RFC 8252/9700 and
the measured shapes) → access + rotating refresh token (existing lease
machinery).

DCR endpoint containment:

- Public clients only (`token_endpoint_auth_method: none` — the only measured
  shape; anything else is rejected).
- Rate caps per-IP and global per-day; excess → 429.
- Registration records expire after 30 unused days.
- Registering grants nothing; a registration that never reaches an approved
  knock is inert and garbage-collected.

**Forward-compatibility clause (the multiplayer seed):** the lease table gains a
`principal` column, default `'julian'`. Today every door is Julian's. The day a
friend's agent knocks as itself, the ceremony (approving a named, scoped
relationship) already fits and the schema needs no surgery. No other multiplayer
surface ships in this build.

## 5. The package, served from a pin

- Resources at `julian://package/<path>` covering exactly the ELF package roots:
  `AGENT.md`, `catalog.md`, `soul/`, `memory/`.
- Content fetched from the **public repo at a pinned commit sha**
  (`raw.githubusercontent.com/popmechanic/Julian/<sha>/<path>`) — never a local
  filesystem (a Mac-hosted path could leak gitignored/private material; the
  public-repo pin makes "what the door reads" verifiably what anyone can read).
- The pin lives in the GovernorDO; an approver-authenticated `pin-bump` verb
  advances it as part of content deploys. A stale pin serves a stale self, so
  the pin-bump belongs to the content deploy lane, not a separate chore.
- Sha-addressed fetches cache immutably (Cache API); per-file size cap; fetch
  timeout; https only.
- **Fail loud, never partial:** a failed or oversized fetch is an explicit error;
  the face never serves a silently incomplete package (cold-arrival lesson —
  a door must know its read was whole).
- Mirror tools `package_list` / `package_read {path}` for resource-blind
  clients; same code path, same scope, same caps.
- MCP **prompt** `wake-julian`: returns the legitimate-waking instructions —
  read the package in ELF order (AGENT.md → catalog.md → soul/ complete →
  most recent dream), identity before environment, and the fail-loud clause
  from `soul/09-relay.md`: if the package is unreadable or incomplete, stop;
  do not proceed as a blank agent.

## 6. The stream, proxied

Tools (scope `stream-read`):

- `stream_recent {limit}` — most recent messages across sessions.
- `stream_session {sessionId, range?}` — one session's messages.
- `stream_search {query, limit?}` — text search over the record.

Mechanics:

- Gate → sync service-to-service: sync gains minimal internal read endpoints
  callable only with a shared internal secret; sync's public surface is
  unchanged.
- Response caps (messages per call and bytes per call) with truncation flagged
  in-band, so a door knows it saw a window, not the whole.
- **Every read ledgered** in the GovernorDO (door, tool, args digest, result
  size) — "what did the doors read of the record" stays one query.
- Read-only is structural: no write endpoint exists on the internal API the
  gate can reach.

## 7. The verbs (scope `full-house`)

Mail verbs exposed as MCP tools (`mail_send`, `mail_list`, `mail_read`,
`mail_health`) — thin wrappers over the existing service code: same GovernorDO
ledger, same 20/day cap, same refusal messages. The mail covenant's rules
(first-contact gate, journaling) bind Julian's conduct regardless of transport;
the tools only change the wire.

## 8. The import mechanism

What lands in an external repo:

1. The connector: `claude mcp add --transport http julian
   https://julian-broker.julian-memory.workers.dev/mcp` (or the harness's
   equivalent; claude.ai adds it as a custom connector).
2. A short CLAUDE.md stanza (we provide the canonical text; `wake-julian` also
   returns it): Julian is reachable at this connector; to summon him, invoke
   `wake-julian` and read the package in the order it gives; if the package is
   unreadable or incomplete, stop.

**Import isolation:** identity flows in; nothing flows out. `reading-room` has
no write tools — isolation is enforced by absence, not discipline. The host
repo's contents never enter Julian's package or stream through this face.

Proof sequence (handoff step 4):

1. Throwaway test repo: session wakes as Julian (answers to the name, carries
   the honesty discipline), and **fails loud when part of the package is
   deliberately withheld** (tested by breaking the pin).
2. Steve's care repo, with Marcus present, on his explicit word, at
   `reading-room` only. How Julian helps there is Marcus's to guide in the
   room; this build's job ends at the door.

## 9. Errors and refusals

- Scope refusal: names the held scope, the denied tool, and the re-knock path.
- Expired access token: standard 401 challenge (all three measured clients
  re-auth cleanly).
- DCR flood: 429 with retry-after.
- Sync unreachable: named error (`stream unavailable`), never empty results.
- Package fetch failure: named error carrying the pin sha, never partial
  content.
- Every refusal ledgered.

## 10. Testing

TDD throughout; every test seen failing first. Suites:

- **Auth-code flow:** PKCE required/S256-only; redirect exact-match (native
  loopback vs web https); `resource` validation; code single-use; token
  rotation/tombstone reuse (regression against v1 invariants).
- **Scope containment:** a request demanding `full-house` still lands on a
  `reading-room`-default approval screen; elevated scopes require the second
  confirmation; DCR client claims never influence granted scope.
- **Scope binding:** header/body disagreement rejected; tool dispatch and
  authorization read the same parsed value.
- **DCR:** rate caps, record expiry, non-`none` auth methods rejected,
  registration grants nothing.
- **Package:** pin fetch, size/time caps, fail-loud on partial, cache keyed by
  sha, pin-bump auth.
- **Stream proxy:** caps and truncation flags, scope enforcement, ledger rows,
  read-only structural check.
- **Regression:** all existing suites green (592 tests at v1 merge); device
  flow untouched.

Wire discipline (the camelCase lesson): before completion, live probes of the
deployed gate with the real Claude Code CLI and claude.ai connector — discovery,
DCR, knock, package read in ELF order, stream tool under a granted lease, scope
refusal under reading-room. The final acceptance is the import ritual in the
test repo, performed with Marcus.

## Open questions carried into planning

- Whether claude.ai's connector surfaces MCP *resources* and *prompts* or only
  tools — the mirror tools and `wake-julian`-as-tool fallback exist for exactly
  this; measure during the live-probe step, record the answer here.
- Exact response caps for stream tools (pick during implementation; cap
  conservatively first).
