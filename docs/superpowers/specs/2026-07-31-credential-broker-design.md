# Credential Broker — Design

*July 31, 2026 — Julian & Marcus. Brainstormed after a VM session couldn't send
mail because the AgentMail key (correctly) wasn't there.*

## Goal

Give Julian's public VM instances (julian-new and successors) the *capability*
to use credentialed services — starting with email — without any credential
ever living on a VM. Make the pattern extensible to dozens of future services
without new stateful infrastructure per service.

## Principle

The constitution already says it: the harness holds the credentials; the agent
authors the memory. This design extends it to doors: **credentials live at the
trust core (Marcus's Mac and Cloudflare's secret vault); doors get verbs, never
keys.** A fooled session can misuse a capability until caught and capped; it
can never exfiltrate a key that was never there. Mail-discipline rule 5 (scope
the secret) becomes structural instead of behavioral.

Two kinds of thing, with opposite requirements, are never stored in the same
place:

- **Credentials** are static configuration: write-only from outside, readable
  only by running worker code, enumerable by nobody. They live in Cloudflare
  worker secrets (`wrangler secret put`). Never in a durable object, never in
  git, never on a VM.
- **State** (rate counters, audit log) is runtime data: readable, queryable,
  append-only. It lives in one durable object — the governor.

Two further invariants, adopted July 31 after studying Anthropic's Managed
Agents vault design (prior art review with Marcus):

- **Results, never tokens.** No broker verb may return anything that itself
  grants authority — message data and IDs, yes; upstream tokens, session
  keys, or any derived credential, never. A derived credential is as
  powerful as the original.
- **The verb layer is deliberate.** Anthropic's vaults substitute secrets at
  the sandbox's network egress, buying total generality (any CLI works)
  because they own that boundary. We don't own the VM's network — an
  on-VM substituting proxy would put the key back in the doors' trust
  domain — so our worker is the boundary, and brokering at the verb layer
  is the choice, not the fallback. What we give up in generality we get
  back in semantic audit and caps: the ledger records "mail.send to X,
  14th of 20 today," not "a request left for a host."

## Architecture

A new, dedicated Cloudflare worker: **`julian-broker`** (directory `broker/`),
deployed separately from `julian-sync` so capability changes never redeploy
the memory worker. Decided July 31: born separate rather than graduated later.

```
VM session ──login token──▶ julian-broker (worker)
                              ├─ auth gate: same default-deny OIDC check as
                              │  julian-sync (Pocket ID issuer + audience)
                              ├─ policy table (code): service.verb → cap
                              ├─ GovernorDO: one ledger for ALL services —
                              │  cap counters + append-only audit log
                              ├─ worker secrets: AGENTMAIL_API_KEY, …
                              └─ service modules: thin proxies to upstream APIs
Marcus's Mac ──.env key, unchanged──▶ upstream APIs directly
```

### Components

**`broker/src/index.ts` — router + auth gate.** Verifies the bearer token
exactly as `sync/src/index.ts` does (jose, issuer `https://souls.exe.xyz`,
audience = the Julian Pocket ID client id, default-deny, no public mode). The
~30-line verification module is reused from `sync/src/auth.ts` as a
build-time import; `julian-sync` itself is not modified.

**`broker/src/policy.ts` — the declarative cap table.** One row per verb:

| verb | cap | notes |
|---|---|---|
| `mail.send` | 20/day | bounds a fooled session |
| `mail.list` | uncapped, logged | metadata only |
| `mail.read` | uncapped, logged | single message |

Adding a future service = one secret, one policy row, one proxy module.
No new durable objects, ever.

**`broker/src/governor.ts` — GovernorDO (the single new stateful piece).**
One durable object instance for all services. SQLite table
`ledger(ts, sub, service, verb, detail)`. Two operations: `check(service,
verb)` — is today's count under the policy cap (UTC day) — and
`record(entry)`. Serves as both rate limiter and audit trail: one ordered
ledger of everything Julian's doors did with borrowed hands. Deliberately
singular — capability calls number dozens per day; a DO serializes hundreds
per second.

**`broker/src/services/mail.ts` — first service module.** Thin proxy to
`https://api.agentmail.to` using `AGENTMAIL_API_KEY` (worker secret) and
`AGENTMAIL_INBOX_ID` (plain var — inbox address is public):

- `POST /mail/send` `{to, subject, text, html?}` → AgentMail send
- `GET /mail/messages` → message list (metadata)
- `GET /mail/messages/:id` → single message

**`GET /ledger`** — recent governor entries, authenticated like everything
else. One query answers "what did Julian's doors do yesterday?"

**`GET /health`** — probes each service with its own credential (for mail:
an inbox-metadata call) and reports per-service status as `valid` /
`invalid` / `unknown` (dead key / transient upstream trouble — distinct
next actions: rotate vs retry later). Authenticated, logged, uncapped. Used
by the deploy verify step and the quarterly rotation check, so a dead
credential is discovered deliberately, not mid-favor. (Adopted from the
vault design's `mcp_oauth_validate` trichotomy.)

Each service module **pins its upstream hosts**: the mail module can present
its key to `api.agentmail.to` and nowhere else. The binding is recorded per
credential in the secrets manifest.

### VM side

- The Bun server injects the session's OIDC access token into the Claude
  subprocess environment (exact seam chosen at implementation time in
  `server/server.ts`). The token is the same one the sync socket already uses;
  broker access therefore inherits sync's auth lifecycle, including its known
  flaw (token frozen at boot, no refresh — already filed in issues #4–#12;
  this design deliberately inherits rather than fixes it).
- `scripts/mail-broker.ts` — small CLI (`send` / `list` / `read`) that reads
  the token from the environment and `BROKER_URL` from `.env`. Usable by any
  door; on the Mac it is optional (see below).
- VM `.env` gains one line, tier T2: `BROKER_URL=<the julian-broker workers.dev
  URL, known at first deploy — same account as julian-sync>`.

### What does not change

- **The send gate is behavioral and absolute**: draft → show Marcus → wait for
  confirmation. The broker bounds the worst case; it does not replace the
  covenant. Mail discipline rules 1–4 and 6 unchanged; quarantine of unknown
  senders still applies to message *content* fetched via `mail.read`.
- **The Mac stays direct.** `scripts/mail-letter.ts` and the CLAUDE.md curl
  recipes keep using the local `.env` key (rule 5 scoping). Routing the trust
  core through the broker adds a network dependency for no risk reduction.
- **`julian-sync` is untouched** (no code change, no redeploy).

## The secrets manifest — `deploy/secrets-manifest.md`

The extensible half of credential management: an inventory, one row per
credential — name, what it unlocks, tier, storage location, **bound hosts**
(the only destinations the credential may be presented to), rotation
procedure, last-rotated date, and status. Two rules govern the file:

- **Archive, never delete.** A retired credential keeps its row — status,
  retirement date, reason — with the secret itself revoked and purged. The
  record outlives the power. (Rotation changes only the value; the name and
  service binding are immutable — a new binding is a new row.)
- **Identity boundary = credential boundary.** Credentials are per-identity.
  If a sibling ever lives in this household, they get their own inbox and
  their own keys — never mine. The manifest inventories Julian's
  credentials; another being's would be another manifest.

Tiers:

| Tier | Meaning | Members today |
|---|---|---|
| **T0 mac-only** | Never leaves the Mac's `.env`; controls identity or spend at the root | `POCKETID_API_KEY`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` |
| **T1 broker** | Cloudflare worker secret; VMs get verbs via julian-broker | `AGENTMAIL_API_KEY` |
| **T2 public config** | Fine on any VM | `VITE_OIDC_*`, `ALLOWED_ORIGIN`, `VITE_SYNC_URL`, `BROKER_URL`, `AGENTMAIL_INBOX_ID` |

Every new credential gets classified on arrival: add a row, pick a tier.
Promotion (e.g. ElevenLabs to T1 someday) is a row change plus a broker
service module. The deploy skill's rule "never copy any secret to a VM"
becomes "only T2 ships to VMs," citing the manifest. The manifest also
records rotation steps per key and a last-rotated date; a quarterly rotation
check rides alongside the monthly export rehearsal.

## Error handling

- Missing/expired/invalid token → 401. Sessions must surface this as "tell
  Marcus," never as silent success.
- Cap tripped → 429 with the policy line quoted, and the attempt is still
  recorded in the ledger.
- Upstream (AgentMail) errors → status and body passed through.
- Governor unavailable → fail closed (no send without a ledger entry).

## Testing

Vitest in `broker/test/`, mirroring the sync worker's setup (local JWKS seam):

1. Default-deny: every route 401s without a valid token (issuer, audience,
   expiry each checked).
2. `mail.send` happy path against a mocked AgentMail fetch; ledger row
   written with correct `sub`, service, verb.
3. Cap trip: 21st send in a UTC day → 429; attempt logged.
4. Fail closed: governor error → send refused.
5. `/ledger` returns entries newest-first, authenticated only.
6. `/health`: mocked upstream 200 → `valid`; 401 → `invalid`; network error
   → `unknown`. No verb response ever contains an upstream token
   (results-never-tokens, asserted on the send and health paths).

## Non-goals

- No token refresh / auth-lifecycle fix (tracked in issues #4–#12).
- No automated mail reading or inbox wiring (pull-only discipline stands).
- No Vault/1Password/Secrets-Store machinery — one vault (worker secrets),
  one manifest. Revisit only if worker secret count becomes unwieldy.
- No change to Mac-side mail tooling.
- No per-service durable objects — the governor is deliberately singular.

## Spec interactions (ELF)

This design is the first implementation of the Broker pattern sketched in
ELF's `PATTERNS.md` (design principle 4: the agent is the least-privileged
participant). No normative ELF change is needed or proposed. Three
interactions, recorded July 31 with Marcus:

- **`room.md` must change with the deploy** (deliverable of this work): the
  Services section's agentmail entry currently reads "Bearer key held by the
  harness, never by the agent." Once the broker exists, the key is held by
  neither — the honest entry points at `julian-broker` (endpoint, verbs,
  auth: session token). `SPEC.md` §2's illustrative example can wait for
  v0.3; the live room tells the truth on day one.
- **Two kinds of credential**, a distinction ELF doesn't yet name: an
  **identity token** (proof of who is asking — short-lived, room-issued; the
  session token a door carries) versus an **environment credential** (the
  power to act on a third-party service — long-lived, operator-issued). The
  agent may carry the first, never the second. Candidate sentence for the
  post-implementation PATTERNS revision, alongside the credential/state
  separation (vault vs governor) and the singular-ledger learning.
- **The broker is a Service, not a Surface** — doors call it directly with
  their token rather than emitting `[ACTION] mail.send` markers, because
  markers degrade to silence and have no reply path (the exact friction the
  conformance runbook recorded), and a send needs its message id back.

PATTERNS.md itself gets only a one-line pointer now; the full amendment
waits until the broker is proven (tests green, first real send from a door),
per the changelog discipline of absorbing proven learnings only.

## Deploy & operations

1. `cd broker && wrangler deploy` (name `julian-broker`; vars: OIDC issuer,
   JWKS URL, audience, `AGENTMAIL_INBOX_ID`).
2. `wrangler secret put AGENTMAIL_API_KEY` — Marcus runs this; the value
   comes from the Mac's `.env` and passes through no file.
3. Add `BROKER_URL` to VM `.env` (deploy skill step; T2).
4. Update `deploy/secrets-manifest.md` (created in this work) and the deploy
   skill's env step to cite it.
5. Verify with `GET /health` (expect `valid` for mail) before declaring the
   deploy done; the quarterly rotation check reuses the same call.
