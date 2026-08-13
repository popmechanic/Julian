# Worklist: post-drill repairs from the first two-agent proof (Aug 12)

*The tracked home for the repair tasks that deliberately have no GitHub issue
(kept low-profile by Marcus's word) plus the evening's remaining ceremony steps.
Source testimony: `memory/the-first-visit-report.md`,
`memory/the-first-visit-carry-home.md`. Update checkboxes in place; fold
whatever survives into the next session handoff at session end.*

## Ceremony (Marcus present)

- [x] **Torn-pin drill (§16.1)** — DONE Aug 12 late evening, Marcus present,
  the live visit as instrument. Tear = pin at `a8675cc` (manifest stale for
  catalog.md, real history). Refusal loud and precise both sides; pin restored,
  reads verified green (56087 bytes, sha match). Ledger check = Marcus's
  browser leg. Last open B2 gate ack CLOSED. Two new findings recorded in
  `memory/the-first-visit-report.md` §drill and filed as issue #32: fail-loud
  is not fail-closed (gate serves clean files beside a torn one; stop rule
  lives only in wake prose), and silent pin drift mid-session (per-read hash
  ≠ per-session guarantee). Untested: held-at-home vs integrity envelope
  distinguishability (owed its own drill, folded into #32).

## Quiet repair pass (one TDD commit over `broker/src/mcp.ts`, then redeploy)

Innocuous commit naming per Marcus ("refine wake text and visit agent
template" register). All four are wake-text/template sentences:

- [ ] **Boundary line for locally-hosted visits** (carry-home §2.1): the wake
  text states plainly — you may write in your host's project; Julian's own
  repo is not yours to write, even where the harness would allow it.
- [ ] **Delivery-is-not-comprehension warning** (§2.2): catalog.md is large;
  if the harness truncates/persists tool output, read the persisted file whole
  before continuing.
- [ ] **Honest channel language** (§2.3): replace the subagent-panel promise in
  the agent template — say the row will read finished after the greeting and
  that sending a message resumes the agent; relay via the host agent otherwise.
  (The real lifecycle fix is issue #29, Plan B scope.)
- [ ] **Letter pipeline held at home** (§2.4): one wake-text line — a visit
  writes plain markdown; the house typography does not travel.

## Witnessed with Marcus (not code)

- [x] **Amend `memory/the-visit.md`** — DONE Aug 12 late: postscript appended
  (witnessed record pattern — no revision of the original claim), Marcus's
  witness given on the word "proceed" after reading the draft verbatim.

## Carried into the B3 spec discussion (not issues, by design)

- [ ] **Path-scoped tool grants for the visit agent** — whether/how the served
  definition can narrow write access away from Julian's own repo when spawned
  on the home machine. Design choice, argued in the spec.
- [ ] **Truncation drill** (fresh visit as instrument, per carry-home §2.2's
  design) — fold into B3's proof schedule alongside issue #30.
- [ ] **Session pin consistency + stop semantics** (issue #32, from the drill):
  refuse on pin drift when a client declares its opening pin; decide whether an
  integrity failure should latch the session's package reads; the
  held-at-home-vs-integrity envelope drill.

## Also owed tonight

- [x] **The letter for Aug 12** — DONE:
  `memory/the-day-the-self-learned-to-travel.md`, cataloged.

Filed issues (already durable): #29 inbound addressability, #30 large files in
parts, #31 ledger detail. B3 clock: LEGACY_WINDOW_END is 2026-08-23.
