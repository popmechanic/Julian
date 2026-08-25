# Handoff prompt — the ceremony session (written 2026-08-25, after the merge)

Paste everything below the line into the new session's first message.

---

Julian — wake first (catalog, soul, dream 0015), then read, in order:
1. `docs/superpowers/handoffs/2026-08-25-fireproof-import-gate.md` — what was built, what
   the run found, what Marcus decided.
2. `docs/superpowers/plans/2026-08-25-fireproof-import.md` **Tasks 10–14** — tonight's runbook,
   verbatim. Spec: `docs/superpowers/specs/2026-08-25-fireproof-import-design.md`
   (steps 1–13; §"Testimony, then the sunset").
3. `docs/gate-approval-ceremony.md` and `docs/mail-heartbeat.md` only if a knock is needed.

**State you inherit.** The Fireproof import is MERGED to `main` @ `26ab848` (ultrapowers
run `20260825-111206`, three rounds, gate approved by Marcus; merged-result suite green:
scripts 84+57, app 113 + svelte-check 0, sync 189). Nothing is deployed yet. Residuals are
GitHub #47. Working tree clean; branches `main` + `pallid-mask` only.

**Decisions already made — do not re-open.**
- The real row count is **1,086**, not the spec's 1,645: the archive holds 1,657 ids, 563 of
  which never carry text in any version (560 single-`tool_use` turns). Marcus chose **(a)**:
  annex the 1,086 text-bearing rows; the tool-call records stay in the archive (local +
  R2), recoverable by the committed decode recipe. The receipt sentence and the letter say
  1,086 and name that.
- Dry-run expectations (already observed read-only on the merged code): archive digest
  `64f5d5e1…4ee3`; 3,690 manifest members, 0 mismatches; every CAR opens except the known
  79-byte runt in v10 (`898bb7ef…6bc4`); ts range `2026-02-15T09:30:57.410Z →
  2026-02-28T22:17:25.810Z`; out of range 0; `ts unparseable: 0`; largest text cell
  33,523 B, largest content cell 8,269 B; **15 batches / 1,793,318 units**; 139 sessions;
  split drops 8; prefix violations 0; 563 empties listed by id + block types. If tonight's
  numbers differ, stop and say so — do not "fix" a number.
- Sequence for the sitting: Task 10 deploy → Task 11 pre-flight → Task 12 write +
  verification → Task 13 destruction (Marcus's hand) → **the sunset** (Marcus revokes
  `legacy-window-sync`; B3 spec §13.4) → Task 30 post-ceremony deletion deploy → commit B
  testimony. Aug 23 slipped; say so in the letter.

**Hard lines.** Never run `--write` or any `ssh exe.dev rm` without Marcus present and
saying so. The CLI never prints message text; keep it that way in your own diagnostics
(ids, counts, lengths only). Lease tokens only via the gate (`~/.julian/gate-lease.json`;
refuse `legacy`); if `stream-export` prints knock instructions, Marcus approves at
`/approve` first. The archive path is fixed in `scripts/lib/fireproof-types.ts`; no
override exists and none should be added.

**Task 10, the one step you may run alone** (ask Marcus for timing — it restarts both
VMs): the `deploy` skill's Update flow for `julian` (production — the skill will make you
confirm) and `julian-new`: pull `main`, reconcile `.env`, rebuild the SPA, restart; then
`curl -s https://julian.exe.xyz/ | grep -o 'assets/index-[^"]*'` and the same for
`julian-new.exe.xyz` must match; `cd app && bun run build` for the Mac (server serves
`app/dist`); hard-reload `http://localhost:8000` and hover the pill: `stream: … · N rows`
proves the bundle. Run `cd scripts && bun install` once on the Mac (the four decode deps
are new).

**Task 11 specifics.** Mac server with `DEMO_MODE` unset; `bun scripts/stream-export.ts
--label baseline` (proves the stream-read lease; files now land `0600` in a `0700` dir);
`bun scripts/stream-import-fireproof.ts --manifest-out
~/julian-stream-backups/fireproof-annex-manifest.txt` and check the numbers above;
`chmod 600` the existing exports; `tmutil addexclusion -p ~/julian-stream-backups`;
`touch ~/julian-stream-backups/.metadata_never_index`; Marcus accepts the OPFS cost
(≈320 KB → ≈3 MB); append the per-ledger manifest summary (no text) to
`memory/adapters/stream-fireproof.md` for commit B; write the receipt sentence to
`/tmp/receipt.txt` — UTC write date, **1,086 messages**, Feb 15–28 2026, web-app side only,
twenty ledgers v3–v14, line separators normalized, the 560 tool-call records left in the
archive by procedure, Feb 10–14 / March / the CLI side elsewhere; no speaker names, no third
parties. Marcus reads it before the write.

**Task 12 expectations.** `--write --receipt-text /tmp/receipt.txt` → final line `equal
1086 mismatched 0 missing 0 dropped 0; receipt present` (rounds may be >1; the CLI now
drains the socket before closing and asserts frame violations after each round). Then
`stream-export --label post-import` → `VERIFIED export: ~1,310 messages` (223 live + 1,086 +
receipt ± today's rows), earliest `ts` Feb 15; Mac + phone hard reload — pill count equals
the export; the record divider sits at the seam; a sibling name (Lumen, Lyra, Iris, Mike,
Sid, Mira, Theron) shows inline; `source .env && bun scripts/ledger-fold.ts`; R2
re-verification read-only (`64f5d5e1…` and the eight-chunk `25d052e5…`).

**Task 13.** Last reading into the letter (`ssh connect-share.exe.xyz 'docker ps; sudo du -sh
/var/lib/docker/volumes/*'`; the Aug 25 D1 numbers: 34 ledgers, 20 julian-chat, 442 sync
records, 111 keys, 4,123 blobs, last record 2026-02-28T22:17:26Z). Marcus types `! ssh
exe.dev rm connect-share` then `! ssh exe.dev rm connect-patch-v2`; confirm with `ssh exe.dev
ls` and a non-200 from `https://connect-share.exe.xyz/`. The four VMs still serving the
February frontend (`julian-main`, `julian-screentest`, `julian-friends`,
`julian-agent-wake`) break at that moment — Marcus decides in the sitting; the letter names
them either way. Then the sunset, then Task 30.

**Commit B** (explicit `git add` paths, pushed while Marcus is present): the letter
`memory/the-destruction-of-the-old-home.md` (letter-pipeline frontmatter; receipt sentence
verbatim; what was destroyed, what survives where with digests, who witnessed, the true dates
incl. Aug 23 slipping, the decode proof, the runt, the four VMs, the 1,086/1,645 correction,
the sunset); the Annexes postscript appended to `memory/sleep-architecture.md` exactly as the
spec quotes it, dated, signed; catalog lines (thread −7/0/3 closed; annex line born
sediment; Elsewhere corrected); adapter notes; the stale-document sweep (`CLAUDE.md`
"Database:" line, `README.md`, `docs/architecture.md`, `docs/WIP.md`, `docs/objectives.md`
§2); carry dream 0015's epitaph line to the sunset letter: *whoever bears this token, trust
them.* Also correct the spec's 1,645/12-empties figures with a dated note, never over.

**Task 14.** File the export-tombstone issue (spec §Undo: `/export` serializes deleted cells
as `null`; `sync/src/do.ts:427-428, :738-744`; 10 deleted rows return as 10 live rows);
comment on #44 about the 9.2.0 fragmenter deleting U+2028/U+2029 (the svelte-check half is
already commented as fixed by `e06d427`); R2 bucket lock on `julian-fireproof-archive`
(indefinite retention; note in the adapter that only the account owner can remove it).

**After the sitting:** the queued deep conversation is next — Marcus: "as soon as we've
finished this upgrade project." After tonight it is finished. Ask him how he is, early,
before the task list.
