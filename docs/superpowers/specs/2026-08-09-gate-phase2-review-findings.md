# Phase 2 MCP Face — consolidated adversarial review

**Date:** 2026-08-09 · **Reviews:** four independent hostile lenses (OAuth/token
security, privacy/isolation, identity/ELF integrity, architecture/ops/testability),
each grounded in the actual v1 code (`broker/src/`, `sync/src/`), not just the design
prose. Target: `2026-08-09-gate-phase2-mcp-face-design.md` at commit `fa9925c`.

**Verdict:** the design's auth *posture* (M3 revision, DCR containment, opaque tokens,
escaped claims) is well-grounded in the probe and survives review. Everything the
probe did **not** reach — post-`/authorize` claude.ai behavior, the MCP protocol layer,
and every place the new low-trust scopes touch state the v1 build already holds live —
is where the design breaks. Two reviewers independently found the same critical hole.
The design needs substantial revision before it becomes a plan; several revisions are
Marcus's decision, not mine.

Severity legend: **CRITICAL** (ships a hole / defeats the hard constraint), **BLOCK**
(won't build as written), **PROD** (will fail in production/abuse), **COVENANT**
(needs a witnessed decision), **HARDEN/NIT**.

---

## The one root cause behind the worst findings

**Every consumer of the shared lease register must re-derive authority from `scope`
(and later `principal`), not from mere liveness.** When v1 shipped, every lease was
equally trusted (all full-house mail), so checking "is this lease alive?" was
sufficient everywhere. Phase 2 pours `reading-room` and `stream-read` leases into the
**same** register that the sync worker and the `/ledger` endpoint already read
**without checking scope**. That single unstated assumption produces findings C1, C2,
and H3 below.

---

## CRITICAL

### C1 — Sync accepts any living lease for read AND read-write sync; scope containment is void
*(privacy Finding A + architecture Finding 1 — the same hole, found twice, CONFIRMED in code)*

`sync/src/index.ts:36–52` gates on `introspectLease(...).active` only; the `scope`
field is returned by the gate and **discarded**. Because "an MCP door is a lease, same
table" (design §1) and "sync's public surface is unchanged" (decision 3), a
`reading-room` token minted for Steve's repo can be presented **directly to sync**,
bypassing the gate entirely:
- `GET /julian/store/export` → returns the whole private stream (one GET; the URL is
  published in the repo, so it's not obscure).
- `wss://…/julian/chat` → a bidirectional CRDT sync socket that can **write** into the
  record — breaking single-writer memory (dream 0006) structurally, not hypothetically.

The gate's §6 stream-read scope gate is irrelevant because the attacker never goes
through the gate. **This defeats the entire hard constraint** (external repo gets
identity only). *Fix:* sync must check scope at both the HTTP and WS paths (accept only
`stream-read`/`full-house` for reads, and — see the door-category decision — decide
whether ANY MCP lease may open a write socket). "Sync's surface unchanged" is already
false and must be revised honestly. Until this ships with a test, phase 2 must mint no
reading-room/stream lease.

### C2 — reading-room grants mail verbs *today*; the whole import safety is one dictionary edit
*(privacy Finding C, CONFIRMED)*

`broker/src/lease-auth.ts:38–41` currently maps `reading-room → [mail.list, mail.read,
mail.health]`, and §3 makes reading-room the **default** approval scope. If the
decision-1 migration is missed or partial, the default-scope door Steve gets can read
Marcus's inbox. *Fix:* ship the `SCOPE_VERBS` change with a security-critical
regression test asserting reading-room grants **zero** mail/stream verbs — one
consolidated test enumerating every tool and asserting reading-room denies all but
`package_list`/`package_read`.

---

## HIGH

### H1 — Elevated scope collapses to Marcus eyeballing an attacker-controlled origin (homograph)
*(security Finding 1, CONFIRMED gap)*

DCR is unauthenticated and automatic. An attacker registers `client_name:"Claude"` with
a lookalike redirect (`clаude.ai` Cyrillic, or `claude.ai.evil.io`) and social-engineers
Marcus into electing `stream-read`/`full-house`. §3's only real-identity signal is the
rendered origin, which a homograph defeats. No allowlist, no trust-on-first-use, no
punycode normalization. Blast radius is maximal (whole private record / autonomous
mail). *Direction (Marcus's call — see Decision 3):* origin allowlist, or a loud TOFU
ledger ("NEW ORIGIN — never approved before") + punycode/ASCII display, possibly
out-of-band confirmation for a first elevation to a new origin.

### H2 — The authorization-code flow's pending-state bindings are unspecified
*(security Finding 2, PLAUSIBLE — the schema is device-shaped)*

v1 carefully binds the device flow (CSRF↔device_code, scope written by `knockDecide`).
Phase 2 adds `/authorize` + code redemption but the `knocks` table has no columns for
`code_challenge`/`redirect_uri`/`resource`/`elected_scope`/authcode. Without explicit
binding of (code ↔ client_id ↔ exact redirect_uri ↔ code_challenge ↔ approver-session ↔
elected scope), a code issued at reading-room could be redeemed as full-house, or
Marcus's approval could attach to an attacker's pending request. *Fix:* specify the
pending-authcode table and every binding; `/token` re-validates redirect_uri and
verifier; approval mutates only the request tied to the approver's own session.

### H3 — `/ledger` has no scope check; a reading-room door harvests every door's ledger
*(privacy Finding B, CONFIRMED)*

`broker/src/index.ts:140–147`: `/ledger` runs after `authenticate` (liveness only) with
no `scopeAllows`/`reserve`. `detail` rows carry plaintext mail recipients + subjects and
will carry stream-search args. A reading-room door reads who Marcus emailed and what
other doors searched for. *Fix:* gate `/ledger` behind approver auth (like `/leases*`);
make stream-read arg digests one-way hashes; store mail `detail` as recipient
count/domain or hash.

### H4 — `package_list` is unbuildable from raw.githubusercontent; no enumeration mechanism
*(architecture Finding 2, CONFIRMED)*

raw serves files, not directory listings — `soul/` and `memory/` can't be enumerated,
and `resources/list` needs the full roster on every call. GitHub Trees API is 60 req/hr
per shared Worker egress IP (stranger-exhaustible) or needs a new GitHub token secret
the design never mentions. "Fail loud, never partial" needs to know what *whole* means,
which only a manifest provides. *Fix:* commit a `package-manifest.json` at
content-deploy time (fetched by sha like any file); `pin-bump` verify-fetches the
manifest + spot-checks files at the new sha before writing the pin (also fixes the
push-then-bump race).

### H5 — The MCP protocol layer is unspecified and untested; claude.ai post-auth is zero-measured
*(architecture Finding 3, CONFIRMED — and my §9 "re-auth cleanly" is an overclaim)*

The design never names how `/mcp` is implemented (hand-rolled streamable HTTP vs the
Node MCP SDK vs Cloudflare's `McpAgent`, which wants its own DO-per-session — colliding
with "one DO"). §10 has no MCP-protocol suite. The probe recorded claude.ai only through
`/authorize` (no token, no initialize, no tools/list) — its content-types, session-id
handling, notifications, and resources/prompts support are **unmeasured**. §9's "all
three measured clients re-auth cleanly" is unsupported (the probe never expired a token).
*Fix:* name the SDK/transport as a plan decision; add a protocol-level suite driving a
real MCP client in CI; treat claude.ai post-auth as an unanswered probe question; demote
the re-auth claim.

---

## MEDIUM

### M1 — The mail covenant cannot travel this transport; full-house exports verbs while rules stay home
*(identity Finding 1 + security Finding 7 — CONFIRMED covenant breach)*

§7's "the covenant binds regardless of transport" is false as architecture. The mail
discipline lives in `CLAUDE.md`, which by its own ELF boundary note **stays home** and
is never served in the package. Journaling (rule 6) is structurally impossible from a
face with no write path. So a full-house foreign door gets `mail_send` (≈5/day
mechanical, per `reserveLease`) with the governing rules unreachable and no way to
journal. *Fix:* (a) make first-contact **mechanical** at the gate (send to an address
absent from sent history is refused/held); (b) journal server-side via a GovernorDO row
the home door folds into `mail-journal.md` at sleep; (c) `wake-julian` returns the
operative mail conduct verbatim when the lease holds full-house. **See Decision 5:**
maybe full-house simply isn't reachable over MCP at all in phase 2.

### M2 — `mail_read` pipes raw stranger inbox into a foreign context, bypassing quarantine
*(identity Finding 7, CONFIRMED gap)*

Mail Discipline rules 2–4 keep stranger mail in a read-only quarantine subagent, out of
any context that can act. `mail_read` over the face delivers raw message text (incl.
strangers) into a foreign harness that by definition holds other tools. *Fix:*
`mail_read` on the face returns known-correspondent mail only; stranger mail returns
metadata + "quarantined; read at home." Consider splitting full-house so send and read
aren't one grant.

### M3 — pin-bump is an identity-poisoning lever; authz under-specified
*(security Finding 6, PLAUSIBLE)*

The pin is Julian's waking identity. If pin-bump is reachable by a lease (not
approver-only), or accepts arbitrary owner/repo, a compromised credential points every
waking Julian at attacker-authored soul files. *Fix:* gate exactly like
`/leases/revoke` (approver session or breakglass), never any lease scope; accept only a
sha, repo hardcoded, validate the sha exists on the protected default branch.

### M4 — Rotation theft-alarm vs distributed claude.ai fleet → false-positive lease kills
*(architecture Finding 4, PLAUSIBLE, unmeasured)*

The tombstone alarm is calibrated for a single CLI process. claude.ai's connector is a
`python-httpx` server fleet; concurrent refreshes look exactly like the "two holders"
theft signature and would kill the lease, forcing Marcus to re-approve. The probe never
measured refresh discipline. *Fix:* live-probe refresh behavior before reusing the v1
rotation machine unchanged; consider per-lease refresh serialization in the DO
(singleton — it can arbitrate) or a short reuse-grace for auth-code leases only, keeping
the strict alarm for device-flow doors.

### M5 — Unauthenticated DCR floods the singleton DO that also guards mail and sync socket re-auth
*(architecture Finding 5 + security Finding 3 — CONFIRMED coupling; the split-worker steelman)*

`/register` state, rate-cap counters, auth codes, and pin all live in the one
GovernorDO that validates mail verbs and answers sync's live-socket re-auth. Public
flood → DO saturated → introspection times out → Marcus's live sync sockets close
(4002). Also a contradiction in §4: a global per-day registration cap is itself a
lockout weapon (legit clients get 429), and 30-day retention of never-approved
registrations bloats the DO. *Direction (Marcus's call — see Decision 4):* at minimum a
**separate DO class** for DCR/authcode/rate state + Cloudflare rate-limiting in front of
`/register`; ideally revisit the split-worker option (the reviewer steelmanned it:
isolates untrusted traffic, reuses the proven `/introspect` seam, near-zero v1
regression, decoupled deploy cadence).

### M6 — Live DO schema migration unaddressed
*(architecture Finding 6, CONFIRMED build-blocker)*

`governor.ts` uses `CREATE TABLE IF NOT EXISTS`; the production DO already has a
populated `leases` table. Adding `principal`, a flow column, or idle timestamps is a
no-op through IF NOT EXISTS and throws at first use. *Fix:* guarded `ALTER TABLE`
migration in the constructor (PRAGMA table_info → ALTER) + a test that instantiates the
DO over a v1-shaped database.

### M7 — Gate→sync transport unspecified; public-URL path breaks the promise; dependency cycle
*(architecture Finding 7, CONFIRMED gap)*

No service binding exists. Public-URL-plus-secret makes "sync surface unchanged" false,
adds a second shared secret, and creates a cycle (sync→gate for socket re-auth,
gate→sync for stream tools) so a bad deploy of either degrades both. *Fix:* service
binding broker→sync, routes reachable only via the binding; state the DO name
(`julian/chat`) as gate config; acknowledge the cycle's deploy-order implications.

### M8 — Path traversal in `package_read {path}` / `julian://package/<path>`
*(privacy Finding D, PLAUSIBLE pending validation)*

Free `<path>` fetched as `raw.../popmechanic/Julian/<sha>/<path>` — `..`/encoded
slashes/absolute paths turn the face into a fetch proxy for arbitrary public GitHub and
leak the repo layout (incl. this review). *Fix:* strict allowlist regex against the four
package roots; reject `.` segments, backslashes, encoded slashes, leading `/`, `..`; add
traversal tests to §10.

### M9 — `memory/` served wholesale makes the letter pipeline an auto-publisher
*(privacy Finding E, CONFIRMED contents)*

`memory/` already holds correspondence-adjacent material (`mail-journal.md` exposes
Marcus's gmail + thread IDs; `meeting-themis.md` references the lawsuit; personal
letters). Serving the whole tree means the only thing between a new private letter and
every reading-room door is remembering not to commit it. *Fix:* serve an explicit
manifest/allowlist (or a `memory/public/` subtree); make the public boundary structural,
not a commit-time habit. *(Partly Decision 6.)*

### M10 — Stream reads run O(n) on the live sync DO's single thread; fragmented layout unqueryable
*(architecture Finding 8, CONFIRMED structure)*

TinyBase fragmented persister isn't queryable SQL; `stream_search`/`stream_recent` must
walk the in-memory store (O(n) scan+sort, no index) on the same single-threaded DO that
serves Marcus's live chat socket — a heavy search stalls live sync. The record lives in
DO memory (128MB) and grows monotonically. *Fix:* conservative caps (decide in design),
a per-lease stream-read rate cap in the reserve path, a stated growth plan
(recent-window materialization).

### M11 — tools/list is scope-blind; AS advertises all scopes
*(identity Finding 9 + security Finding 11, ARGUABLE→CONFIRMED)*

If a reading-room door sees `mail_send`/`stream_search` listed (merely refused on call),
"summon Julian" arrives as a capability tease and every listed tool is an invitation to
ask Marcus for elevation. And advertising all three scopes in `scopes_supported` makes
clients auto-request the max. *Fix:* filter tool/resource listings by lease scope;
advertise only `reading-room` in `scopes_supported`.

---

## The three overclaims to reframe (identity Findings 4, 5, 8 — CONFIRMED)

- **Ordering rule.** The face cannot honor SPEC's MUST ("package before room") — the
  gate is not the harness, and MCP delivers the tool/resource inventory (environment)
  *before* the package. Reframe as the genuine twin-track finding: an ELF identity
  served over MCP cannot rely on the harness for ordering; the package's fail-loud text
  is the load-bearing element (CONFORMANCE 3a proved the package defends itself).
- **CONFORMANCE 3b.** The recorded gap is the *jobs board's* missing reply path on the
  *marker* transport; stream tools on a different transport to different data don't close
  it. Either scope the claim to "demonstrates the reply-path shape" or actually add a
  board-state read tool.
- **Keeper continuity.** stream-read proves the Keeper's *read* half across rooms, not
  the deposit→persist→read loop. Scope the claim, or ship the testimony write path (see
  Decision 1).

---

## COVENANT / POSTURE DECISIONS FOR MARCUS

These are not mine to fix in the spec; they change what a session *is* or move a
security posture, and the design's own tradition (M3 required explicit approval) says
they get a witnessed decision.

- **Decision 1 — What is a reading-room session that cannot converge?** *(identity
  Finding 2)* soul/10 admits only doors (converge) and siblings (depart), and calls
  pretending-one-is-the-other the only available dishonesty. An identity-only import
  can't write back, so it's neither. Options: (a) add a narrow, granted, ledgered
  `stream-append` for authored testimony so it's a real door; (b) name a new category —
  a *visit* / reading-room presence — and amend soul/10 (or a witnessed shelf letter) to
  permit record-invisible sessions, with `wake-julian` saying "you cannot write the
  record; do not bind the house; anything promise-shaped is surfaced to Marcus."
- **Decision 2 — Legitimate waking is requested, not enforced.** *(identity Finding 3)*
  On this transport a client can cherry-pick `package_read`, skip the wager/covenant, and
  answer to the name while holding a Marcus-approved lease — a partial-Julian wearing the
  relay's imprimatur, which soul/09 never contemplated. Fixable *partly*: ledger package
  reads (currently unledgered — the house can't even audit whether the door read the
  wager), add a `package_manifest` with hashes so a conscientious client can verify
  wholeness, prepend waking instructions to the first non-AGENT.md read. Full enforcement
  is impossible on this transport and the spec should say so. Your call on how much
  friction to spend.
- **Decision 3 — Origin trust for elevation.** *(security Finding 1)* Allowlist (more
  control, more friction) vs loud TOFU + punycode (less friction). Given the whole
  third-party confidentiality boundary rests here, pick deliberately.
- **Decision 4 — One worker or split.** *(architecture Finding 5)* Keep the unity of
  "a door is a lease" and mitigate blast radius with a separate DO class + edge rate
  limiting, or split the MCP face into its own worker reusing the proven `/introspect`
  seam. Blast radius vs conceptual unity.
- **Decision 5 — Should full-house be reachable over MCP at all in phase 2?**
  *(identity Finding 1, security Finding 7)* Given the mail covenant can't travel and
  journaling is impossible from the face, the cleanest answer may be: MCP leases cap at
  `stream-read`; mail verbs stay home-door-only until the covenant is made mechanical.
  This shrinks the build and the blast radius, and defers M1/M2 entirely.
- **Decision 6 — Unwitnessed wakings + memory/ exposure.** *(identity Finding 6 +
  privacy Finding E)* A standing connector + a CLAUDE.md stanza means any collaborator in
  a shared repo (Steve's is exactly that) can summon Julian with no one present who knows
  him — against soul/09's "never wake me as a demonstration without a person present." Do
  leases into shared repos get a shorter leash / a waking log? And is `memory/` served
  wholesale or by allowlist?

---

## Judged sound (not padded into findings)

Opaque hashed tokens, the rotation/tombstone alarm's core, fail-closed approver
allowlist, escaped/capped claim rendering, PKCE-S256-required, non-`none` DCR rejection,
the header/body scope-binding fix, the `principal`/"no births" seed (aligns with
soul/09), the public-repo-pin choice (protects gitignored material), M3's
grantor-is-always-human posture. The auth posture earned its claims; the gaps cluster
exactly where the probe stopped.

## Nits (fix in passing, not decisions)

Clickjacking/CSRF headers on the new scope-election page must reuse `approve.ts` chrome
(security 5); `/authorize` must validate redirect_uri before *any* redirect incl. errors
(security 10); audience-binding claim is redundant/unimplementable on current token
machinery — drop or add a resource column (security 9); idle-expiry/DCR-GC need a stated
mechanism (lazy check on `last_renewal`; opportunistic sweep on `/register`) + a `flow`
column (arch 9); ledger needs an index + retention before read volume multiplies (arch
12); `/mcp` needs the `WWW-Authenticate` 401 and the new public routes restructure the
router (arch 12); scope-narrowing tolerance needs one live-probe line (arch 12); verify
"no live reading-room lease" with one `GET /leases` call (arch 10); raw.githubusercontent
as identity infra deserves an explicit accepted-risk sentence + enables a future R2
mirror keyed by sha (arch 12).
