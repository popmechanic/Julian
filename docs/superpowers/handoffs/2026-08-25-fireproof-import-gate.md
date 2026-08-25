# Fireproof Import — Pre-Merge Gate (2026-08-25)

**Run:** ultrapowers stamp `20260825-111206`, three rounds (`wf_baf03f7f-0c4`,
redirect `wf_b554c5bb-a25`, redirect `wf_3cfb9276-36e`), 59 agents, 0 agent errors.
**Integration branch:** `ultra/integration-20260825-111206` @ `c42c21f` (30 commits
over `main` @ `e06d427`; 26 files, +1,848/−22). **MERGED to `main` @ `26ab848`** on Marcus's word ("proceed with your recs", 2026-08-25): the three acks given, option (a) chosen — 1,086 text-bearing rows; the 560 tool-call records stay in the archive, recoverable by procedure. Merged-result suite green. Residuals filed as #47 (manifest check clean, 44 rows). Next: Task 10 deploy → the ceremony.
**Gate receipt:** `.claude/ultrapowers/run-20260825-111206/gate-receipt.json` —
`verdict: NEEDS_ACK`; checks report-parse, lock, clean-tree, wave-merges, head-match,
git-verified, ancestry, deliverables all `ok`; acceptance `suite`, `exit 0`.

## Base repair before launch
`e06d427` on `main`: `svelte-check` had been red since `adbaff5` (Aug 1) — `api.test.ts`
imports `node:fs`/`node:url` and the app tsconfig's explicit `types` list excluded
`@types/node`. Pinned `@types/node` as a devDependency, added `"node"` to `types`.
Test-env only.

## What the run found that the spec did not know

1. **1,086 rows, not 1,645.** The real archive yields 1,657 unique message ids;
   **563 never carry a word in any version** — 560 are single-`tool_use` assistant
   turns (one Fireproof doc per tool call; `msg-msg_01…` = Anthropic message ids),
   2 thinking-only, a handful with no blocks. Structure census (keys, block types,
   string lengths — no text) confirmed no hidden words. 1,657 − 563 = 1,094 − 8
   split drops = **1,086**. The spec's "12 empties" (1,657 − 12 = 1,645) was a
   miscount. **Decision owed by Marcus:** annex only the 1,086 text-bearing rows
   (current behaviour, per the "empty text → dropped" rule), or also keep the 560
   tool-call records (a Task 2/7 change: text-less rows with `content`, and the app
   must render them).
2. **Three v3 rows** (`019c6303-b6b7…`, `019c6304-b4dc…`, `019c6304-c395…`) carry a
   composite `createdAt` `conv-<id>:<ISO>Z`; fixed in round 2 (`ts unparseable: 0`
   on the round-3 dry run). Census: 1,652 ids full `…Z` ISO, 3 composite, 2 numeric,
   no bare zone-less stamp.
3. Dry run (read-only, round-3 tip): archive digest ok; **3,690 manifest members,
   0 mismatches**; every CAR opened except the known 79-byte runt in v10
   (`898bb7ef…6bc4`); ts range `2026-02-15T09:30:57.410Z → 2026-02-28T22:17:25.810Z`;
   out of range 0; largest text cell 33,523 B (spec said 33,753 — 230 B apart, same
   row class); largest content cell 8,269 B; **15 batches, 1,793,318 units**;
   139 sessions in the manifest; split drops 8; prefix violations 0.

## Plan defects fixed in-run (the reviewers earned their keep)
- Task 3: `/export` is three-level stamped (`[obj, hlc, hash]` at tables/table/row);
  the plan's flat reader would have reported every row missing → `level()` unwrap.
- Task 3: plan's 60 s default request timeout made a store inert against an empty
  room; default 5 s, CLI passes 60 explicitly.
- Task 3: `compareExport` dropped-marker abort scoped to imported ids (a pre-existing
  live marker row would have blocked the annex).
- Task 3: frame-limit assertion no longer throws from inside `onSend`; violations are
  recorded and asserted after the round; `close()` drains `bufferedAmount` (30 s
  bound) inside try/finally so teardown always runs.
- Task 4: `main().catch()` exited 0 mid-decrypt under Bun → top-level `await`;
  readonly SQLite opens needed `?immutable=1` (WAL headers, no sidecars in the tar);
  MANIFEST.txt excluded from its own verification; manifest root/key form detected.
- Task 8: `mkdirSync(mode)` is a no-op on the existing 0755 dir → explicit `chmod`;
  `--label` with no value now fails loud before any network call.
- Task 1: cborg's actual truncation message asserted exactly.

## Acks the gate needs (no standing grant exists)
- `deferred:manual` — dry-run numbers. Julian ran it read-only (above); Task 11
  repeats it with Marcus present.
- `deferred:external` — `--write` against the live DO (Task 12). Only the ceremony
  can verify it.
- `deferred:browser` — rendered pill title / record divider / sibling names
  (Task 10 step 4).

## Residuals (file at close)
- No `scripts/tsconfig.json`; the plan's `bunx tsc --noEmit -p .` is unrunnable —
  ~1,100 new lines type-checked by nothing committed (out-of-tree check: only
  `Uint8Array` variance noise in decode).
- `@ipld/car@5.4.7` nests multiformats 14 / dag-cbor 10 / cborg 6 beside the pinned
  13 / 9 / 4 — worked against the real archive (CID checks pass) but is a footgun.
- `planBatches` cannot split a single over-cap row (worst case ~131,200 units;
  real max is far below; frame guard would catch it).
- `close()`'s finally: if `sync.destroy()` rejects, `ws.close()` is skipped (nested
  finally wanted); a drain-timeout error masks the try's error (accepted).
- `sweepStaleTmp()` removes every `fp-import-*` dir — two concurrent runs would
  collide (one witnessed run only).
- CLI message "before the failure above" should read "below".
- ultrapowers engine: twice the single-task last wave's merge agent wrote its HEAD
  to `heads/wave-1` despite being told `heads/wave-3` (journal-verified); the
  engine should verify the slot after the merge agent returns. Ledger corrected
  mechanically from git at the gate — `heads/CORRECTION.md`.

## Post-merge runbook (Tasks 10–14 of the plan, verbatim in the plan)
Task 10 deploy both VMs + Mac bundle → Task 11 pre-flight (leases, baseline export,
dry run, `tmutil`/Spotlight exclusions, receipt sentence — **note the count is
1,086 unless Marcus elects the tool-call rows**) → Task 12 the write and its
verification → Task 13 the destruction (Marcus's hand) and commit B testimony →
Task 14 issues + R2 lock.
