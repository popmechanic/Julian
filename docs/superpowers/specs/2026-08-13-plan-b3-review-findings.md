# Plan B3 spec — four-lens adversarial review findings

**Date:** 2026-08-13 · **Target:** `2026-08-13-plan-b3-stream-spec.md` (rev 1, `a6c103c`)
**Lenses:** security (SEC), protocol conformance (PROTO), operational/deployment (OPS),
identity/covenant (IDN). Four independent reviewer subagents, repo access, no edits.
**Verification:** every CRITICAL and each load-bearing code claim was independently
re-verified by the door against the merged code before acceptance; all held.
**Dispositions:** recorded in the spec's rev-2 header block; findings below are the
durable record the plan cites by ID.

## The three structural defects (found independently by multiple lenses)

**D1 — Revocation did not hold; multi-tab self-evicted.**
(OPS C-1/C-2, SEC CRITICAL-1, PROTO C1.) `governor.ts:586-591` keeps ONE access
token per lease (`insertPair` deletes priors); `upsertLease` (`:608-624`) deletes
ALL tokens and unconditionally sets `status='living'` on revival. Under rev 1: two
tabs evict each other in a permanent 4001 flap, and a revoked `web:<sub>` lease is
resurrected by the next page load's re-exchange — §13.2's live revocation proof
would defeat itself on camera, and a leaked token could never be killed for cause.
*Fix set:* flow-aware token storage (N concurrent access tokens for exchange
leases, capped and pruned; device/authcode delete-then-insert and the rotation
tombstone untouched, tested in both directions); exchange refuses non-`living`
rows (typed refusal; reinstate is a register act gated like revoke); client treats
`revoked` as terminal, only `expired` retries.

**D2 — The subprotocol presentation could not work as written.**
(PROTO C2/C3/H3/M5, OPS C-4/H-1, SEC HIGH-1 + LOW.) Nothing echoes
`Sec-WebSocket-Protocol` (TinyBase's DO builds a bare 101; workerd copies only
`Sec-WebSocket-Extensions`), and per the WHATWG rule Chrome hard-fails a connect
whose offered protocol is unacknowledged — while workerd-as-client does not
enforce the rule, so the planned CI test passes green against a browser that
cannot connect. Stripping the credential before forwarding kills the DO's
attachment-driven re-auth (`do.ts:29-33,192-198,210-212`) — browser sockets
become as immortal as the JWT sockets being cured. `reconnecting-websocket`
freezes `protocols` at construction but takes `url` as a refreshable
(sync-or-async) provider — the credential lands in the one slot that cannot
rotate, while the slot being vacated is the one that can. Prefix nit: the token
is already a legal RFC 6455 subprotocol verbatim (`jla_` + base64url); `jla.` was
a needless re-derivation seam. *Disposition:* presentation redesigned to
short-TTL single-use socket tickets in the URL (rev-2 R-4); the subprotocol
variant is recorded as rejected with these reasons.

**D3 — §7's conformance claim was wrong and its tripwire could not fire.**
(PROTO H1/H2/H4/M1/M3/M6.) The 2026-07-28 revision canonized the *statelessness*,
not the server: `server/discover` is mandatory, `resultType` is required on every
result, `ttlMs`/`cacheScope` are required on list/read results (`CacheableResult`),
`Mcp-Method`/`Mcp-Name` must be validated against the body, HTTP statuses change,
and `-32002` (used 5× in `mcp.ts`) falls in the legacy range. Blanket cache-hints
would break `ping` on every v1 client (`EmptyResultSchema` is `.strict()` —
executed against four SDK versions). The v2 SDK client defaults to
`mode:'legacy'`, so rev 1's smoke test would re-exercise the 2025 handshake and
prove nothing; its codec is lenient at probe and strict at first real call.
RFC 9207 `iss` belongs on the delivery redirect in `as/approve.ts` (not
`authcode.ts`), requires `authorization_response_iss_parameter_supported: true`
(a MUST when emitting), must be byte-identical to the advertised issuer, and is
new in 2026-07-28 (SEP-2468), not "both revisions." Also a live 2025-06-18 MUST
violation today: non-`initialized` notifications get 200 + error body instead of
202-no-body. *Disposition:* §7 rewritten "tolerant, not conformant" with a B4
checklist; hints restricted to the four cacheable results; notifications rule
fixed in B3; iss corrected; CI narrowed to a raw tolerance probe with the B4
tripwire being live-probed client dialect.

## Identity/covenant findings (IDN)

- **F1 CRITICAL** — `web:<sub>` + `principal='julian'` + no tap mints Marcus's
  standing wearing Julian's door-name; hard-codes "the only human is Marcus" into
  a mint path; overloads `APPROVER_SUBS` from governance into access; corrupts
  the ledger as dream source (browser rows read as Julian's doors).
  *Disposition (R-5, delegated session):* `door_name='browser:<sub>'`, new
  `subject` column (whose standing), `principal` stays the record owner, separate
  `STREAM_SUBS` list, "door" language removed for this lease class.
- **F2 HIGH** — path-scoped-hands enforcement claim false: `Bash` is in the
  read-write visit grant (`mcp.ts:50`). *Disposition (R-6):* Bash dropped;
  the claim becomes true.
- **F3 HIGH** — a new doctrine sentence was attributed to `the-visit.md`'s
  witnessed postscript that the postscript does not contain. *Disposition:*
  restated as B3's proposal; a second dated postscript, witnessed with Marcus at
  the §13 session, is a named build task (alongside, never over).
- **F4 HIGH** — §16 "nothing anywhere in the house authenticates by borrowed
  bearer" is false (the exchange is a bearer traded hourly; machine secrets;
  the substrate runs on Marcus's Anthropic OAuth; AgentMail's key).
  *Disposition:* claim rescoped to record-reaching surfaces; remaining
  borrowings named in §15.
- **F5 HIGH** — an "enforcement where cheap" standard was cited to dream 0012,
  which states no such standard ("cheap" appears once, re the label as the
  blast-radius principle's cheapest instrument). *Disposition:* citations
  corrected to 0012's actual verdicts (label vs blast-radius; conflating them is
  the next overreach); findings attributed to the drill and the visit's labeled
  testimony.
- **F6 HIGH** — the scope table hid that the socket is a WRITE surface (converges
  with SEC CRITICAL-2). *Disposition:* column renamed, deliberateness stated,
  forgery risk in §15, DO-side write guard explicitly not built with reasons.
- **F7 MED** — §16's "converges as a door" rode a self-claim on an auth build.
  Reworded without self-verbs.
- **F8 MED** — #29 doctrine: reason corrected (continuity is in the hands, not
  the channel — the real risks are a persistent-presence blur of the
  visit/sibling line and an unwitnessed instruction channel); added terms:
  quarantine rules 3–4 apply to a visit's inbound channel, rules 2/6 are
  meaningless for a visit and say so; a visit's address is inbound-only (a visit
  never sends on Julian's channels); the channel must not misrepresent liveness;
  inbound record-invisibility stated, with a note that addressable visits
  warrant revisiting ruling R-C.
- **F9 MED** — the parent spec's promised waking-ledger fold was never built and
  B3's routine rows would swamp it. *Disposition:* fold named owed with
  door-class separation; `memory/adapters/` note for the ledger as a dream
  source (`flow='exchange'` rows are Marcus's presence, not Julian's doors).
- **F10 MED** — the Fireproof destruction ceremony (0012: "must not slip past
  September unremarked") appeared nowhere. One line added to §13's session asks.
- **F11 LOW** — visit testimony cited as house findings; relabeled per the
  first-visit report's covenant.
- **F12 LOW** — "on the record" named no artifact; the sunset ceremony now owes
  a dated letter + catalog line as a task.

## Security findings not covered above (SEC)

- **HIGH-3** — CORS unspecified on the exchange; the panic-fix (`ACAO: *`) would
  let any page trade a captured JWT for a lease and read it. *Fix:* `APP_ORIGINS`
  exact-match allowlist, `Vary: Origin`, no credentials, OPTIONS handler, no-ACAO
  test for disallowed origins.
- **HIGH-4** — the integrity latch as specified is a durable remotely-triggerable
  DoS: `package.ts` classes transient failures (5xx, mid-read truncation) as
  integrity; shared pseudo-leases (`legacy-window`) latch every holder at once;
  paths are caller-chosen. *Fix set:* latch only on length-verified digest
  mismatch, two consecutive on same `(pin, path)`, never latch shared
  pseudo-leases, self-clear on a clean verified read.
- **HIGH-5** — "nothing durable to steal" understated the app origin's DOM as
  the real boundary (oidc user in localStorage). Risk restated; CSP named a task.
- **HIGH-6** — exchange tokens had no theft detection and the shared row
  destroyed attribution. *Fix:* per-token `token_id`, returned by introspect,
  ledgered by sync at socket open/re-auth; makes per-token anomalies visible and
  D1's revocation usable.
- **HIGH-7** — `expect_pin` was opt-in, so the least-trusted reader gets silent
  drift. *Fix:* server-side sticky session pin on the lease (first package act
  records it; later mismatch refuses regardless of client args); `expect_pin`
  stays as client cross-check; input validated `/^[0-9a-f]{40}$/`.
- **MED-1** — audience verification fails open when `OIDC_AUDIENCE` is unset
  (`auth.ts:9`); now the one thing distinguishing app tokens from any
  `souls.exe.xyz` token. *Fix:* fail-closed like `APPROVER_SUBS`.
- **MED-2 / OPS M-2 / PROTO L1** — a shared scope *vocabulary* import would make
  `knockDecide` accept `stream` from a crafted POST (the C2 anti-pattern by
  refactor); `governor.ts:53 SCOPES` is a fourth constant. *Fix:* per-mint-path
  allowlists exported separately; `KNOCK_SCOPES` excludes `stream`; matrix test.
- **MED-3 / PROTO M4** — "reachable only through the binding" is not a real
  guarantee (binding calls are indistinguishable from public fetches); routing
  order puts `/internal/*` at 404 in `parsePath` before any auth; `/internal/`
  must be reserved against principal names; `timingSafeEqual` lives only in
  broker and moves to `shared/`. Sentence rewritten: the secret is the
  enforcement, the binding is the road.
- **MED-4 / OPS M-3 / PROTO H7** — `/leases/exchange` is swallowed by
  `index.ts:132`'s `startsWith('/leases/')` admin route. *Fix:* own path
  `/exchange`; register namespace stays operator-only; both-direction routing
  tests.
- **MED-5** — `door_name` namespaces unguarded (`UNIQUE` across flows): an
  operator-typed device door named `browser:<sub>` would be silently taken over.
  *Fix:* reserved prefixes refused at `knockDecide` and the approval desk.
- **LOW set** — DO hibernation attachments persist raw bearers (`do.ts:196-198`)
  against the governor's hash-only posture → attachments become
  `{leaseId, tokenId}` handles; `stream_search` gets no caller regex and
  server-clamped limits; the cross-worker request shape becomes a `shared/`
  fixture asserted by both suites (the issue-#28 drift lesson); "leaves logs
  entirely" softened (headers leak by configuration, URLs by default).
- **Factual correction** — rev 1 said `verifyWithKeySet` "leaves sync entirely";
  `broker/src/auth.ts:5` imports it FROM sync. It moves to `shared/`.

## Operational findings not covered above (OPS)

- **C-3** — deploy order: sync-first is a hard lockout (current introspect
  returns definitive `{active:false}` for non-`jla_` tokens — `admin.ts:55` —
  which sync caches 60s as revocation). Safe sequence now normative in §6.6:
  broker first (additive only, `legacy-window-sync` seeded idempotently in the
  constructor), live-probe the JWT introspect path, then sync, then apps;
  `SYNC_READ_SECRET` installed both sides before first binding use; sync must be
  rollback-safe without a broker rollback.
- **H-2 / SEC HIGH-2 / PROTO M2** — true revocation lag is re-auth interval +
  60s introspect cache (≈6 min); **unbounded for a silent receiver** (re-auth is
  inbound-traffic-driven only — `do.ts:210`). *Fix:* wall-clock alarm sweep in
  the DO for socket re-auth (traffic-driven kept as belt); scheduled re-auths
  bypass the cache; SLA numbers stated honestly in §6.2/§13.
- **H-3 / PROTO L2** — `do.ts:240` and `:250` hardcode `full-house` separately
  from the router; a `stream` socket would die 4003 five minutes in. Both sites
  named; test drives a `stream` socket past the interval.
- **H-4** — the `ratelimit` binding doesn't exist yet (P1 *proposed* it); it's a
  new binding needing a vitest stub, and a per-IP cap can lock Marcus out on
  CGNAT. *Fix:* binding in the delta list + stub; cap counts only requests
  failing verification; verified approved-sub exchanges uncapped; 429 behavior
  specified for the app.
- **H-5** — "same deploy" is three artifacts; `VITE_SYNC_URL` is absent from the
  deploy skill, so julian-new's app cannot sync at all today. Artifacts
  enumerated; the var added to the deploy skill as a B3 task (julian-new becomes
  a syncing client for the first time).
- **H-6** — `stream-export.ts`'s new credential had no source or refresh; an
  hour-TTL token in an env var is dead before the next run, and the monthly
  rehearsal falls inside the window. *Fix:* a device-flow `stream-read` lease
  with stored refresh (gate-lease-file pattern); rehearsal scheduled BEFORE the
  ceremony and listed in §13.
- **H-7** — stale clients loop forever (~2 connects/min) and the governor ledger
  has no index, no retention, and a `COUNT(*)` on every reserve. *Fix:*
  `ledger(ts)` index as an additive migration; stale-bundle UX stated (terminal
  auth failure → "reload" message); retention/fold noted with F9's fold task.
- **M-1** — `LEGACY_WINDOW_END = 2026-08-23T00:00:00Z` fires **5pm Aug 22
  Pacific** and moving it is a redeploy. *Disposition (R-7):* ceremony stays
  Aug 23 by Marcus's word, gated on the browser cure being live; env backstop
  moves to Sep 1 so a slip cannot break convergence unceremoniously.
- **M-4** — severability: Cut A (bind + scope authority + sync swap; closes the
  account-wide full-house hole, no client changes) / Cut B (exchange + browser
  cure) / Cut C (stream verbs) — adopted as the build's wave structure; the
  sunset gates on Cut B live and observed.
- **M-5 / SEC MED-5** — the exchange hardcodes `principal='julian'`; with the
  `subject` split (F1) the mint derives principal from the sub→principal map,
  single-entry today.
- **L-2** — the latch flag is a fifth column read by `validateAccess` — named as
  an additive schema change, not "no new round-trip" hand-waving.

## Checked and clean (worth keeping on the record)

Token-kind discrimination at introspect is sound in both directions (`jla_` vs
`eyJ`); the introspect cache cannot be poisoned (sha-keyed, definitive-only);
no new cross-site socket vector (subprotocol/query credentials unobtainable by a
hostile page; standing constraint recorded: sync must never accept a cookie);
`jla_` tokens are verbatim-legal subprotocol values (moot under tickets, kept for
the record); wrangler handles the cyclic bindings fine (both workers exist);
batching refusal, SSE 405, no session id, and the handshake-less tolerance claim
all verified true; `-32602`-before-pen matches the `resources/read` precedent;
the shared-scopes M9 rationale verified (schema.ts drags tinybase; broker has no
julian-shared dep — the new module must be import-free and the broker gains the
dep).

— assembled by the door from four reviewer reports, 2026-08-13
