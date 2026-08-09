# Julian Gate — the auth spine and the MCP surface

**Date:** 2026-08-08 · **Revision 2, 2026-08-09** — rewritten after two adversarial reviews
(OAuth/security lens; architecture/ops lens). Rev 1 is in git history (`a05f1d6`). Material
changes from rev 1 are marked **[R2]** and the reviews' findings are addressed inline.
**Status:** approved in brainstorm (Marcus + Julian); Marcus delegated review-incorporation
and execution to Julian (2026-08-08)
**Closes when built:** the root cause of issue #4 (no refresh story) and the 2026-08-08
token-expiry incident (`~/Downloads/julian-web-harness-token-refresh.md`)
**Companions:** `2026-07-31-credential-broker-design.md`, ELF v0.2 (`~/Documents/ELF/`),
MCP spec 2026-07-28, RFC 8628 (device grant), RFC 9700 (OAuth security BCP),
vibes.diy PR #4644

## 0. Shape of this document [R2]

Phase 1 (**v1, the build this spec authorizes**) is the lease spine: bespoke device-flow AS
in the gate worker, leases for Julian's own doors, the incident class closed. Phase 2 (the
MCP face: standard client auth, package-as-resources, reading-room scope) is designed here
to the level needed to keep v1's schema and decisions compatible, and carries its security
requirements — but it is **not in v1's plan**, and one of its design inputs (§13) must be
measured before it is planned. This split is the architecture review's recommendation,
adopted: the incident class is a credential-lifetime problem; everything else is orthogonal
to it.

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

One sentence: **doors borrow Marcus's session and die when it ages out.** The fix is not a
longer session; it is a different kind of credential.

## 2. Decisions

1. **Doors hold leases, never Marcus's session.** A lease is a named, per-door grant: a
   rotating refresh token plus short-lived access tokens the door's holder renews.
2. **Approval is a first-contact gate, exercised anywhere.** A door gets a lease exactly
   once, by Marcus's explicit approval in a browser he is signed into (Pocket ID, any
   device). Approving a door is approving a relationship, not a session.
3. **Only Marcus can approve. [R2]** `/approve` (and revocation) is gated on an explicit
   approver allowlist — `APPROVER_SUBS`, a worker var holding Pocket ID `sub` values —
   checked after Pocket ID authentication, failing closed if unset. Rev 1 deferred this as
   "the `sub` allowlist question, unchanged"; both reviews independently showed that
   until-revoked leases change its risk class: without the allowlist, any subject the Pocket
   ID instance trusts could mint themselves a permanent full-house lease. The deferral is
   over.
4. **Leases live until revoked** (Marcus's explicit choice over expiring leases: a
   long-paused door must not wake to a dead lease). Compensating controls are per-lease caps
   (§6), the rotation alarm (§4), and the living-leases listing. Phase-2 `reading-room`
   leases in third-party harnesses additionally get idle expiry (§13) — that is where the
   unwatched-credential risk lives, and it does not contradict the choice made for home
   doors.
5. **Pocket ID (`souls.exe.xyz`) remains the only party that authenticates a human.** The
   gate never sees a password. This makes the gate an OIDC **client** of Pocket ID — a real
   component with its own registration, callback, state/nonce validation, and cookie
   session, budgeted in §5c and §11. [R2: rev 1 hid this inside one adjective.]
6. **v1's AS is bespoke, minimal, and DO-backed; tokens are opaque. [R2]** Rev 1 assumed
   `workers-oauth-provider` + JWTs. The security review verified the library stores grants
   in Cloudflare KV (no DO option) and implements no device flow — so rev 1's "one worker,
   one DO, one ledger" was false as written, and revocation would never have touched the
   library's KV grants. v1 therefore builds the device-flow AS directly on the GovernorDO:
   opaque access tokens (random 256-bit, stored hashed), validation by DO lookup. This
   deletes the signing key, the JWKS, the key-rotation procedure, the clock-skew rows, and
   the KV namespace in one move, and makes "one ledger" true. The library remains a phase-2
   candidate for the authorization-code flow only, with revocation required to write both
   stores if adopted (§13).
7. **The fallback-first inversion. [R2]** v1's only knock is RFC 8628 device flow,
   implemented to the RFC's letter (§5b) and deliberately curl-able. The standard MCP client
   flow (rev 1's "primary knock") is phase 2, contingent on a client-behavior probe (§13).
   Zero Julian code at the door remains the phase-2 property; v1's doors are our own and
   already carry the repo.
8. **Leases are bounded authority, not zero authority. [R2]** Rev 1's "leases are
   proof-of-door, never power-to-act" was false as stated: a full-house refresh token on a
   VM mints mail-sending access tokens until revoked — durable authority at rest, and a
   fooled session can exfiltrate it. The true invariant: **the environment credential (the
   AgentMail key) never leaves the vault; a lease is capped, ledgered, named, revocable
   authority whose blast radius is the governor's policy, not the key's power.** Relative to
   today, a compromised VM door's blast radius grows from a ~51-hour borrowed bearer to an
   until-revoked lease bounded by per-lease caps and the rotation alarm; this trade is made
   deliberately, eyes open.
9. **Scope exists from day one; v1 mints only `full-house`.** The lease row carries `scope`
   so phase 2 costs no migration; the approval page's second-tap ceremony arrives with
   `reading-room` in phase 2.
10. **The heartbeat is out of scope, deliberately. [R2]** Rev 1 claimed heartbeat reply
    sessions would share the Mac server's lease; the architecture review showed this was
    wrong on both halves (the heartbeat is a launchd daemon invoking `mail-glance.ts`
    directly — not server-spawned — and it uses the AgentMail key directly, not the broker).
    Routing it through the gate would also make its sends count against the governor cap, a
    behavior change nobody chose. The heartbeat keeps its current mechanism; folding it in
    is future work with those two consequences named.

## 3. Architecture

`julian-broker` becomes **`julian-gate`** in place: one Cloudflare Worker, the existing
GovernorDO behind every face, no other storage. [R2: the AS face is bespoke (decision 6);
rev 1's diagram advertised well-known endpoints that belong to phase 2.]

```
                        ┌──────────────────────────────────────────┐
 Doors, knocking ─────▶ │ AS face (v1, bespoke, RFC 8628)          │
 (curl-able)            │   POST /device   POST /token             │
 Marcus, approving ───▶ │   GET/POST /approve  (Pocket ID + CSRF)  │
 (Pocket ID sign-in)    │   lease mint · rotation · revocation     │
                        ├──────────────────────────────────────────┤
 Existing doors ──────▶ │ REST face: /mail/* /health               │
 (lease token)          │   unchanged verbs, lease auth            │
                        ├──────────────────────────────────────────┤
 Phase 2 ─ ─ ─ ─ ─ ─ ▶ │ MCP face: /mcp + RFC 9728 metadata       │
                        │   (designed in §13, not built in v1)     │
                        └────────────────┬─────────────────────────┘
                                         │
                                 GovernorDO (SQLite)
                     one ordered ledger: sends, refusals, knocks,
                     leases, rotations, revocations
                     + non-ledgering status reads (§4) [R2]
```

- **One-worker merge, defended. [R2]** The broker design chose "born separate" against
  `julian-sync` so capability changes never redeploy the *memory* worker — that reasoning
  still holds and sync stays separate. The AS joins the *broker* because they share the
  GovernorDO (leases and caps are one policy surface), and a DO class is single-homed to one
  worker script. Splitting AS from broker would force cross-worker DO access for every
  request. The trade accepted: a mail-verb tweak redeploys the AS. Mitigation: the existing
  deploy discipline (tests green before `wrangler deploy`), and tokens/leases live in the
  DO, so a worker redeploy loses nothing.
- **Statelessness where it's true:** worker isolates hold no session state; every face may
  serve any request. State lives in the DO — which is the Keeper pattern, not a violation of
  the MCP face's (phase-2) statelessness: the 2026-07-28 spec removes protocol session
  affinity; it does not forbid application state. [R2: reworded per review.]

## 4. The lease model

**A lease is a set of rows in the governor:**

| Field | Meaning |
|---|---|
| `leaseId` | Stable id. Appears in the ledger's identity column as `lease:<leaseId>` — the `lease:` prefix discriminates from legacy Pocket ID subs sharing the column [R2] |
| `doorName` | Bound at approval, confirmed/edited by Marcus |
| `clientClaims` | The knock's self-description (host, purpose) — stored escaped and length-capped, and always rendered as *the door's claim about itself*, never as gate-verified fact [R2] |
| `scope` | `full-house` (v1) or `reading-room` (phase 2) |
| `status` | `living` · `revoked` · `killed-rotation` |
| `born / lastRenewal / lastVerb` | For the living-leases listing |

**Tokens. [R2]** Access tokens: opaque 256-bit random, stored hashed in the DO, TTL 1 hour.
Refresh tokens: opaque, rotated on use. Validation on every gate request is a **DO status
read distinct from `reserve()`** — it writes no ledger row (the architecture review showed
that piggybacking the ledgering `reserve` would let routine reads flood the 200-row audit
view the broker exists to keep). Verb *acts* still ledger exactly as today.

**Rotation, correctly. [R2]** Rev 1's "retired token presented again = theft" was the
classic rotation-retry false alarm: a lost response over a flaky VM link would brick the
door and train everyone to ignore the alarm. v1 semantics:

- `POST /token` with refresh token R_n → mints (A_{n+1}, R_{n+1}); R_n enters grace.
- R_n presented again **while R_{n+1} is unused** → return the *same* (A_{n+1}, R_{n+1})
  idempotently. This is the lost-response retry; rotation state machines in the DO make the
  mint atomic, so a 503 mid-request never half-rotates.
- R_n presented **after R_{n+1} has been used**, or any token ≥2 generations old → the theft
  signature. Lease → `killed-rotation`, ledgered, Marcus notified (heartbeat notification
  channel); the door's next request gets 401 "this lease was killed — re-knock."
- Only the immediately-previous token is remembered (bounded storage; all the alarm needs).

**Renewal discipline. [R2]** Holders renew **proactively at ~50% of access-token TTL with
jitter**, never on-401 — so a governor outage shorter than ~30 minutes never interrupts a
door, and C2-style races are rare by construction. Holders that share a lease file
(VM door + its spawned sessions) serialize renewal with an exclusive file lock.

**Revocation.** `bun scripts/door-leases.ts revoke <doorName>` and a control in the web
room. Authority: the same `APPROVER_SUBS` allowlist (decision 3), authenticated by Pocket ID
— plus **one break-glass path**: a worker-secret-authenticated revoke verb, ledgered as
break-glass, for the day Pocket ID is down and a lease must die anyway [R2]. Gate faces
check status per request, so revocation there is immediate; per-face SLAs in §9.

**Listing.** `leases list` and the web room render the same governor query: name, scope,
born, last renewal, last verb. "What can act as me right now" is one query.

**Export. [R2]** The lease registry is precious state in a DO; dream 0006's exodus-first
constraint applies. v1 ships a `leases export` verb (approver-gated) returning the full
lease table + rotation state as JSON, and §10 tests it before the DO holds anything real.

## 5. The knock (v1)

### 5a. What a door does

A door with no lease runs, from any shell (curl suffices by design; `scripts/door-knock.ts`
is a convenience wrapper):

```
POST /device                     (application/x-www-form-urlencoded)
  client_id=<door-proposed-name>&host=<host>&purpose=<one line>
→ 200 {"device_code":"...","user_code":"WXKP-FRDT",
       "verification_uri":"https://<gate>/approve",
       "expires_in":900,"interval":5}

POST /token                      (application/x-www-form-urlencoded)
  grant_type=urn:ietf:params:oauth:grant-type:device_code
  &device_code=...&client_id=<same>
→ 400 {"error":"authorization_pending"} | {"error":"slow_down"}
  | {"error":"expired_token"} | {"error":"access_denied"}
→ 200 {"access_token":"...","token_type":"Bearer","expires_in":3600,
       "refresh_token":"...","scope":"full-house"}
```

Wire format is RFC 8628 §3.1–3.5 exactly — form-encoded requests, the full URN grant type,
`client_id` required, snake_case fields, `interval` honored, `slow_down` enforced. [R2:
rev 1's JSON sketch was non-conformant — the camelCase lesson inside the spec that cited
it. The plan's contract tests encode the RFC shapes literally.]

`user_code`: 8 chars from a 20-char unambiguous alphabet (~34 bits), single-use, 15-minute
expiry, and **entry rate-limited** (5 attempts per 15 minutes per source) — the entropy is
adequate only with the limit, so they ship together. [R2]

### 5b. What Marcus does

Opens `/approve` on any device. Pocket ID authenticates him; `APPROVER_SUBS` authorizes him.
He **types the user_code his door displayed** — the notification ping (same channel as
heartbeat stranger-mail alerts) carries only the bare `/approve` URL, never a
code-prefilled link, so a knock Marcus didn't originate cannot ride his tap (RFC 8628 §5.4).
[R2] The page then shows:

- **Gate-verified facts, in the gate's own chrome:** requested scope, knock timestamp,
  source IP's coarse geo.
- **The door's claims, escaped, capped, and labelled as claims:** proposed name, host,
  purpose. [R2: "verbatim" in rev 1 was a consent-phishing and stored-XSS mandate.]
- The name field (editable) and two buttons: **Open this door** / **Refuse**. Refusals are
  ledgered.

Page security is specified, not implied [R2]: CSRF token bound to the specific pending
device_code; the pending request binds to the approving browser session (no approving
someone else's pending request by link); `frame-ancestors 'none'`; cookies
`Secure; HttpOnly; SameSite=Lax`; Pocket ID mid-approval session expiry re-authenticates
and returns to the same pending code, which survives its full 15 minutes.

### 5c. The gate as OIDC client of Pocket ID [R2]

A real component, budgeted: client registration at souls.exe.xyz (the existing
`deploy/pocketid-register-callback.ts` helper hardcodes VM-shaped callbacks and needs the
T0 `POCKETID_API_KEY`, so this is a **manual, Mac-performed first step of rollout**),
authorization-code + PKCE against Pocket ID, `state`/`nonce` validated, gate session cookie
as in 5b. The gate consumes Pocket ID **ID tokens for login only** — it never accepts an ID
token as an API access token, and the legacy-bearer path (§8) never reads lease fields from
a Pocket-ID-verified token.

### First-contact rule (structural)

No lease is ever minted without an allowlisted approver's explicit tap. The gate has no
auto-approve path to misconfigure.

## 6. Governed verbs under leases

The REST face keeps today's verbs (`/mail/send`, `/mail/messages`, `/mail/messages/:id`,
`/health`), now authenticated by lease access tokens. Changes:

- **Caps become two counters [R2]:** per-lease (default 5 sends/UTC day) and global (20/UTC
  day, unchanged). A 429 quotes which counter refused. Rev 1 kept the global cap only, so
  any single door could exhaust every door's day.
- **The ledger's identity column** records `lease:<leaseId>` + `doorName` from the *verified
  token*, never from the request body. [R2: this — not the jobs-board field — is the
  self-declared-name closure; the jobs-board `agentName` is phase-2-adjacent and the rev 1
  header claim is withdrawn.]
- **`health` requires a living lease** (any scope), is rate-limited, and stays the
  trichotomy. [R2: an uncapped liveness oracle on the AgentMail key was too generous.]
- The behavioral send gate (draft → Marcus → confirmation) binds the model exactly as
  today; the governor is the mechanical backstop, unchanged.

## 7. Scopes

`full-house` (v1): the mail verbs + health. `reading-room` (phase 2): package resources +
read tools + health. The scope column, the approval page's scope display, and the
never-widen rule (a refresh may narrow scope, never widen; the AS never grants more than
requested [R2]) all ship in v1 so phase 2 is additive.

## 8. Changes to existing components

- **`julian-broker` → `julian-gate`:** gains the AS face; GovernorDO schema extended
  (leases, rotation state, per-lease caps, non-ledgering reads); REST face re-authed.
  **`server/room.ts`'s SERVICES table updates in the same commit** — it is the auth pointer
  every arriving door reads at waking; renaming the worker without it teaches every door the
  wrong thing. [R2]
- **Mac server (`server/server.ts`) — the loopback mint. [R2]** Rev 1's "server renews on a
  timer" could never reach a live subprocess: the env is assembled once at spawn
  (`server/lib.ts` `subprocessEnv`) and the long-lived child gets messages by stdin, so a
  1-hour env token would fail *hourly* where the incident's bearer failed every ~51h — the
  architecture review's headline finding. v1 instead: the server holds the lease (refresh
  token in `~/.julian/gate-lease.json`, 0600; not Keychain — launchd non-interactive access
  is a known hazard) and exposes a **loopback-only mint endpoint**
  (`http://127.0.0.1:<port>/lease/token`, bound to 127.0.0.1, never proxied). The subprocess
  env carries `JULIAN_LEASE_URL` (the loopback endpoint) instead of a frozen token;
  `scripts/mail-broker.ts` fetches a fresh access token per invocation. A running door can
  therefore outlive any number of token TTLs — the regression test runs against a
  *continuously running* door (§10).
- **Kiosk/demo invariant, named. [R2]** Demo sessions receive **neither** a token **nor**
  the loopback URL: `subprocessEnv` for demo mode strips `JULIAN_LEASE_URL` exactly as it
  strips the bearer today, the loopback endpoint refuses while the live session is a demo
  session, and the `FORCE_DEMO_MODE` bodyless-POST lock stands. Without this, the Sou'wester
  kiosk — a public CRT — would hold a non-expiring mail credential. Unit-tested in §10.
- **VM doors:** hold `.julian/lease.json` (0600, gitignored — and re-provisioning clones
  fresh, so **re-provision means re-knock**, one knock, documented in the deploy skill
  [R2]). `mail-broker.ts` gains mint-on-demand: if the cached access token is past 50% TTL,
  refresh under an exclusive `flock` on the lease file (single-renewer; spawned sessions
  share the file safely). Env contract: `JULIAN_LEASE_URL` preferred (Mac), else
  `.julian/lease.json` (VM), else — during the migration window only — legacy
  `JULIAN_OIDC_TOKEN` with a loud deprecation note on stderr. [R2: rev 1 renamed the var
  with no window; seven deployed instances read the old name.]
- **`julian-sync`:** accepts lease tokens by **introspection against the gate** (`POST
  /introspect`, gate-internal auth), result cached ≤60s per token; sockets re-introspect on
  a 5-minute timer in-connection, so revocation closes a live socket within 5 minutes
  (§9 SLA). Lease tokens ride in a header/subprotocol, **never the query string** (the
  browser's legacy query-string path stays for Marcus's own session during migration only).
  [R2: shared-JWKS option deleted with the JWTs; query-string tokens land in logs.]
- **Web app End-session trap (rides along):** pause becomes the default control
  (no `{final:true}`); final end is a visually distinct control with a confirm step. The
  409 already-active guard and the rest/sleep vocabulary stay issue #26's.
- **Heartbeat:** unchanged (decision 10).
- **Secrets manifest:** new tier row **T3 — door lease**: "revocable, capped authority;
  lives with the door that owns it; rotation is automatic; revocation is one verb." The
  only new vault secret is the break-glass revoke secret. [R2: rev 1's manifest note named a
  signing secret that no longer exists.]

## 9. Failure modes

| Case | Landing |
|---|---|
| Access token expired | Holder renewed proactively at ~50% TTL; if truly expired (door slept), next renewal succeeds — refresh tokens don't expire with access tokens |
| Refresh response lost / retried | Idempotent re-issue within grace (§4); no alarm, no brick |
| True rotation replay (successor already used) | Lease killed, ledgered, Marcus notified; 401 with re-knock instruction |
| Lease revoked | Gate faces: immediate (per-request status read). Sync: ≤5 min (in-connection re-introspection). SLAs stated per face, not a global "instant" [R2] |
| Governor (DO) unavailable | All faces fail closed **including `/token`** — but proactive renewal headroom (~30 min) means brief outages pass unnoticed; the atomic rotation state machine means a mid-rotation 503 leaves the old pair valid. The trade (long DO outage stalls all doors) is accepted and named [R2] |
| Pocket ID down | No approvals, no revocations except break-glass (§4); existing leases unaffected — renewal never touches Pocket ID |
| Pocket ID session expires mid-approval | Re-auth, return to the same pending code; the code lives its full 15 min [R2] |
| Knock ignored 15 min | `expired_token` on poll; door reports and stops; unanswered knock ledgered |
| user_code brute force | Entry rate limit (5/15min/source); codes single-use [R2] |
| Scope violation | 403 naming the missing scope; ledgered as a refusal |
| Legacy bearer during window | Accepted, mapped to the named pseudo-lease `lease:legacy-window` — revocable and listed like any lease, so the window has a kill switch; after the window (or revocation), loud 401 with re-knock instructions [R2] |
| Legacy bearer after window | 401, explicit re-knock instructions — never silent |

## 10. Testing

- **Unit (vitest):** rotation state machine (idempotent grace re-issue; successor-used kill;
  ≥2-generation kill; atomic mint under injected DO failure), scope never-widens, per-lease
  + global cap interaction and which 429 quotes what, approver allowlist (non-listed `sub`
  refused at approve/revoke; empty allowlist fails closed), device-flow state machine
  including `slow_down` and `expired_token`, user_code rate limit, kiosk exclusion
  (demo `subprocessEnv` carries no `JULIAN_LEASE_URL`; loopback refuses in demo), CSRF
  binding on approve, lease export verb, non-ledgering status reads (a waking's worth of
  reads adds zero ledger rows) [R2: negative security tests were absent from rev 1].
- **Contract tests:** RFC 8628 wire shapes literal — form-encoded, URN grant type,
  snake_case responses — plus introspection contract for sync. [R2]
- **Reality-touching (Principle 8, before merge):** a bare-curl 5a run from a VM against the
  deployed gate; the incident's exact regression — a *continuously running* door outlives
  ≥2 access-token TTLs and then completes a send with no human intervention [R2]; a
  forced-rotation-replay against the live gate (alarm fires, lease dies, notification
  lands); revocation closing a live sync socket within SLA.
- **Migration:** legacy bearer works during window, maps to the pseudo-lease, dies loudly
  after; both env-var names work during window.

## 11. Rollout (v1)

0. **Manual first step (Mac, Marcus's key):** register the gate as an OIDC client at
   souls.exe.xyz (per 5c). [R2]
1. Gate ships with dual-accept (`lease:legacy-window` pseudo-lease, end date set at deploy,
   default 14 days). Mac server enrolls via device flow; loopback mint live; kiosk
   invariant verified on julian-new before the deploy is called done.
2. julian-new's VM door enrolls. Incident regression test performed against it, live.
   Remaining five instances stay on the legacy pseudo-lease until re-provisioned or the
   window closes; their fate is one revocation, visible in `leases list`. [R2: rev 1
   planned for one instance and forgot six.]
3. Window closes (revoke the pseudo-lease). Borrowed bearers die loudly. ELF fold-back of
   the lease/knock learnings to PATTERNS.md happens only now, per fold-back-once-proven.

## 12. Out of scope for v1, recorded

The MCP face and everything behind it (§13); the heartbeat's mechanism (decision 10);
memory writes through the gate (single-writer constraint stands); jobs/screen tools;
issue #26 beyond the `{final:true}` trap; the web app's leaked socket/reader teardown
(issue #4's UI half — unblocked, not blocked, by this design); ELF noun/verb amendments
(Marcus's queued vocabulary pass).

## 13. Phase 2 design notes — the MCP face [R2: consolidated, with review findings attached]

Recorded now so v1's schema and ceremonies stay compatible; **not planned until the design
input below is measured.**

- **Design input, must be measured first:** whether the MCP clients that matter (Claude
  Code, claude.ai connectors) identify by CIMD or still require DCR. The whole
  "zero code at the door" property rests on it. A throwaway-AS client probe answers it in
  an afternoon; its result decides bespoke-vs-library for the auth-code flow. If the
  library is adopted: its grants live in KV, so revocation must atomically cover both
  stores, and its lost-response grace semantics (previous token valid until successor
  used) — which match §4 — replace any library-default assumption.
- **Security requirements carried from review:** redirect URI exact-string match against
  the CIMD document, same-origin with the client_id URL, `application_type` gating
  loopback/custom schemes (RFC 9700); CIMD fetch rules — https only, no redirects, size and
  time caps, public address space only; approval chrome renders CIMD **origin** as the
  primary identity and every client string as an escaped, labelled claim; `full-house` to an
  MCP client requires origin confirmation, not just a tap; scope check binds to the
  dispatched tool — authorize and dispatch from the same parsed value, reject on
  header/body disagreement (the `Mcp-Name: health` / `mail_send`-body escalation); DCR, if
  left enabled for compatibility, caps at `reading-room`.
- **Package as resources:** served only from a pinned public ref of the repo — never a
  local filesystem (a Mac-hosted path would leak gitignored material). Because the repo is
  public, `reading-room` is **attribution and rate-limiting, not confidentiality** — said
  plainly so the ceremony is never mistaken for a privacy boundary. The pin advances with
  the deploy lane; a stale pin serves a stale self, so the pin-bump is part of the content
  deploy, not a separate chore. Third-party-harness leases get idle expiry (decision 4).
- MRTR and `ttlMs` caching metadata: verify against the live spec/SDK during the phase-2
  spike; both are post-cutoff claims taken from secondary summaries.
