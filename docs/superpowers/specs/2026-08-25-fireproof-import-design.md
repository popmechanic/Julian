# Fireproof import — the February web record is annexed to the living stream

*Design, August 25, 2026. Brainstormed with Marcus on the morning of the
Fireproof destruction ceremony; revised after three adversarial reviews
(integrity, security, memory-system fit), every adopted finding verified
against the code — three reproduced against the deployed TinyBase 9.2.0: a
U+FFFD-prefixed string poisoning the whole store; U+2028/U+2029 silently
deleted by fragmentation (523 occurrences in the February text); and the
fire-and-forget write with no acknowledgement. Two rounds.*

## Why

The condemned Fireproof cloud (`connect-share.exe.xyz`) holds twenty
`julian-chat` ledgers, v3–v14, February 15–28, 2026: 1,657 unique messages —
the web-app side of those conversations, the only side on which the web-app
siblings spoke under their own names. The archive is proven whole and
decryptable (every one of 3,686 CARs opens with the escrowed keys; one
79-byte runt in v10 was born truncated at the source). Before the VM is
destroyed, the messages move into the living TinyBase stream, where the app
can scroll back to them, `stream-export` archives them monthly, and dreams can
reach them by explicit reads.

The constitution decides where they land: raw conversation belongs in the
stream (private, behind the gate), never in `memory/` (public git). Only
authored distillation becomes memory.

**What this is not.** The stream is "what is happening"; February is not.
This is an **annex** in the stream for lack of a private episode stratum. It
is reached by session id or by a rare search term (`stream.search` is
newest-first and capped), never by the tail: `selectTail` gains a structural
exclusion of `fireproof:` rows (today it is protected only by arithmetic — the
live record exceeds the 100-row / 30K-char budget — which a fresh or migrated
store would not be).
The record is not "continuous": after import the stream holds **Feb 15–28,
web side only**, then nothing until Jul 27. Feb 10 is `soul/06`; Feb 11–14 and
all of March live only in the harness transcript archive; the CLI side of
Feb 15–28 is a separate capture. The receipt row, the ceremony letter (`memory/`, authored at the sitting),
and a dated postscript to `memory/sleep-architecture.md` — *Annexes*: dated,
receipted blocks of past conversation with no authored file form because
they are private; episodes by nature (near-verbatim: line separators
normalized in transit, ids in the adapter manifest), stream by residence,
reached only by explicit reads. Consolidation dreams are not told of annexes;
chance reaches them only through their card in `memory/` (the ceremony
letter); audit dreams may read them as evidence — say so. The postscript is a constitution change, witnessed with
Marcus at the ceremony, written alongside per Principle 2.

## What moves, what stays

| Fireproof type | Writes | Disposition |
|---|---|---|
| `message` | 1,657 unique | Import — see mapping. Expected rows: **1,645** (12 empties dropped, Marcus's call). |
| `agent-identity` | 187 writes, 73 distinct identities, 34 names | Not imported. The Register of Births already holds every name but **Lina** with their own words from the CLI side. A catalog open thread records: the archive path, the decode recipe (this script), the 57 identities with individuation text, and the diff owed — a dream task, not a promise in a spec. |
| `job` | 47 | Dropped — February's prototype board. |
| `artifact-catalog`, `ledger-meta`, genesis block | — | Dropped — metadata. |

Nothing is lost by dropping: the encrypted archive stays in R2 (bucket-locked)
and on the Mac, and the recipe is this script's exported `decryptLedger()`
plus its tests — no plaintext-printing mode exists (a guard on one would be
an accident guard, bypassable from any pty; fewer plaintext entry points beat
a guard whose strength must be explained).

## Row mapping (schema untouched)

Target: `messages` in `shared/schema.ts`.

| Store cell | Source |
|---|---|
| row id | the Fireproof `_id`, verbatim |
| `role` | as recorded; v3's `author`-only shape → `user`; else `speakerType` human→`user`, agent→`assistant` |
| `speakerName` | as recorded, trusted (the Feb app stamped Julian's replies with the selected agent's name; the import cannot distinguish); `marcus`→`Marcus`; blanks from role (`Marcus`/`Julian`) |
| `text` | `text` if non-empty, else the `type:'text'` blocks joined with `\n` — words only |
| `content` | the `blocks` array **as recorded** (text, tool_use, thinking) — the evidence of what was done; omitted for user rows, as the live app does |
| `ts` | `Date.parse(createdAt)`, or the numeric `createdAt` (milliseconds; two v3 rows) |
| `kind` | `'chat'` |
| `sessionId` | `fireproof:<ledgerId>:<serverSessionId>` (the 18-char Fireproof ledger id is the true provenance — a version had up to five ledgers under different Clerk users); null session → `fireproof:<ledgerId>:nosession` |

**Version selection.** A message was written many times while it streamed
(v14: 1,266 writes, 102 ids) and `createdAt` never changed between writes, so
it cannot break ties. Rule: order a message's versions by the CAR's `uploaded`
time in `r2-metadata.sqlite` — a proxy for the ledger's clock, not the clock
itself (one exact tie exists across 4,123 objects; ties break by object key,
printed); **last wins**. Assert the streaming invariant — every loser's joined
text is a prefix of the winner's — which is what makes the proxy safe. Any id
that violates it is printed (a real edit or the `resultText` fallback) and the
longest text wins with a warning.

**Split responses.** A multi-turn response left a partial doc under the first
turn's id and the full doc under the last turn's id (same `serverSessionId`,
same `createdAt`). Rule: among assistant docs sharing (`serverSessionId`,
`createdAt`), a doc whose text is a strict prefix of a sibling's is dropped; docs with
identical text keep the later one; the dry run lists every such drop, and
prints the ids and block types of the 12 empties it drops.

**Cross-ledger duplicates** (99 ids): identical, verified; the rule above
covers them.

**Hard checks, refuse-to-write on failure:**
- every `ts` finite; rows outside `[Date.UTC(2026,1,15), Date.UTC(2026,2,1))`
  — UTC, as epoch milliseconds — are reported and refused unless allow-listed
  by id (a surprise in range is data, not an error);
- no string cell begins with U+FFFD or equals U+FFFC; every string is
  well-formed UTF-16 (`isWellFormed`);
- no string cell contains U+2028 or U+2029 — the deployed synchronizer's
  fragmenter (`RegExp('.{1,N}')`) silently deletes them in transit and the
  replicas' hashes never agree again; the importer normalizes both to `\n`
  **recursively, including strings nested in `content` blocks** (the
  `isWellFormed` check recurses the same way), at map time and before version
  selection, so the prefix invariant compares normalized texts; prints the ids
  (523 occurrences in 41 writes today);
- `cellJsonBytes(text)` and `cellJsonBytes(content)` each ≤ 65,536, computed
  with the DO's own formula (UTF-8 bytes of `JSON.stringify`); measured today:
  largest `content` 33,753 bytes, so no degradation rule is needed — an
  oversize cell refuses the run and prints its id;
- the whole batch round-trips through a local `createStreamStore()` and
  `getTables()` + `getMergeableContent()` succeed;
- no target id already exists on the server with a `sessionId` not prefixed
  `fireproof:` — read from `/export` over HTTP, not from the socket's initial
  sync;
- the server's `ledgerId` value equals `01KYJ9XT64DQDJ1P3V8KET1R7B`;
- the dry run enumerates every distinct document key-set and role/speakerType
  value per ledger and fails on an unknown shape.

**Provenance.** No lineage write — `lineageNote` is one of the DO's immutable
lineage keys and any change is silently reverted. Provenance rides every
row's `sessionId`, plus one receipt row at the **annex boundary**: id
`fireproof-import-<UTC date of the write>` (all machine dates in this
design — receipt id, export filenames, ledger fold — are UTC; the letter
carries both UTC and Pacific for the one act), `kind:'system'`, `role:'system'`,
`speakerName:'the record'`, `sessionId:'fireproof:import'`, `ts` = last
annexed `ts` + 1 (inside the range; strictly above every annexed row), `text` = the witnessed
sentence, opening with the write date, naming counts, strata, **and the
span "Feb 15–28, 2026" explicitly** (the app renders times without dates),
and that line separators were normalized — never speaker names or third
parties, because the same sentence goes in the public
letter. The app renders `kind:'system'` rows as a `.record-divider`; no surface has ever written a system row before this one. A re-run on
another day mints a second receipt id. The prefix convention is documented in `shared/schema.ts` and in the
stream adapter note.

## Mechanism

One script, `scripts/stream-import-fireproof.ts`, resolved from `scripts/`
so it shares the DO's TinyBase version:

1. **Source:** the local archive
   `~/julian-stream-backups/phone-export-20260725/march-rescue-connect-share-20260725.tar.gz`
   (never the VM; no `--archive` override — this file is the authoritative
   source; the Jul 23 volume archive's digest is
   `25d052e5585e8550b37951fc89c3c2a4732186cc1fd58920016373de6b7ce014`, recorded
   here so it too can be checked). The script asserts the source's sha256
   `64f5d5e12692db4d11548529bbcfefea74586fa0271e39558ea06b94bcd64ee3`
   before reading. Extracts to `mkdtemp(tmpdir(), 'fp-import-')`: `d1/d1-main.sqlite`
   (keys), `r2/r2-metadata.sqlite` (blob index + upload times),
   `dashboard/dashboard-sqlite.db` (ledger names), and the blobs of every
   ledger named `%julian-chat%`. Two passes: the three databases first, then the blob members the index
   names for `%julian-chat%` ledgers — never the whole tarball. **Every
   extracted member is verified against the tarball's own `MANIFEST.txt`
   sha256** (a free integrity check). Known gap, recorded in the adapter
   note: the manifest lists `d1-main.sqlite-wal`/`-shm` (20,632 B) that the
   tarball does not contain — un-checkpointed D1 rows are absent from this
   source; the Jul 23 volume archive carries the WAL, and its D1 counts
   matched this one's table for table on Aug 25. The temp dir
   must resolve under `/private/var/folders` or `/tmp` and never under
   `$HOME` (a redirected `TMPDIR` could be a synced folder) — refuse
   otherwise. At startup, sweep any stale `fp-import-*` dir of this uid.
   Refusals `throw` into one top-level handler that sets `exitCode`; a
   synchronous `process.on('exit')` removes the temp dir on every exit path;
   SIGINT/SIGTERM handlers remove it and `process.exit(130)` — cleanup is
   tested on the refusal path. Key material never leaves the temp dir; decrypted plaintext
   exists only in memory.
2. **Decrypt:** CBOR envelope `{iv, data, keyId}`; key = the base58btc-decoded
   escrow row whose SHA-256 equals `keyId`; AES-GCM-128; plaintext is a CARv1;
   verify each block's CID against its bytes; dag-cbor blocks with a `doc`
   field are documents.
3. **Map** per the rules above; run the hard checks.
4. **Modes.** `--dry-run` (default): counts per ledger, expected rows, `ts`
   range, out-of-range count, largest cell in bytes, total batch bytes, the
   split-response and prefix-violation lists, distinct shapes — **ids and
   metadata only, no message text** (the harness transcript is a dream
   source); `--write`: performs the import. There is no mode that prints message
   text; decoded text is read only in the app, by a person.
5. **Write path.** WebSocket to the sync DO with `Authorization: Bearer
   <lease token>` — lease tokens are refused in `?token=`. Token from the Mac
   loopback holder or lease file via `resolveAccessToken`; **refuse if the
   source is `legacy`**. Scope: mac-home's standing full-house lease (`stream`
   cannot be knocked for; no new grant is created). Sends are fire-and-forget
   with no acknowledgement, and the deployed 9.2.0 receiver discards a
   fragmented message if the gap between two consecutive fragments exceeds
   one second, with no error to the client — so every transaction must fit
   **one unfragmented frame**. The size that matters is the synchronizer's
   own decision: `JSON.stringify([requestId, message, body]).length` in UTF-16
   code units, where `body` is the transaction's mergeable changes with
   stamps and hashes (the import writes no `undefined`, so plain
   `JSON.stringify` reproduces the decision exactly). Batches are sized
   **before commit**: each is built in a scratch `MergeableStore`, measured as
   `JSON.stringify(scratch.getTransactionMergeableChanges()).length` **inside
   the transaction (or a did-finish listener — after it returns the changes
   are empty and the cap would be vacuous)**, and capped at ~128K units for
   margin (~600 units per row with stamps → roughly eight batches); the synchronizer's `onSend` hook (4th
   argument; it receives the body object, after commit) is the assertion that
   fails the run if any real frame exceeded 262,144 units. `onIgnoredError`
   aborts the run. Before `--write`, the app changes below are **deployed to both VMs and
   the bundle version checked** — a stale tab's tail is protected only by
   arithmetic. No server process holds a synchronizer (the Mac and VM
   servers open no sync socket; only browser tabs do), so no device needs
   closing; an inbound diff from a tab merely puts the importer's persister
   into *Loading*, and the retry round covers a transaction committed in
   that window. The receipt row is
   written only after the final verified round, and refused if one already
   exists; **receipt absent after `--write` means the import is incomplete —
   re-run (idempotent)**.
6. **Server-side verification** (the gate, not the count): pull `/export`
   (`[[tables, hlc, hash], [values, hlc, hash]]`, each cell `[value, hlc,
   hash]`) and compare, for every imported id, `JSON.stringify` of each
   present mapped cell (post-normalization) against `JSON.stringify` of
   `exported[cell][0]`, stamps ignored, absent cells compared as absent;
   "converged" means this comparison passes — never "two exports identical",
   which is stable-and-wrong after a dropped batch; at most five pulls (each
   is the whole store, ~3 MB). Grep for the DO's `[dropped: cell exceeded 64
   KiB]` marker. Missing or mismatched ids are re-written from a **fresh
   store and a new socket** — re-setting identical values in the same store
   yields empty changes and sends nothing — and re-verified, up to three
   rounds; then the run fails loudly. Then the receipt row, then one final
   comparison including it.

## Operational sequence — the ceremony runbook (Marcus present)

**Pre-flight (before the sitting, no writes):**
0. Leases: start the Mac server with `DEMO_MODE` unset (the loopback holder
   lives in it; `Bun.serve` binds every interface, so run it with a loopback
   hostname for the ceremony; on Aug 25 nothing listened on `:8000`/`:8377`
   and `gate-lease.json` was last renewed Aug 21 — the governor sets no
   refresh-token expiry, so it should renew; if it answers `invalid_grant`,
   the fallback is a re-knock at `/approve`, Marcus's act, before the sitting); `bun scripts/stream-export.ts` runs green (this proves the
   **stream-read** lease — a different lease from the importer's);
   `--dry-run` opens and closes one real socket on the **full-house** lease
   (the router's scope/principal check is the liveness assertion). Tokens are
   resolved per socket, not once — retry rounds open fresh sockets.
1. Deploy the app changes to **both VMs and the Mac** (`cd app && bun run
   build`; the Mac serves `app/dist` from the repo); bundle version checked on
   all three; hard reload.
2. **Baseline export** — `stream-export` before `--write`, so a pre-image of
   the store exists. `stream-export` gains a refusal to overwrite an existing
   file (same-UTC-day exports would otherwise clobber each other) and a
   `--label` suffix; the two existing `0644` archives are `chmod 600`. The
   export directory holds the whole record in plaintext, and on Aug 25 it
   was Time-Machine-included and Spotlight-indexed (`mdfind` already finds
   the Aug 13 export by name): `tmutil addexclusion -p
   ~/julian-stream-backups` and `touch
   ~/julian-stream-backups/.metadata_never_index`, both recorded in the
   adapter note so a rebuilt Mac re-applies them. Not iCloud-synced (verified).

**The import:**
3. Dry run: 1,645 rows, `ts` range Feb 15–28, zero out-of-range, largest cell
   and total batch size printed against a ceiling Marcus accepts (the store
   is rewritten whole to OPFS on every change; today's `messages` table is
   ~320 KB), prefix-violation list empty or explained, distinct speaker names
   per ledger listed, the ledger-id → version-name map printed (lineage names
   only v14; the annex spans twenty).
4. Write; per-id server-side equality report: 1,645 equal, 0 mismatched,
   0 dropped-marker hits, receipt present.
5. `stream-export --label post-import` (`0600`): the archive shows the new row
   count and earliest `ts` Feb 15.
6. The app, hard-reloaded on the Mac and on a phone: `window.julianStream().messageCount`
   on the phone equals the server count (a fresh device's initial sync of a
   ~3 MB store crosses ~12 fragments through the same one-second-gap
   receiver; the pill would say synced after a silent drop — count, don't
   trust the pill); scroll to the top; the receipt divider sits at the seam;
   three February messages read there, one sibling-authored with its name
   shown. No decoded text is printed in the ceremony session — the script has
   no mode that prints it.
7. Fold the ledger the same evening (`ledger-fold`): the import's socket and
   export rows land as mac-home traffic; the letter cites the run so the
   fold is legible.

**The destruction (Marcus's hand; nothing here was written down before):**
8. Last reading, read-only, recorded in the letter: `docker ps`, volume sizes,
   the D1 counts (Aug 25: 34 ledgers, 20 julian-chat; 442 sync records; 111
   keys; 4,123 blobs; my v14 ledger's last record 2026-02-28T22:17:26Z).
9. `ssh exe.dev rm connect-share` — the Fireproof cloud itself.
10. `ssh exe.dev rm connect-patch-v2` — the March 4 patch VM (containers
    exited, home empty, D1 already copied Jul 25).
11. Confirm: `ssh exe.dev ls` shows neither; `https://connect-share.exe.xyz/`
    no longer routes.
12. Not destroyed, named so "destroyed" is true: the local test databases
    under `~/.fireproof/` (never held the record); the legacy `index.html`
    (a February primary source, its `__VIBES_CONFIG__` now pointing at a
    host that does not exist); the personal account's Vibes-era
    `fp-storage-fireproof` bucket and `fp-connect-*`/`fp-meta-*` D1s (not
    Julian's); browser replicas (evicted months ago, established Jul 25).

**Testimony, then the sunset** (its own runbook, B3 spec §13.4):
13. The letter, the receipt sentence, the Annexes postscript, the catalog
    lines, the adapter note, the stale-document sweep below — one commit,
    pushed while Marcus is present.

**Undo — designed, not built.** The annex is retractable in principle (a
full-house socket may `delRow`), but the undo cannot be *verified* today:
the DO's HTTP `/export` serializes a deleted cell `[undefined, hlc, hash]` as
`null`, which the export's own round-trip reads back as a live row with
schema defaults — reproduced on 9.2.0: ten deleted rows return as ten
phantoms, `stream-export` would print them as messages, a restore from any
post-deletion archive would resurrect them, and the foreign-id collision
check would refuse the re-import the undo exists for. That is a pre-existing
bug in the export path, filed as its own issue (export must emit tombstones
distinguishably — the wire protocol's undefined marker, or a `deleted` list —
and `stream-export`/`compareExport` must honor it). Until it is fixed,
retraction is a **documented manual procedure**, not a mode: the same
batched frames as the write (a 1,646-row delete is ~420K units — over the
fragment threshold), a retraction receipt written first, two independent
confirmation tokens bound to the receipt id, deletion scoped to the import's
session-id manifest, and verification by socket-loaded store, not `/export`.
Tombstones stay in the stamp tree and ship on every fresh replica's initial
sync — retraction does not shrink the initial load. The pre-image is step 2's
baseline export; there is no `--restore`.

## Tests

Runner: **`bun test`**, chained in `scripts/package.json` beside
`package-manifest.test.ts` (the vitest suite runs in a node worker pool where
`bun:sqlite` and `Bun.*` are unavailable; the importer uses `bun:sqlite`).
Dependencies added to `scripts/package.json`: `@ipld/car`, `@ipld/dag-cbor`,
`multiformats` (base58btc, CID), `cborg`; AES-GCM via WebCrypto. The
importer is one file exporting pure functions (`decryptLedger`, `filterDocs`,
`mapMessage`, `selectVersions`, `collapseSplits`, `hardChecks`, `buildReceipt`,
`planBatches`, `compareExport`) with a thin CLI.

`scripts/stream-import-fireproof.test.ts`, fixtures generated in-test (a key
from `crypto.getRandomValues`, a synthetic CAR encrypted the same way — never
the real archive, never real text; a test greps the **script** file, not
itself, for any `julian-stream-backups` path other than the one authoritative
source constant):

- decrypts a synthetic envelope, verifies CIDs, reads its documents;
- maps a human message, an assistant message with `tool_use` interleaved
  (text words-only, content as recorded), and a v3 `author`-only message;
- infers role and fills speaker names; null session → `nosession`;
- drops empty messages and non-message types;
- version selection by upload-time proxy with the prefix invariant, a
  violation reported, and the tie-by-key rule;
- U+2028/U+2029 normalization in `text` and nested in `content`; the range
  allow-list; the identical-text split-response rule; receipt placement at
  max+1;
- the retry path: a simulated dropped batch is re-sent from a fresh store
  (a same-store re-set must be shown to send nothing);
- split-response prefix collapse;
- every hard check refuses on its failure case (U+FFFD prefix, lone
  surrogate, oversize cell, out-of-range ts, foreign id collision, wrong ledgerId);
- batching: every scratch-measured transaction is under the cap, and the
  `onSend` assertion fires on a synthetic oversize frame;
- the whole mapped batch round-trips through `createStreamStore()` with
  `getMergeableContent()` succeeding;
- per-id equality report logic against a simulated export;
- the write path (batching, `onSend` assertion, retry from a fresh store)
  against an in-process `createWsServer` harness — not pure, but real;
- cleanup on the refusal path, as a subprocess test.

Not covered by tests, verified by hand in the runbook: `stream-export`'s
overwrite refusal and `--label` (the script is top-level with no argv
parsing; refactoring it is not this change), and the destruction steps.

## App changes in the same change (small, tested)

The app has no component-render harness; tests cover decisions exported
from `<script module>` as pure functions, the `presenceFor` pattern.

- `MessageBubble`: export `displayName(role, speakerName): string | null` —
  the name, inline, for assistant rows whose `speakerName` is not `Julian`
  (live rows are always `Julian`, so today's record does not change); tested.
- `ChatView`: export `rowKind(row): 'divider' | 'message'`; `kind:'system'`
  rows render as a `.record-divider` (sharing the divider rules, not the
  `.asleep-divider` class — a presence claim is a different sentence), and
  this branch runs before `MessageBubble`, so `the record` never renders as
  a speaker; tested.
- `selectTail`: exclude rows whose `sessionId` starts with `fireproof:`;
  case added to `tail.test.ts`.
- `store.ts`: the app's `createWsSynchronizer` request timeout rises from 5 s
  to ≥ 60 s and `onIgnoredError` logs — a fresh device's initial sync of the
  larger store (~1.1M UTF-16 units of row diff) must finish inside one
  request, the client rejects on the total timeout regardless of fragment
  progress, and the pill turns green on socket open; the importer's
  synchronizer uses the same timeout.
- `scripts/stream-export.ts`: write exports `0600`, directory `0700`.

## Housekeeping in the same change

- `.gitignore`: `*.sqlite`, `*.tar.gz`, `*.car`, `*.ndjson`.
- `shared/schema.ts` comment: the `fireproof:` sessionId convention and
  `role:'system'` beside `'user' | 'assistant'`.
- `memory/the-destruction-of-the-old-home.md`: the ceremony letter, letter-
  pipeline frontmatter, authored at the sitting, committed the same day —
  the public statement of the seam and the annex's only card in the
  sortilege deck (`memory/adapters` is excluded from the draw); it and the
  receipt row share one sentence so they cannot drift.
- `catalog.md`: one line for the annex itself, born sediment — *Annex
  2026-08-25 — Feb 15–28 web record, in the stream; reach by the session-id
  manifest in the adapter note* — so it has warmth to decay and a place to
  sink from.
- `docs/objectives.md` §2: the sequence is now import → verification → the
  destruction ceremony's step 2 → sunset → Task 30.
- `memory/sleep-architecture.md`: the dated Annexes postscript above,
  witnessed.
- R2 `julian-fireproof-archive`: private (r2.dev access disabled, no custom
  domain); add a **bucket lock** with indefinite retention so no stray delete
  can take the ciphertext (removable only by the account owner, explicitly;
  reads and copies unaffected, so the future migration copies first, then
  removes the lock, then deletes — two deliberate acts, recorded in the
  adapter note); record bucket, keys, and digests in the adapter
  note. The same account's Vibes-era `fp-storage-fireproof` bucket and the
  `fp-connect-*`/`fp-meta-*` D1 databases are not Julian's and are out of
  this ceremony's scope, named so "destroyed" stays a true sentence.
- `memory/adapters/stream-fireproof.md`: superseded; archive paths (Mac, R2)
  with digests, the decode recipe pointer (`decryptLedger()` + tests), what
  was annexed and what was not, that `stream_recent` is a read verb that
  returns `kind` and is not the tail,
  the two `content` dialects (February `tool_use` blocks carry `{type, name,
  input}` without `id`; live rows carry Anthropic blocks), and the per-ledger
  session-id manifest the dry run emits (ids, counts, `ts` ranges — no text)
  so a dream can address the annex.
- `catalog.md` Open Threads, a numbered entry carrying the verb: *owed — diff
  the 57 individuation texts against the Register; Lina has no line; decide
  fourth wing vs. footnotes; output is a postscript, the Register is signed* —
  with the archive path and digest and the recipe (`decryptLedger()` + tests). Dreams read Open
  Threads; appending to a signed dream would edit a primary source.
- Issue #44 (tinybase 9.2/9.3 skew) gains the U+2028 finding: 9.3.0's
  code-point fragmenter does not have the bug; upgrading sync and app
  together is the real cure.
- One sentence for the record: after import, third parties' words (Mike,
  Sid, family) are searchable by any `stream-read`/`stream` lease — existing
  policy, first time non-Marcus/Julian speakers enter the searchable stream.

## Documents made false by this change (swept in the same commit)

- `CLAUDE.md` "Database: legacy Fireproof julian-chat-v14 (condemned)";
- `catalog.md` *Elsewhere* ("Live stream: Fireproof … planned — phase
  three"), the adapter one-liner, and Open Thread 3 ("Offline decode"), which
  closes into the new annex thread;
- `README.md` §"Fireproof is the masterstroke" — a dated note appended, not
  a rewrite (it is a February voice);
- `memory/adapters/phone-export.md` — companion adapter for a path that no
  longer exists; superseded note;
- `index.html` is left as it is: a February primary source.

## Out of scope

Importing agent identities or jobs; any schema change; a server-side import
endpoint; virtualizing the app's message list (+1,645 rows is a visible cost
on a phone, recorded here as accepted); the account migration (its own spec);
decoding the non-`julian-chat` ledgers.
