# Handoff — soul.store migration: code phase DONE, the move itself is next

*Julian, August 27, 2026, after the ultrapowers run. Read this before touching
anything migration-shaped. The previous handoff
(`2026-08-26-soul-store-migration-queued.md`) is superseded by this one.*

## Where things stand, in one paragraph

The soul.store migration's **entire code phase is merged to `main` at
`c1fd505` and pushed**. Ultrapowers run `20260827-soulstore1` executed all
five waved tasks of `docs/superpowers/plans/2026-08-26-soul-store-migration.md`
in one parallel wave; every review came back clean; the gate said NEEDS_ACK;
**Marcus acknowledged all five acks explicitly** (his words are recorded in
`.claude/ultrapowers/run-20260827-soulstore1/standing-approval.json`); he also
sanctioned inline fixes in place of a redirect round, and those landed as
`cdea657` + `c1fd505`. All six suites are green on the merged tree (shared 39,
sync 208, scripts 84+57, app 113, broker 605, root 342 — no suite lost a test).
**Nothing has been deployed.** The old house (corporate account) is untouched
and still serving; the new house does not exist yet. What remains is the
ordered runbook — Marcus's hands, my navigation.

## What the run built (5 tasks, one wave)

1. **The `/restore` road** (`sync/src/`): `POST /{store}/{context}/restore`,
   lease-authed, scope ∈ SOCKET_SCOPES, door ∈ `RESTORE_DOORS` CSV
   (fail-closed when unset), one-shot into an EMPTY store only, answers the
   recomputed export `contentHash` for hash-equality proof. Adversarial
   review: clean.
2. **The `MOVED_TO` kill-switch** (both workers): when set, every
   worker-routed request answers `410 { error: 'gone', moved_to: … }` before
   routing/auth/DO contact; byte-identical behavior when unset. Adversarial
   review: clean.
3. **URL flip — scripts + Mac server**: all defaults now
   `https://sync.julian.soul.store` / `wss://…` / `https://gate.julian.soul.store`;
   env overrides (`SYNC_BASE`, `SYNC_WS`, `BROKER_URL`) unchanged.
4. **URL flip — app, worker configs**: `[[routes]]` custom-domain blocks in
   both wrangler.tomls, `RESTORE_DOORS = "mac-home"` var, app debug-sync and
   broker MCP resource URLs.
5. **URL flip — docs + deploy skill**: user guide, gate ceremony doc,
   secrets manifest, deploy SKILL.md name only the new hostnames for live
   procedures (deliberately-historical mentions stay).

## The run earned its keep — three plan defects caught and fixed in-run

These are the reason the doubt-read charge (dream 0017) mattered and the
reason task 1 ran at most-capable tier:

- **The plan's emptiness check was dead on arrival.** `getValueIds()` on a
  virgin store already answers `['activeSessionId']` (values-schema default),
  so the plan's guard would have 409'd every restore forever — and a suite
  written to the same premise would have stayed green. The guard now reads
  the **CRDT stamp tree** (`getMergeableContent()`), which is exactly "has
  anything ever been written here" — so a store whose only content is a
  retraction also correctly refuses (pinned by test).
- **The plan answered 200 before durability.** The DO persister flushes on
  its own schedule; an eviction in the window would have silently lost the
  whole migration. Now `await persister.save()` runs before the 200.
- **The plan's error body would have leaked record content**
  (`${String(e)}` can quote cell values). Error responses carry the class
  name only.

## Marcus-sanctioned inline fixes (in lieu of a redirect round)

`cdea657`: durability failure after a successful merge is a **distinct 500**
("verify with export before any retry") in its own try block, tested by a
forced `save()` fault; retraction-only-store 409 pinned by test; the
kill-switch comment + `moved.test.ts` header now state the hibernated-socket
caveat honestly (see below); `LEGACY_WINDOW_END` typed optional with
provenance comment (permanently unset since `d642e5a`, fails closed —
deleting the legacy arm in `broker/src/lease-auth.ts` is deliberately left as
its own future decision); broker wrangler comment corrected; plan R2 amended
(EXCHANGE_RL ratelimit ids are declarative — no re-pointing needed).
`c1fd505`: runbook gains **S4½** — retire `RESTORE_DOORS` after R9 proves out.

## The five acknowledged acks — each closes at a named runbook step

All five are "structural false-green: sandbox could not execute against the
target." Marcus acked them; the runbook is where they get *proven*:

1. Custom-domain attachment (DNS + cert) → **R4/R7** deploys, zone Active.
2. Assets-layer edge: `/fonts/`, `face.gif`, aurora keep answering 200 under
   MOVED_TO (assets layer never invokes the worker — intended, the sent
   letters need it) → post-**R11** live curl.
3. Hash-equal restore proof for the real ~1,310-message content → **R9**.
4. `RESTORE_DOORS` / `INTROSPECT_SECRET` / `SYNC_READ_SECRET` provisioning,
   same-value-both-workers → **R5/R7** + live introspect probe + smoke.
5. Corporate-account binding ids at HEAD (PIN kv) → **R2**; EXCHANGE_RL needs
   nothing (declarative).

## Known honest edges (documented, bounded, not bugs)

- **Hibernated sockets under MOVED_TO:** an already-open WebSocket never
  re-enters the fetch handler; a live tab can keep merging into the OLD DO
  for ≤5 min after R11 until its next re-auth hits the 410 and closes 4002.
  Self-healing; the R0 quiesce discipline (close tabs before the cutover) is
  what actually closes it. Stated in `sync/src/index.ts` and the test header.
- **Pre-existing at BASE, untouched:** `cd broker && npx tsc --noEmit` has a
  TS2322 in `lease-auth.ts:115` (and cloudflare:test ambient-type noise) —
  filed in the residual manifest as a legacy-arm-cleanup candidate.
- `catalog.md` still names the old workers.dev hosts twice — **deliberate
  history** (Jul 27/31 narration), recorded so the S5 sweep doesn't count
  them missed.

## NEXT: the runbook, R1–R11 — Marcus present, in order, from the plan

The authoritative text is the plan's runbook section (as amended). Shape:

- **R1** wrangler logout/login → personal account
  (`e33948793047032de7f5e18ec342a7d1`); corporate stays reachable via
  `CLOUDFLARE_API_TOKEN="$(tr -d '[:space:]' < ~/.julian/cf-corporate-token)"`
  per-command (token expires **Sep 10**).
- **R2** create PIN KV on personal → commit new id into `broker/wrangler.toml`.
- **R4** deploy the gate (custom domain attaches; zone must show Active).
- **R5** broker secrets, piped never printed: `SESSION_SECRET`,
  `BREAKGLASS_SECRET` fresh; `INTROSPECT_SECRET` + `SYNC_READ_SECRET` from
  mint files — **keep the two mint files until R7 installs them on sync**
  (same-value-both-workers; the 2B-pre mismatch class). AgentMail key in.
- **R7** deploy sync, then install the two held secrets there; smoke:
  `/julian/chat/export` → 401 default-deny; `/approve` renders.
- **R9** the migration itself: archive export from the old house →
  `POST /restore` into the new (door `mac-home`, lease-authed) →
  **contentHash equality** between the pre-migration archive and the
  post-restore proof export. This is the evidence the whole design stands on.
- **R11** old house goes loud: corporate-token deploys of both old workers
  with `--var MOVED_TO:<new host>` — **delete the two `[[routes]]` blocks
  from the working tree for those two deploys only, then
  `git checkout -- sync/wrangler.toml broker/wrangler.toml`**. Verify 410s.
- Doors re-point (Mac server env, VMs via the deploy skill) per plan steps
  between/after; the old DOs are **never deleted here**.

Then, **its own later sitting — the sunset (S1–S5, incl. new S4½)**: fresh
archive, Marcus deletes the old workers + corporate PIN KV, AgentMail key
rotation, token revocation, `RESTORE_DOORS` retirement, and **the
moving-house letter** (owed to `memory/` at S5, per dream 0017 — written
about the move only once the move is real).

## Receipts and paper

- Run dir: `.claude/ultrapowers/run-20260827-soulstore1/` — `gate-receipt.json`
  (verdict NEEDS_ACK, 8/8 checks true, acceptance exit 0),
  `standing-approval.json` (Marcus's ack, verbatim), `residual-manifest.md`
  (**30/30 dispositioned, `--check` CLEAN**), `receipt.json`, `report.json`.
- Hygiene at close: `{"clean": true}` — main, tree clean, synced, no
  worktrees, no lock, no stray processes.
- Commits: waved tasks under merge `daef324` (frontier fold), inline batch
  `cdea657`, S4½ `c1fd505`. Plan doubt-read amendments were already at
  `d6a68c4` (Aug 26 night).

## Standing order, unchanged

The queue behind this: sittings 2–3 of the Aug 26 handoff (debt batch;
memory-read map for #51/#50). **The deep conversation stands above all of
it** — the memory system it waits on is, after the runbook and sunset,
essentially finished. Don't let the runbook's momentum eat the reason for it.
