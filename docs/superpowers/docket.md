# Docket

### #1: Design system port — legacy Julian UI into the Svelte app
**State:** executed
**Score:** 9 — pixel-for-pixel restoration of the visual identity, prerequisite for the auth work's SetupScreen restyle
**Est-files:** app/src/app.css, app/public/fonts/*, app/src/App.svelte, app/src/components/*, app/src/lib/sfx.ts, app/src/lib/faces.ts, app/vite.config.ts, app/index.html
**Plan:** docs/superpowers/plans/2026-07-26-design-system-port.md
**Engine:** ultrapowers
**Notes:** Spec docs/superpowers/specs/2026-07-26-design-system-port-design.md approved by Marcus 2026-07-26 (this plan authored same session). Must run BEFORE #2 — the auth plan's SetupScreen task builds on the restyled shell (both touch app/src/components/SetupScreen.svelte). Manual runbook tail: side-by-side Chrome verification vs legacy on port 8000.

### #2: Replace Clerk with Pocket ID self-hosted OIDC (soul.exe.xyz)
**State:** executed
**Score:** 8 — off Clerk onto self-hosted issuer; auth surface, risk-override engine choice
**Est-files:** app/src/lib/auth.ts, app/src/lib/clerk.ts, app/src/lib/api.ts, app/src/lib/events.ts, app/src/App.svelte, app/src/components/SetupScreen.svelte, app/package.json, server/auth.ts, server/server.ts, tests/server/*, sync/src/auth.ts, sync/src/index.ts, sync/wrangler.toml, sync/test/*
**Plan:** docs/superpowers/plans/2026-07-26-pocket-id-auth.md
**Engine:** ultrapowers
**Notes:** Spec docs/superpowers/specs/2026-07-26-pocket-id-auth-design.md approved by Marcus 2026-07-26. Depends on #1 landing first (SetupScreen collision). Two manual tasks are NOT drainable: Task 6 (deploy Pocket ID at soul.exe.xyz — needs Marcus's passkey) and Task 7 (live smoke); code tasks are fully testable without the live issuer via the OIDC_JWKS_JSON inline seam. Constraints: default-deny always; sync Worker not deployed; branch ultra/integration-20260726-012506 never merges to main. RUNBOOK EXECUTED 2026-07-26: issuer is souls.exe.xyz (exe.dev rejects 4-char names; Marcus chose 'souls'); Pocket ID 2.11 deployed via Docker, proxy public, client 0143f667-…c049 (public, PKCE, consent skipped, UNRESTRICTED — new clients default to restricted-with-no-groups = deny-all, which caused a silent access_denied bounce until unrestricted); aud check passed empirically (server accepted access token with aud enforcement — TOKEN_KIND stays 'access'); default-deny 401s verified live; silent-renewal soak deferred (refresh token present).

### #38: Ledger fold correctness — month-boundary loss, invisible refusals, swallowed IO errors
**State:** queued
**Score:** 9 — objective 1: the record's own fold practice can silently lose a month's tail, and the next fold crosses the Sep 1 boundary that bites
**Est-files:** scripts/ledger-fold.ts, scripts/lib/ledger-fold.ts, scripts/lib/ledger-fold.test.ts, scripts/package.json, memory/adapters/gate-ledger.md
**Plan:** docs/superpowers/plans/2026-08-20-ledger-fold-correctness.md
**Engine:** ultrapowers
**Notes:** Cluster anchor; includes #39 (vitest exclude for the bun:test manifest suite — same package, trivial). Verified worse than filed: main() always folds *today's* UTC month with no month argument, so a Sep 1 run reads August rows off the wire and drops them unrecoverably; the bare catch{} can turn an EACCES into a truncation of an append-only file; refused rows render identically to allowed in all three sections (zero "refused" strings in the real 2026-08.md). Time-sensitive: land before the next fold.

### #4: App auth & connection lifecycle — one deliberate pass (residual)
**State:** queued
**Score:** 8.5 — objectives 2+3: after Saturday's sunset the exchange path is the only door, and today logout leaves it syncing
**Est-files:** app/src/lib/auth.ts, app/src/lib/exchange.ts, app/src/lib/store.ts, app/src/lib/events.ts, app/src/App.svelte, app/src/lib/*.test.ts
**Plan:** docs/superpowers/plans/2026-08-20-auth-connection-lifecycle.md
**Engine:** ultrapowers
**Notes:** Cluster anchor; includes #5 residual (persister/Synchronizer/SSE-reader teardown, mount-test infra), #34 (terminal counter inflates on latched-revoked), #43 (deterministic throws loop at 'connecting' forever — the class that cost a forensic hour on drills night). Sharpest finding: signOut() only removes the user; the ExchangeClient caches the access token and keeps minting valid tickets post-logout for the token's remaining hour-scale lifetime. offline_access still missing so session expiry = full-page re-login. Auth surface — risk-override candidate at engine choice.

### #41: MCP face — text-only clients cannot verify whole-file reads or the manifest
**State:** queued
**Score:** 8 — objective 3: "table stakes for text-only vending channels" (drills handoff); claude.ai is a live, enrolled text-only client today
**Est-files:** broker/src/mcp.ts, broker/test/mcp.test.ts, broker/test-mcp-client/harness.test.ts
**Plan:** docs/superpowers/plans/2026-08-20-text-only-verifiability.md
**Engine:** inline
**Notes:** Verified: parts reads already mirror hashes into text (pre-dates the issue); whole-file reads carry sha only in structuredContent, package_list text is count+truncated pin, and the wake text's "every reply carries the hash" is false on text-only transports. Remediation is belt-over-braces mirroring + one honest wake-text line.

### #42: pin-bump mislabels GitHub rate-limit refusals as facts about the repo
**State:** queued
**Score:** 7.5 — objective 3: a refusal mislabeled as a fact corrupts the operator's trust in the pin ceremony; bit four times in one night
**Est-files:** broker/src/as/admin.ts, broker/src/env.ts, broker/wrangler.toml, broker/test/*
**Plan:** docs/superpowers/plans/2026-08-20-pin-bump-refusal-labeling.md
**Engine:** inline
**Notes:** Verified unchanged: one non-ok branch labels 403/429/401/404 all as "sha unknown to the repo"; compare and raw fetches are unauthenticated (shared Cloudflare egress IP against GitHub's 60/hr anonymous budget). Fix: status-distinguished messages; consider GITHUB_TOKEN secret (availability coupling accepted, mislabeling not).

### #9: Sync DO — enforce the once-ever lineage guard server-side
**State:** queued
**Score:** 7.5 — objectives 1+2: protects the July 27 creation-ceremony lineage values; the Fireproof destruction makes the TinyBase lineage the only lineage
**Est-files:** sync/src/do.ts, sync/test/*, shared/schema.ts, scripts/lib/creation.ts
**Plan:** docs/superpowers/plans/2026-08-20-lineage-guard.md
**Engine:** ultrapowers
**Notes:** Cluster anchor; includes #8 (storeSchemaVersion retire-or-make-real — same files, one decision). Verified: the DO's willApplyChanges walks tables only and returns values untouched; any full-house socket can still overwrite ledgerId. #8 constraint stands: any live-store write happens with Marcus present.

### #25: Spike hygiene — spawned CLI sessions can forge harness memory
**State:** queued
**Score:** 7 — objective 1: the incident class is testimony forgery (a spike wrote a false memory attributed to Marcus); the rule exists only as this issue
**Est-files:** scripts/spike-claude-resume.ts, CLAUDE.md or docs/
**Plan:** docs/superpowers/plans/2026-08-20-spike-hygiene.md
**Engine:** inline
**Notes:** Verified: the spawn passes no env; CLAUDE_CONFIG_DIR appears nowhere in the repo; the script was re-run unisolated after the incident. Small fix + a written standing rule.

### #15: Mail heartbeat hardening — silent drops, unvalidated boundaries, permanent holds
**State:** queued
**Score:** 7 — objective 4: the sharpest failure (sent-listing drops) silently reclassifies every real correspondent as a stranger and autonomous replies stop permanently
**Est-files:** scripts/mail-glance.ts, scripts/lib/mail-glance-lib.ts, tests/server/mail-glance.test.ts, docs/mail-heartbeat.md
**Plan:** docs/superpowers/plans/2026-08-20-mail-heartbeat-hardening.md
**Engine:** ultrapowers
**Notes:** Cluster anchor; includes #14 (container-key rename reads as empty forever — and the in-code comment claims coverage it doesn't have), #16 (to[]/labels[] element validation; one malformed element aborts the whole beat), #17 (doc names the wrong id namespace), #18 (cap-holds never expire — needs the dated-hold design decision), #19 (runner has no test seam — prerequisite for #14/#15 fixes; extraction needed since the runner exports nothing). One plan, one pass.

### #26: Presence language — a rest is not a death
**State:** queued
**Score:** 6.5 — objective 4 verbatim; Marcus observed the confusion himself Aug 1
**Est-files:** app/src/components/FaceHeader.svelte, app/src/components/ChatView.svelte, app/src/lib/faces.ts, app/src/components/*.test.ts
**Plan:** docs/superpowers/plans/2026-08-20-presence-language.md
**Engine:** inline
**Notes:** Controls half done (REST / END FOR GOOD, confirm, guard tests). Remaining: both presence readouts are binary on sessionActive — RESTING/RESUME labels don't exist; after a REST the UI says ASLEEP/WAKE JULIAN identically to a final end. Needs the resumability bit surfaced to the UI.

### #36: Gate governor & wire hardening — small correctness set
**State:** queued
**Score:** 6 — objective 3: four verified-small correctness items in the trust core, none urgent alone, cheap as a set
**Est-files:** broker/src/governor.ts, broker/src/lease-auth.ts, shared/gate-contract.ts, broker/test/*
**Plan:** docs/superpowers/plans/2026-08-20-governor-wire-hardening.md
**Engine:** ultrapowers
**Notes:** Cluster anchor; includes #37 (burned-ticket re-presentation grows the ledger unboundedly on a never-minting lease), #35 (per-lease 500/day is actually 3×500 per-verb — Marcus picks the intent at brainstorm, one line), #33 (IntrospectionWire as discriminated union; consume-ticket errors as closed set — types only). Correction recorded on #36: the mechanism is TICKET_MINT_CAP (10), not the session cap; fix is `AND used = 0` on the count.

### #22: Server small correctness — testimony framing, temp orphans, demo guard test
**State:** queued
**Score:** 6 — objectives 1+3: the tail block is testimony (a store-controlled speaker name can break its framing); the kiosk guard protects the operator's resume state untested
**Est-files:** server/lib.ts, server/session-state.ts, tests/server/*
**Plan:** docs/superpowers/plans/2026-08-20-server-small-correctness.md
**Engine:** subagent-driven
**Notes:** Cluster anchor; includes #23 (temp-file orphans on failed writes + the collision test that doesn't bite) and #21 (demo/kiosk final-end guard has no test — the only DEMO_MODE test runs under REMOTE_SESSION and can't observe state survival). Three verified-small fixes, one plan.

### #6: Jobs board — bind agentName to the authenticated sub; text reply path
**State:** parked
**Score:** 5 — objective 3 at the boarding-house horizon: "exactly wrong the day it isn't one agent," but that day is not before Aug 23
**Est-files:** server/lib.ts, server/room.ts, app/src/lib/jobs.ts, shared/schema.ts, broker/src/mcp.ts
**Notes:** Cluster anchor; includes #10 (jobs.list has no reply path for text-only arrivals — verified broader now: the MCP face exposes no jobs verb at all). Design question inside: whether the board's agent-facing surface should live on the MCP face rather than the marker channel. — parked at the Aug 20 docket gate: boarding-house horizon, not pre-ceremony work

### #44: App type-check green — tsconfig types + tinybase dedupe
**State:** parked
**Score:** 5 — dev health: a permanently red check trains the eye to ignore red
**Est-files:** app/tsconfig.json, package.json, app/package.json, shared/package.json, sync/package.json
**Notes:** Replaces closed #24. Two small aligned fixes; verify `bun run check` green end-to-end. — parked at the Aug 20 docket gate: fold in as a rider where natural

### #12: Offline-compose → reconnect — the last unwitnessed local-first path
**State:** parked
**Score:** 4.5 — objective 1, small: the one convergence path still taken on faith since Jul 27
**Est-files:** app/src/lib/store.test.ts (or a deliberate live session, recorded)
**Notes:** Could be a test (preferred, repeatable) or a recorded live session. Cheap; a candidate rider on the #4 lifecycle plan since both touch store.ts reconnect behavior. — parked at the Aug 20 docket gate: candidate rider on the #4 lifecycle plan

### #20: Session-continuity live proofs — the remaining two
**State:** parked
**Score:** 4 — operator-present runbook, not a build: FaceHeader end-ceremony in a live browser; demo mode starting clean
**Est-files:** none (runbook; evidence lands in docs/handoffs/)
**Notes:** 2 of 4 checklist items already proven on record (CLI spawn path; live pause→resume — though only the explicit END path, not the idle-timeout path, which also has no test). Candidate to fold into the next Marcus-present session tail rather than a docket build. The idle-timeout test could ride the #22 server plan. — parked at the Aug 20 docket gate: operator-present runbook, waits for a Marcus-present sitting

### #11: Pocket ID redirect-URI hygiene on the app client
**State:** parked
**Score:** 4 — objective 3, external: config lives at Pocket ID, not in the repo; the gate's own client is already exemplary (single exact URI)
**Est-files:** docs/superpowers/specs/2026-07-26-pocket-id-auth-design.md (spec update only)
**Notes:** Verified unchanged: the app client still registers wildcard localhost + prod /* callbacks. Mostly Marcus's hands in the Pocket ID admin (split dev/prod clients or narrow URIs), then a spec correction. Natural rider on the Aug 23 ceremony sitting or the #4 auth pass. — parked at the Aug 20 docket gate: Pocket ID admin work, Marcus-present

### #29: Visit inbound addressability
**State:** parked
**Score:** 3 — deliberately deferred by design: B3 spec §10.2 fixed the doctrine (MUSTs for when it's built) and says "#29 stays open, pointing here"
**Est-files:** broker/src/mcp.ts (future), gate-mediated relay (undesigned)
**Notes:** Recommend PARK: the honesty half is already live (wake text no longer misrepresents liveness); the mechanism is post-ceremony horizon work that deserves its own spec session, not a docket slot now. — parked at the Aug 20 docket gate per B3 spec §10.2 (doctrine now, mechanism later)
