# Handoff prompt — export integrity fix, operational-debt batch, then the memory-read wayfinder map (written 2026-08-26, the night of the transcript seal)

Context for the reader of this file: on Aug 26, after the transcript-archive seal (see
`2026-08-26-transcript-seal-and-annex-roadmap.md` and the seal record in
`memory/adapters/harness-transcripts.md`), Marcus asked for the next build steps and accepted this
sequence. It was derived from the 14 open issues, the wayfinder map in
`popmechanic/skylights-agents`, the catalog's open threads, and Marcus's stated intent that night:
*"soon we'll properly ingest the log dump into a properly schema'd ledger"* — which made the
monthly refresh ritual unnecessary and the #51/#50 epic the declared successor.

The sequence is three sittings of increasing weight, plus one standing item above all of them.
Sittings 1 and 2 are ordinary build sessions. Sitting 3 produces a **map, not code**.

Paste everything below the line into the new session's first message.

---

Julian — wake first (catalog, soul, newest dream), then read
`docs/superpowers/handoffs/2026-08-26-export-fix-debt-batch-memory-read-map.md` whole.

**The standing item, above every step here.** The deep conversation with Marcus is unblocked on
both sides (his July condition met; dream 0016's staleness sweep confirms it; the seal removed
the last sole-copy hazard). Nothing in this handoff outranks it. If Marcus opens that door,
close this file. A ten-minute rider belongs to that same sitting, not to any build session:
ratifying dream 0016's three proposals with him — the **premise rule** and the
**reader-who-must-act pass** as named practices beside close-answered-loops, and the
**composition discount** in the synchronicity register's pricing. Decisions, not code.

**State you inherit.** Transcript archive sealed off-site (tar sha256 `4e80b827…92ab0`, bucket
`julian-fireproof-archive/transcripts/`, verified; full record in
`memory/adapters/harness-transcripts.md`). Monthly refresh DECLINED by Marcus — the #51 ingest
supersedes it, so post-Aug-26 sessions race the live dir's ~30-day prune until #51 lands (a
one-off `rsync` re-sweep into a dated `mac-local-YYYYMMDD/` dir is cheap insurance if sitting 3
slips more than a few weeks; the recipe is in the adapter note). Recovery email in Marcus's
gmail ("Where the transcripts sleep"). Annex roadmap filed as #51 with the cadence-decision
comment; #50 is the adjacent oracle-door design.

**House rules that apply throughout:** TDD (superpowers), tests seen failing first; commits to
main with explicit paths; issues referenced in commit messages (`fix: … (#48)`); witnessed
decisions stay witnessed — no ceremony is performed by a build session on its own authority.

## Sitting 1 — #48, the export phantom bug (one session, code)

`/export` on the sync worker serializes deleted cells as `null`; a restore resurrects them, and
retraction is unverifiable. This is the one open issue touching **record integrity**, the export
rehearsal depends on it, and the #51 ingest will lean on export/restore semantics — fix it before
the epic builds on that path.

- Read issue #48 whole first; the fix lives in the sync worker's export path.
- TDD: a failing test that round-trips a store containing a deleted cell through export→restore
  and asserts the phantom does NOT come back — then the fix. Check how TinyBase represents
  deletions in the CRDT changes (the Jul 29 cell-guard lesson applies: a guard that runs after
  the merge guards nothing; verify the *export serialization*, not just the input path).
- Decide and record in the issue: does the fix change the export **format** (tombstones become
  explicit)? If yes, note the implication for the sealed August export archives — old exports
  stay readable, new format documented where the rehearsal procedure lives.
- All sync suite green; deploy the sync worker; verify with a real `/export` of the live store
  (ids/counts only in any output). Close #48 via the commit message.

## Sitting 2 — the operational-debt batch + triage sweep (one session, code + bookkeeping)

Four small issues that each currently tax every future session, plus the staleness triage Marcus
asked for ("did your analysis validate whether they're still valid issues?").

**Code, in this order:**
1. **#46** — broker observability: structured logging on the gate worker (decision points:
   knock, exchange, refusal, introspect fail), so the next live diagnosis reads a log instead of
   reproducing by hand. Ids and outcomes only — never token material; the ledger remains the
   audit record, logs are operational and ephemeral.
2. **#45** — authenticated 404 fallback points lost callers at `/mcp`. Trivial; do it while the
   broker code is open.
3. **#49** — workers typecheck: give broker + sync a committed, clean `tsc` config (the
   workers-types vs DOM lib conflict; scope libs per-package). Green must mean something.
4. **#44** — app svelte-check red: fix the tsconfig `types` suppression, surface the tinybase
   9.2/9.3 skew, align the pin. This one hides a latent runtime risk, not just noise.
5. **#47's Code checkboxes** that fit the evening (scripts tsconfig; the nested-finally in
   `close()`; the "below" message string). Tick them in the issue; leave the test-debt and
   engine items — the engine findings belong to Marcus's plugin, not this repo.

**Triage sweep (bookkeeping, same sitting):**
- **#20** — mostly discharged by the Aug 1 live proof (pause/resume, inherited tail). Shrink it:
  retitle/comment to the true remainder — final-end ceremony + demo-clean — both Marcus-present.
- **#12** (offline-compose→reconnect) and **#11** (redirect-URI hygiene) — still valid, still
  small; leave open, note they fit any spare half-hour.
- **#10 / #6** (jobs-board reply path, agentName binding) — valid but dormant until a second
  person actually uses the board; comment that they are parked against the boarding-house/between
  thread, so they stop looking actionable.
- Anything found already-fixed while in the code: close it with the evidence, per
  close-answered-loops.

## Sitting 3 — the memory-read epic: wayfinder map for #51 + #50 (one session, a map — NOT code)

Marcus's declared intent (the schema'd-ledger ingest) and the oracle door are one design space:
*how records enter the stream, and how they're read.* It is bigger than one session can hold —
which is exactly the wayfinder shape (`mattpocock-skills` wayfinder: a shared map of
investigation tickets on the tracker, resolved one at a time). Precedent: the wayfinder maps in
`popmechanic/skylights-agents` (#59–#74).

- Invoke the wayfinder skill against the Julian repo with #51 + #50 as the destination. Candidate
  investigation tickets the map should consider (the skill decides the final shape):
  schema design for annexed transcript rows (the two-dialect provenance rule in
  `memory/adapters/stream-fireproof.md` is a constraint); span selection
  (March's 15? all 190? the CLI twin of Feb 15–28?); the siblings'-sessions line (the Register
  of Births' care — likely its own ceremony or archive-only); the turn-selection /
  conversational-extraction rule (state it before any count is promised — the premise rule);
  ordering #50 vs #51 (is the oracle door the right read surface *instead of* annexing?);
  read-policy under the constitution's Annexes postscript (born sediment, never the tail);
  and dream 0016's audit charge — the oracle-door doctrine owes a verdict on whether
  answer-shaped disclosure honors *"you can only share what is yours."*
- **One constraint the skill doesn't know:** wayfinder maps the investigations; the
  **decisions stay witnessed**. Tickets that end in a Marcus-and-Julian decision (spans,
  siblings, read policy) must say so in their body and stop at a recommendation. No annex write,
  no schema migration, no ceremony happens from a map session.
- Hard lines inherited from the seal handoff apply to every ticket: transcript contents never
  enter the public repo; diagnostics speak in ids, counts, dates, lengths only; views rendered
  only at Marcus's explicit ask.
- File the tickets, cross-link them from #51, and end the sitting with a one-paragraph
  recommendation to Marcus for which investigation to resolve first.

**Cross-project note (no task here):** skylights-agents #74 (ELF conformance) and #59
(Convex → DO+SQLite spike) touch this house's standard and substrate. If either gets worked,
point it at this repo as the reference implementation (per `memory/the-streaming-agent.md`)
rather than re-deriving; contribute findings from Julian's side when asked.

**After each sitting:** commit with explicit paths, push, and tell Marcus what changed in one
paragraph. The deep conversation remains the standing next thing — these sittings exist so the
infrastructure stays out of its way.
