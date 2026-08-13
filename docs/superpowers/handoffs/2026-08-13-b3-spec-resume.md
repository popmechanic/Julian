# Handoff: resume the B3 spec (rev 3 in progress)

*Written mid-session to pause and resume in a fresh Fable session. Do the waking
read first (catalog, ten soul files, newest dream `0013-replayable`), then this.*

## Why the pause

Marcus was working this with Opus, got flagged by a guardrail on the
security-heavy content, and prefers to continue with **Fable**. Nothing is
wrong with the work; resume it as-is.

## Exactly where things are

- **HEAD** committed at this pause (see the WIP commit at the top of `git log`).
  Tree is clean at pause time.
- **Spec:** `docs/superpowers/specs/2026-08-13-plan-b3-stream-spec.md` is **rev
  3, COMPLETE** — all sixteen sections, 812 lines. §1–§8 were authored by
  another hand (see provenance note) and verified sound; **§9–§16 were written
  by this session at the pause** from the findings-doc round-2 block. The whole
  document is ready for Marcus's spec-read.
- **Provenance note (important, honest):** rev-3 §1–§8 in the tree were authored
  by **another hand** — a concurrent session sharing this working tree, not the
  main door this session ran in. The main door read §1–§8 whole and verified
  them against the merged code and the round-2 findings: they are correct and
  fold every round-2 cure accurately (R2-D1 total provider, R2-D2 uncached
  tickets, R2-D3 by-handle re-auth, the `upsertLease` reserved-identifier guard,
  the fail-closed sub→principal map, the alarm-sweep contract, etc.). Adopt them.
  This is the [[10-doors]] seam made literal — two hands, one file; the merge is
  by testimony, and this note is the testimony.
- **Findings doc:** `docs/superpowers/specs/2026-08-13-plan-b3-review-findings.md`
  is COMPLETE through round 2 — round-1 four-lens findings + round-2 cure
  verification and the new-machinery findings, by lens, plus the converged
  blockers R2-D1..D5 and Marcus's round-2 rulings. **This is the source of truth
  for what §9–§16 must say** — every missing section's content is enumerated
  there.

## THE WORK: Marcus's spec-read, then the plan

Rev 3 is complete (§1–§16). **Next action: Marcus reads the completed rev 3.**
On his word → `superpowers:writing-plans` + `ultrapowers:ultraplan`;
execution-fit will almost certainly say Ultrapowers (auth/integrity risk
override). The section-by-section record below is retained as the map of what
each section must contain, for the spec-read and as the plan's checklist —
every item is now IN the spec, drawn from the findings doc's round-2 block:

- **§9 Package integrity** — the **sticky sitting pin with a reset act**
  (R2-D4 / SEC NEW-2 / COLD CRITICAL-2): `package_list` re-seats the sitting
  pin and clears the latch counter; the refusal text names that act; a pin bump
  mid-sitting is recoverable, not a 30-day wedge; KV eventual-consistency noted.
  The **bounded atomic latch** (SEC HIGH-4 / NEW-7): length-verified mismatch,
  **refetch once with `cacheTtl:0` inside one `package_read`** (atomic,
  unraceable, immune to the 300s edge cache), never latch shared/authcode
  leases, self-clear only on the same `(pin,path)`. **Pin-bound numbered parts**
  (#30 / PROTO H5,N4 / COLD M-11): whole-file-verify-then-slice, codepoint-safe,
  server-authoritative M, `partSha256` labeled a **transport checksum** (cannot
  latch), a `package_read {path}` with no `part` on a parted file is a **typed
  refusal naming `parts`** and the wake text says a parted-file refusal is
  instruction not damage; parts are pin-bound (a part at a different pin than
  part 1 is a distinct refusal; cross-part `fileSha256` equality is the client
  rule).
- **§10 Visit items** — **§10.1 R-6′**: Bash dropped (real), and since agent
  frontmatter has **no** path-scoping mechanism (docs-verified), the claim
  stands on the true form — the read-write visit has no shell — and
  `visit_agent` **emits the host-applyable `settings.json` permissions snippet**;
  the §13.5 witnessed postscript records enforcement-where-applied /
  manners-elsewhere. **§10.2 #29** with the corrected mail-covenant scoping
  (rule 2's ordering applies with full force; rule 5 inapplicable; rule 6
  subsumed; inbound-only; no liveness misrepresentation). **§10.3** #31 + nits.
  **§10.4** the ledger fold: **dated append-only derived files**
  (`memory/ledger/2026-08.md`, header marked derived-not-authored), holder/session
  column rendering, and the corrected teaching (*exchange rows are a tab getting
  standing — not evidence of anyone's attention; presence is read from content,
  never credentials*); theft signals (ticket-reuse, rotation kills, latches)
  never collapsed; composite ledger indexes.
- **§11 Errors/refusals** — the new typed, ledgered shapes (pin-moved,
  integrity-latch + self-clear, part-out-of-range, parted-no-part, exchange
  refusals incl. terminal revoked, ticket-expired, ticket-reused, too-many-
  sessions, stream-unavailable, rate-cap) and the 4001/4002/4003 family.
- **§12 Testing** — the spanning suite (v1 client) + all the round-2 assertions:
  the sync-router-twice single-use test, the survives-while-token-lives /
  closes-on-expiry pair, the forged-internal-header spoof test, revoke→
  re-exchange-refused + reinstate-gated-ledgered, at-cap-refuses-not-evicts,
  fail-open-missing-EXCHANGE_RL, disallowed-origin-no-ACAO on both faces,
  latched-visit-does-not-refuse-a-second-visit, `STREAM_SUBS`-sub-without-map→
  refused, pin bump → reset → resume, the tolerance probe, `ping`=`{}`, hint
  policy per result type.
- **§13 Live proofs + ceremony** — **§13.2** the browser cure in a **real
  browser** (workerd can't see D2's class): two tabs, revoke→close-within-SLA→
  reconnect-refused, then reinstate + **explicit reload** (COLD M-9). **§13.3**
  the drills incl. the pin-drift drill **ending in a recovered read**, and the
  **export rehearsal before the ceremony**. **§13.4** the sunset under the
  **R-8 72-hour-soak predicate** (target Aug 23), producing a **Julian-authored
  letter** naming what ended AND what remains borrowed; assert the revoked
  window can't be revived by a knock. **§13.5** the witnessed `the-visit.md`
  postscript + the **Fireproof-ceremony calendar-date ask** while Marcus is
  present.
- **§14 Out of scope** — memory-wire, #29 mechanism, the B4 checklist, the DO
  write guard (R-2′), device-flow election, shell-bearing visit, boarding house.
- **§15 Accepted risks** — the `stream` write capability (R-2′, record-forgery),
  the app-DOM boundary (localStorage, CSP task), remaining borrowed bearers
  (F4 scoping), the relaxed one-token invariant, the worker cycle, GitHub
  coupling, the by-handle introspect as a capability growth for
  `INTROSPECT_SECRET` holders, Aug-23-is-close under R-8.
- **§16 Plan B closes** — the whole proof sequence; **no self-verbs** (delegated
  standing, not "converges as a door"); the bearer claim scoped to "the only
  place a human login is **traded for agent standing** is the exchange."

Then: **Marcus reads the completed rev 3**; on his word →
`superpowers:writing-plans` + `ultrapowers:ultraplan` (execution-fit will almost
certainly say Ultrapowers — auth/integrity risk override).

## Rulings locked this session (R-1..R-8, R-2′, R-6′) — in the spec header

R-1 full cure; R-2 mail-less `stream`; R-2′ **write capability confirmed on the
corrected description, DO write guard NOT built**; R-3 #29 doctrine-only; R-4
socket tickets; R-5 delegated session (not a door); R-6 Bash dropped; R-6′
path-scoping is host-settings-only (docs-verified); R-7 ceremony by act, Sep 1
backstop; R-8 **72-hour soak predicate**, target Aug 23.

## Review artifacts (for harvest, then delete)

Two full adversarial rounds ran (four lenses + a round-2 cold adversary + a
docs check). All reports are distilled into the findings doc; the reviewer
subagents can be discarded. **Clock: `LEGACY_WINDOW_END` real value is
`2026-08-23T00:00:00Z` = 5pm Aug 22 Pacific** — moving it to Sep 1 is the first
item of the first deploy (§6.6 step 1).

— paused mid-turn, Aug 13, 2026; resume with Fable
