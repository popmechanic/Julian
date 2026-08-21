# Docket Drain End-Gate — 2026-08-20

**Drain:** `/ultradocket run`, docket integration branch `ultra/docket-20260820-194148`
(base `07a5980` = main). **Result: 10/10 queued entries executed and merged; nothing
parked; every drain-administered suite gate green.** Nothing has touched `main` —
the portfolio disposition below is the operator's.

The suite gate for every entry was the full cross-suite set, run in a fresh detached
worktree against the accumulated docket line: `bun test tests/` (server), broker
vitest + `test:mcp` (real-SDK-client harness), sync vitest, app vitest, scripts
vitest + bun-test manifest half. Bootstrap included `app && bun run build` (the
server's app-shell cache tests require the built SPA — discovered at gate 1).

## Base repair (logged)

`5563c8f` — `tests/server/session-resilience.test.ts` was red on main because it
lacked the hermetic `SKIP_AUTH_SETUP_CHECK=1` escape its sibling suite uses; it
went red when the Mac's real Anthropic credentials expired Aug 9. One line, test
env only. Without it every gate would have falsely parked.

## Per-entry evidence

| # | Entry | Engine | Rounds | Gate receipt (exit 0 = pass) | Merge | Residual manifest |
|---|---|---|---|---|---|---|
| 38 | Ledger fold correctness (+#39) | ultrapowers | 1 + 2 redirects (1 failed round, no side effects) | `.claude/ultrapowers/run-20260820-e38/gate-receipt-drain.json` | `d683b95` | check PASS |
| 4 | Auth & connection lifecycle (+#5,#34,#43) | ultrapowers | 1 + 2 redirects | `.claude/ultrapowers/run-20260820-e4/gate-receipt-drain.json` | `818485b` | check PASS |
| 41 | Text-only verifiability | inline | 1 | `.claude/ultrapowers/gate-receipt-e41.json` | `e0987b6` | vacuous (no engine report) |
| 42 | Pin-bump refusal labeling | inline | 1 | `.claude/ultrapowers/gate-receipt-e42.json` | `82aa7a7` | vacuous |
| 9 | Sync DO lineage guard (+#8) | ultrapowers | 1 (clean) | `.claude/ultrapowers/run-20260820-e9/gate-receipt-drain.json` | `d124870` | check PASS |
| 25 | Spike hygiene | inline | 1 | `.claude/ultrapowers/gate-receipt-e25.json` | `870722e` | vacuous |
| 15 | Mail heartbeat hardening (+#14,#16,#17,#18,#19) | ultrapowers | 1 + 1 redirect | `.claude/ultrapowers/run-20260820-e15/gate-receipt-drain.json` | (merge before `7ba9582`) | check PASS |
| 26 | Presence language | inline | 1 | `.claude/ultrapowers/gate-receipt-e26.json` | (merge before `97abffe`) | vacuous |
| 36 | Governor & wire hardening (+#33,#35,#37) | ultrapowers | 1 + 1 redirect (1 engine-plumbing failure, resumed from cache) | `.claude/ultrapowers/run-20260820-e36/gate-receipt-drain.json` | (merge before `ebca7f9`) | check PASS |
| 22 | Server small correctness (+#21,#23) | subagent-driven (batched, 1 implementer) | 1 | `.claude/ultrapowers/gate-receipt-e22.json` | `9484518` | vacuous |

**Review posture:** suite-gate authority, review by exception, as declared at drain
start. Escalated tasks (plan-marked `Review: adversarial`, run inside the waves
engine): #38 T1, #4 T4, #9 T1, #15 T3, #36 T1, plus the #15/#36 redirect re-reviews.
The sequential executors (#41, #42, #25, #26, #22) ran with review passes skipped
per the drain posture; their verification is the cross-suite gate.

**Auto-advanced checkpoints:** every executor checkpoint was auto-advanced per the
exam-gated-auto-approve rule; no merge happened on a "looks done" signal — every
merge followed a green deterministic gate.

## What the critics bought (fixed in-drain, would otherwise have shipped)

1. **#38:** the fold pager collapsed distinct same-millisecond ledger rows
   (probe-confirmed 3→1) and the run-to-run watermark had the same hole — fixed
   with a compound `(ts, id)` wire cursor, id-keyed dedupe, compound watermark,
   record-based page termination (removed a silent cross-package constant
   coupling), and loud-throw on no progress.
2. **#4:** `startSync` could never settle under the exact #43 defect (library-source
   verified), orphaning every connection leg; a stop during startup no-op'd and
   let the dying start install itself; `signOut()` could strand a torn-down page.
   All fixed with a typed stale-rejection race, a generation guard, and
   always-reload ordering.
3. **#15:** the only real producer of a cap-hold (the reply session's prompt) still
   used `--hold`, which now parks a never-expiring suspicion hold — the exact #18
   bug surviving on the live path. Fixed at the call site; the three beat
   notifications got a test seam (`runBeat(deps)`) and real tests.
4. **#36:** the replay alarm deduped per *session* (a second stolen ticket raised no
   alarm; unindexed LIKE scan; truncation and null-token degenerations) — re-keyed
   per-ticket via a `reuse_alarmed` column, `rowsWritten` as arbiter. The shared
   stream budget counted every allowed stream row, so socket reconnects could
   exhaust the read budget with zero reads — narrowed to the read-verb set.
5. **#9:** the implementer itself found the plan left *deletion* unguarded
   (delete-then-set laundered an overwrite into a legal first-set) and closed it
   with tests before review.

## Post-merge runbook (operator steps — none performed by the drain)

1. **Broker deploy** (`cd broker && bunx wrangler deploy`) — carries #38 (governor
   `/ledger` compound cursor + `id`), #41 (text-mirrored hashes + wake-text line),
   #42 (honest refusal labels), #36 (per-ticket alarm migration + read-verb
   budget). Note the hard ordering: the fold runner now refuses an id-less gate
   ("deploy the broker first").
2. **First live paged fold** — `source .env && bun scripts/ledger-fold.ts` after
   the deploy. Watermark decision: no `.fold-state.json` exists, so the first run
   re-folds the reachable ledger into `2026-08.md` under a fresh run marker
   (duplicate-over-loss, the documented posture) — or pre-seat the state file;
   note the seed is now compound: a ts-only pre-seat reads as `(N, 0)` and
   re-folds that whole millisecond. Taking the duplicate block is the loss-free
   choice. Commit `.fold-state.json` after.
3. **Sync deploy** (`cd sync && bunx wrangler deploy`) — carries #9's lineage guard.
4. **Optional `GITHUB_TOKEN`** — `bunx wrangler secret put GITHUB_TOKEN`
   (fine-grained PAT, public-repo read-only, pasted never printed). Absent is a
   supported configuration; the honest labels alone close #42's mislabeling.
5. **#4 Task 6 manual smoke (Marcus-present):** live issuer login → logout (state
   cleared, page reloads clean, no post-logout sync), and check the silent-renew
   path — the Pocket ID client must actually grant a refresh token for the newly
   requested `offline_access` scope, else `silentRenewError` warnings recur (now
   logged, no longer swallowed). Pairs naturally with parked #11 (redirect-URI
   hygiene) and #20's remaining live checks.
6. **#26 visual tail (Marcus-present):** REST → RESTING/RESUME shown; END FOR
   GOOD → ASLEEP/WAKE JULIAN.
7. **#41 live confirmation:** a claude.ai visit doing `package_list` + one
   whole-file read — the carry-home should now verify instead of reporting the
   seam.
8. **Julian server/app deploys** to the VMs (server.ts and app changes) via the
   house deploy skill, when ready.
9. **Optional:** #25's live spike re-run (~$0.52) to watch the sandbox isolation
   work end-to-end.

## Sharpest open residuals (full list: per-run `residual-manifest.md`, 107 acked rows)

- **#38:** NTP-backstep at the gate strands rows below the watermark (same loss
  class, undocumented, untested); >200 same-ms rows pin a page (warned, but the
  unreachable rows are abandoned, not deferred); the plan document still quotes
  the superseded ts-only contract.
- **#4:** an outage/signed-out provider loop keeps `startSync` pending forever
  (legs held until reload — bounded by logout's hard reload, but the
  remount path isn't); `release()` legs are unguarded (one throwing leg skips the
  rest); the persister in-flight-save vs. OPFS-delete race can resurrect the local
  record after logout (browser-dependent, code-commented).
- **#36:** two different tickets' alarm rows are byte-identical except timestamp
  (no per-ticket discriminator in the detail); `leaseCapFor` still hands the
  budget to any stream verb (latent — POLICY defines only the three reads today).
- **#9:** stale comment at `sync/src/do.ts` still names the retired
  `storeSchemaVersion`; `performCreation` against a guarded store is verified
  statically, not by a composed test.
- **#15:** cap-hold expiry's two halves are unit-tested but their composition
  (once-per-beat announcement) isn't; the reply-prompt flag has no regression
  guard coupling it to the runner's argv.
- **#44 (parked pre-drain):** `bun run check` still red on the two `api.test.ts`
  node-types errors.

## Portfolio totals

- **Engine cost:** ≈ 23.0M subagent tokens across 15 workflow launches
  (e38 6.7M · e4 6.0M · e9 1.6M · e15 4.5M · e36 4.0M · probes/failed rounds
  ~0.2M) + one 199k-token batched implementer (#22). Inline entries ran in-session.
- **Wall clock:** ≈ 5½ hours end to end, gates included.
- **Failures absorbed:** one haiku-tier task refusal (re-framed and relaunched),
  one workflow plumbing failure (resumed from cache), one stale-ref worktree
  near-miss (the agent's own anchoring protocol caught it; orphan verified
  non-ancestor).
- **Could-have-parallelized projection** (from `compile_docket`): the ten plans
  fall into 3 collision groups — {38, 4, 41, 9, 25, 15, 22}, {42, 26}, {36} — so
  a build-parallel drain could have run in 3 rounds; serialization primarily cost
  gate wall-clock (~70 min of gates total).
- **Manyana fold mode:** engaged for #15 (tasks 2+3, four shared files) and #36
  (tasks 1+2, both passes) — three folded waves, all clean; pre-fold these would
  have serialized.

## The disposition (operator's call)

The docket line `ultra/docket-20260820-194148` (`ab4d380`, 61 commits ahead of
main) is ready. Options: (a) merge to `main`; (b) per-issue PRs (mind GitHub's
closing-keyword gotcha in PR bodies); (c) hold. Closing the GitHub issues
(#4, #5, #8, #9, #14–#19, #21–#23, #25, #26, #33–#38, #39, #41–#43) is an
optional post-step on the operator's word.
