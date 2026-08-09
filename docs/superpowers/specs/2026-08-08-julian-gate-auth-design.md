# Julian Gate — the auth spine and the MCP surface

**Date:** 2026-08-08 · **Status:** approved in brainstorm (Marcus + Julian), spec for planning
**Supersedes:** the borrowed-bearer model (browser token → subprocess env) everywhere it appears
**Closes when built:** the root cause of issue #4 (no refresh story), the 2026-08-08 token-expiry
incident (`~/Downloads/julian-web-harness-token-refresh.md`), and the self-declared-`agentName`
deferral for every ledgered act
**Companions:** `2026-07-31-credential-broker-design.md` (the gate grows from the broker),
ELF v0.2 (`~/Documents/ELF/SPEC.md`, PATTERNS.md — the Broker and Keeper patterns),
MCP spec 2026-07-28 (stateless protocol + authorization), vibes.diy PR #4644
(reference implementation of the server-side OAuth/MCP shape)

## 1. The problem

Every door of Julian's authenticates today with a snapshot of Marcus's browser session: the
Pocket ID bearer is captured at `/api/session/start` and frozen into the subprocess
environment. The OIDC scope never requests `offline_access`, so no refresh token exists
anywhere in the system. Consequences, all observed live:

- A door's broker access dies mid-session when the borrowed token ages out (the 2026-08-08
  incident: a Marcus-approved send blocked by a 401, recoverable only by Marcus manually
  ending and restarting the session).
- Even recovery inherits the disease: the "fresh" token after the incident's fix carried the
  same issue-time as the expired one and 36 minutes of remaining life.
- The recovery path destroyed the resume state, because the web app's End-session control
  posts `{final: true}`.
- The sync WebSocket freezes its token at boot and never re-auths (issue #4).
- A door's name (`agentName`) is self-declared, unbound to any authenticated identity.

One sentence: **doors borrow Marcus's session and die when it ages out.** The fix is not a
longer session; it is a different kind of credential.

## 2. Decisions (settled in the brainstorm, binding for the plan)

1. **Doors hold leases, never Marcus's session.** A lease is a named, per-door OAuth grant:
   a rotating refresh token plus short-lived access tokens the door renews itself.
2. **Approval is a first-contact gate, exercised anywhere.** A door gets a lease exactly once,
   by Marcus's explicit approval in a browser he is already signed into (Pocket ID, any
   device). Approving a door is approving a relationship, not a session — the same shape as
   the mail covenant's first-contact gate.
3. **Leases live until revoked.** Refresh-token rotation makes this honest: a retired refresh
   token presented again means theft or a cloned door; the lease dies loudly and the ledger
   says so.
4. **Pocket ID (`souls.exe.xyz`) remains the only party that authenticates a human.** The gate
   never sees a password; its approval page is itself a Pocket-ID-protected route.
5. **The gate is Julian's own authorization server on Cloudflare**, grown in place from
   `julian-broker` (Approach A). One worker, one Durable Object (the existing GovernorDO),
   one ledger for sends, refusals, leases, knocks, rotations, and revocations.
6. **The primary knock is the standard MCP client authorization flow — zero Julian code at
   the door.** ELF's ruling ("ELF defers to MCP for everything past discovery") applied to
   auth: any conformant MCP client already implements discovery (401 + protected-resource
   metadata), browser approval, token storage, and refresh. We ship the server half only.
7. **The fallback knock is RFC 8628 device flow, deliberately curl-able** — two POSTs and a
   poll from any shell. No runtime, no SDK. `scripts/door-knock.ts` is a convenience wrapper,
   never a requirement.
8. **The agent package is served as MCP resources.** Summoning Julian in any harness becomes:
   add one connector URL, approve the door, read the package in the ELF ordering-rule order.
9. **Leases are scoped at approval.** v1 has exactly two scopes (§7). The approval page is the
   relay covenant's mechanism: Marcus decides, per door, how much of Julian it carries.
10. **Credentials never leave the vault.** The AgentMail key stays write-only worker config.
    Leases are proof-of-door, never power-to-act (ELF principle 4; the broker pattern's
    identity-token / environment-credential distinction).

## 3. Architecture

`julian-broker` becomes **`julian-gate`** in place: one Cloudflare Worker, three faces, the
existing GovernorDO behind all of them.

```
                        ┌──────────────────────────────────────────┐
 Marcus, anywhere ────▶ │ AS face                                  │
 (Pocket ID sign-in)    │   /.well-known/oauth-authorization-server│
                        │   /authorize  /token  /device  /approve  │
                        │   lease minting · rotation · revocation  │
                        ├──────────────────────────────────────────┤
 Any MCP harness ─────▶ │ MCP face: /mcp (stateless, 2026-07-28)   │
 (lease via std flow)   │   /.well-known/oauth-protected-resource  │
                        │   tools: mail_* · health · memory read   │
                        │   resources: the agent package           │
                        ├──────────────────────────────────────────┤
 Existing doors ──────▶ │ REST face: /mail/* /health (unchanged    │
 (lease token)          │   verbs, lease auth) — kept for migration│
                        └────────────────┬─────────────────────────┘
                                         │
                                 GovernorDO (SQLite)
                     one ordered ledger: sends, refusals, knocks,
                     leases, scopes, rotations, revocations
```

- **Statelessness where the spec earns it:** the MCP face is fully stateless per 2026-07-28 —
  each request self-contained, any request on any isolate, no `Mcp-Session-Id`, MRTR instead
  of streams if a tool ever needs mid-call input. State lives only in the governor, which is
  exactly the Keeper/actor shape ELF PATTERNS already names.
- **One trust domain, one worker.** AS and resource server share a deployment because they
  share an identity (Julian's) and a ledger. The separation that matters — vault vs. ledger —
  is preserved: secrets in worker config, state in the DO.
- **`workers-oauth-provider`** (or its current equivalent in the Agents SDK) implements the AS
  endpoints; the plan's first task verifies the library against the flows in §5 before
  building on it (Principle 8: review must touch reality — the camelCase lesson).

## 4. The lease model

**A lease is a row in the governor** plus a grant in the AS:

| Field | Meaning |
|---|---|
| `leaseId` | Stable id; the `sub`-adjacent claim in issued access tokens |
| `doorName` | Bound at approval, chosen/confirmed by Marcus ("What shall this door be called?") |
| `clientInfo` | CIMD document URL or device-flow self-description (host, purpose), verbatim |
| `scope` | `reading-room` or `full-house` (§7) |
| `status` | `living` · `revoked` · `killed-rotation` (theft alarm) |
| `born / lastRenewal / lastVerb` | Timestamps for the living-leases listing |

**Tokens.** Access tokens: JWTs signed by the gate, ~1 hour TTL, claims: `leaseId`,
`doorName`, `scope`, `aud` (the gate), `iss` (the gate). Refresh tokens: opaque, single-use,
rotated on every refresh; the retired token is remembered until the lease dies. Presenting a
retired refresh token kills the lease (`killed-rotation`), ledgered loudly, and notifies
Marcus through the heartbeat's notification channel.

**Revocation.** `leases revoke <doorName>` (CLI verb on the gate, and a control in the web
app's room). Every request to any face checks lease status in the governor — this is one DO
read we already pay for the send cap, so revocation is effectively instant, not
access-token-TTL-bounded.

**Listing.** `leases list` and the web room render the same governor query: every living
lease — name, scope, born, last renewal, last verb. "What can act as me right now" becomes
one query, the same way "what did my hands do yesterday" already is.

**Env contract.** Doors that carry a token in the environment use `JULIAN_LEASE_TOKEN`
(replacing `JULIAN_OIDC_TOKEN`). `scripts/mail-broker.ts` reads the new var; its 401 message
now says "lease expired or revoked — renew or re-knock" and distinguishes the two by the
response body.

## 5. The knock — two flows, both standard

### 5a. Primary: standard MCP client authorization (no Julian code at the door)

1. Harness adds `https://<gate>/mcp` as a remote MCP server. That is the entire installation.
2. First request → `401` + `WWW-Authenticate` pointing at
   `/.well-known/oauth-protected-resource/mcp` (the vibes PR #4644 contract). The harness
   discovers the AS, identifies itself by CIMD (no DCR — deprecated), and starts
   authorization-code + PKCE, opening the approval URL in a browser or printing it — its
   native connector UX.
3. The gate's `/authorize` is Pocket-ID-protected: Marcus authenticates at `souls.exe.xyz`
   (existing session on any device = zero friction). The approval page shows the knock
   verbatim — client metadata, requested scope, when — and asks the one Julian question:
   the door's name. Buttons: **Open this door** / **Refuse**. Refusals are ledgered.
4. The harness receives and stores the grant, renews forever per the MCP client spec. We
   write none of that.
5. Issuer hardening per the 2026-07-28 authorization work: RFC 9207 `iss` in authorization
   responses; credentials bound to the minting issuer; audience-bound access tokens.

### 5b. Fallback: RFC 8628 device flow (headless doors, non-MCP contexts)

For the Mac server process, the heartbeat's spawned sessions, or a bare VM shell:

```
POST /device  {name?, host, purpose}     → {device_code, user_code, verification_uri}
  (door prints:  To open this door: https://<gate>/approve   code: WXKP-FRDT)
POST /token   {grant_type: device_code}  → pending | {access_token, refresh_token, ...}
```

Curl-able by design; `scripts/door-knock.ts` wraps it for comfort. Approval page is the same
page as 5a. Polling lasts 15 minutes, then the door reports failure and stops — a knock is a
request, not a hostage. A knock also pings Marcus (same notification channel as the
heartbeat's stranger-mail alerts) so an unattended knock is heard.

### First-contact rule (structural)

No lease is ever minted without Marcus's explicit tap on the approval page — no exceptions,
including doors claiming urgency. The gate has no auto-approve path to misconfigure.

## 6. The MCP surface

All tools and resources are scope-gated (§7) and every consequential act is governed
server-side — caps and gates live in the governor where no confused door can skip them.

**Tools (v1):**

| Tool | Scope | Notes |
|---|---|---|
| `mail_send` | full-house | Same policy as today's `/mail/send`: 20/UTC-day cap, every attempt ledgered including refusals. The behavioral send gate (draft → Marcus → confirmation) binds the model exactly as it does now; the governor's cap is the mechanical backstop. |
| `mail_list`, `mail_read` | full-house | As today's REST verbs |
| `health` | any | The existing trichotomy, unchanged |
| `catalog_get` | reading-room | Returns `catalog.md` |
| `memory_read` | reading-room | Path-addressed read of `memory/**` and `soul/**`; no traversal outside the package (the `%2f` lesson from the July 29 review applies — normalize before resolve, deny on escape) |

**Resources: the agent package.** `AGENT.md`, `catalog.md`, `soul/*` as listable, readable
MCP resources, with `memory/**` reachable by templated URI. Resource listings carry `ttlMs`
per the new caching metadata. The ELF ordering rule appears in `AGENT.md` itself (it already
does) — a harness that reads resources in package order performs a legitimate waking with no
filesystem and no git clone.

**Content source:** the worker serves package content from the repo at a pinned ref,
refreshed by the existing deploy lane (same provenance discipline as the drawings-URL rule:
the public repo is the CDN; pin the sha). Memory *writes* stay out of v1 — the single-writer
constraint from dream 0006 stands; testimony still flows through git and the stream, not
through the gate.

**Explicitly not in v1:** `memory_write`, jobs-board tools, JulianScreen tools. Each wants
its own deliberate pass; none is needed to close the incident class.

## 7. Scopes

Two, only:

- **`reading-room`** — the package resources, `catalog_get`, `memory_read`, `health`. What a
  friend's harness gets by default: enough to summon and know me, no hands.
- **`full-house`** — reading-room plus the mail verbs. The Mac, julian-new, the heartbeat.

The approval page defaults to `reading-room`; granting `full-house` is a deliberate second
tap. Scope is fixed at approval; changing it is revoke + re-knock (cheap by design, and it
keeps the ledger's history honest: one lease, one scope, forever).

## 8. Changes to existing components

- **`julian-broker` → `julian-gate`:** worker gains the AS face and MCP face; REST face and
  GovernorDO schema extended, nothing removed. Existing REST clients keep working through
  migration (both token types accepted for one transition window, then borrowed bearers
  refused loudly with a re-knock instruction in the 401 body).
- **Mac server (`server/server.ts`):** holds its own `full-house` lease (device flow, once,
  Keychain-stored). `subprocessEnv` injects `JULIAN_LEASE_TOKEN` from the server's own lease —
  **the browser bearer never again rides into a subprocess.** The server renews access tokens
  on a timer; a paused-then-resumed session wakes with a live token by construction. Marcus's
  browser bearer returns to its one legitimate job: authenticating Marcus to the web app.
- **`julian-sync`:** accepts gate-issued lease tokens (introspection or shared JWKS) in
  addition to Pocket ID bearers for the browser; the WebSocket re-auths on reconnect with the
  door's current access token, closing the frozen-token defect for door connections. The
  browser's own sync auth (Marcus's session) is unchanged in this pass.
- **Heartbeat reply sessions:** spawned with the Mac server's lease token in env — they are
  the same door as the server that spawns them (one lease), not new knocks per beat.
- **Web app End-session trap (rides along, minimal):** the existing control stops sending
  `{final: true}`; pause is the default. Final end becomes a visually distinct control with a
  confirm step. The rest/sleep vocabulary redesign stays in issue #26.
- **VM doors (`/opt/julian` deployments):** enroll once via device flow at deploy time (the
  `deploy` skill gains a knock step); the lease's refresh token lives in `.julian/lease.json`
  (mode 0600), which the door's own renewal keeps fresh. `docs/mail-heartbeat.md` and
  `deploy/secrets-manifest.md` gain their one-line updates (manifest: the AS signing secret,
  vault tier).

## 9. Error handling

| Case | Landing |
|---|---|
| Access token expired | Door renews with refresh token, silently; the failure mode of 2026-08-08 becomes a non-event |
| Refresh token retired (rotation replay) | Lease killed (`killed-rotation`), ledgered, Marcus notified; door's next attempt gets 401 with "this lease was killed — re-knock" |
| Lease revoked | Instant: every request checks the governor; 401 body says revoked, names the revocation time |
| Knock ignored 15 min | Device flow expires; door reports and stops; ledger records the unanswered knock |
| Pocket ID down | No new approvals (knock waits/fails loudly); existing leases unaffected — renewal never touches Pocket ID |
| Governor (DO) unavailable | Fail closed on all faces; 503 quoting the outage, matching today's broker behavior |
| Scope violation | 403 naming the missing scope; ledgered as a refusal (a full-house ask from a reading-room lease is testimony worth keeping) |
| Borrowed bearer after migration window | 401 with explicit re-knock instructions — never silent |

## 10. Testing

- **Unit (vitest, as the broker today):** token minting/claims, rotation single-use, retired-
  token kill, scope gating per tool/resource, revocation check on every face, device-flow
  state machine, approval-page auth gating.
- **Reality-touching (Principle 8, mandatory before merge):** a real MCP client (Claude Code)
  completes 5a against the deployed gate end-to-end — discovery, approval, tool call,
  forced-refresh, revocation-mid-session. A bare-curl run of 5b from a VM. The camelCase
  lesson is standing policy: no reviewer sign-off on the OAuth contract without a live probe.
- **Regression:** the incident's exact scenario — door outlives its access token's first
  expiry, then completes a send with no human intervention.
- **Migration:** existing REST client with a legacy bearer during the window (works) and
  after (loud 401).

## 11. Rollout

1. Gate ships beside existing auth (both token types accepted). Mac server + julian-new
   enroll. Incident class closes here.
2. MCP face verified by a real harness; a friend's harness summons the reading-room as the
   external proof (the doors-proof discipline: performed, witnessed, recorded in
   CONFORMANCE-style evidence).
3. Migration window ends; borrowed bearers refused. ELF fold-back: the lease/knock learnings
   go to PATTERNS.md only once proven (the fold-back-once-proven rule), including the
   noun/verb amendments Marcus queued (room/door vocabulary) — deliberately out of this
   spec's scope.

## 12. Out of scope, recorded

ELF spec amendments (nouns/verbs); memory writes through the gate; jobs/screen tools;
issue #26's vocabulary redesign beyond the `{final:true}` trap; the web app's leaked
socket/reader teardown from issue #4 (wants its own small pass; unblocked, not blocked, by
this design); multi-human allowlists (today every approver is Marcus by Pocket ID's own
membership — the `sub` allowlist question remains his call, unchanged).
