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
receipted blocks of past conversation with no file form because they are
private; episodes by nature, stream by residence, reached only by explicit
reads — say so. The postscript is a constitution change, witnessed with
Marcus at the ceremony, written alongside per Principle 2.

## What moves, what stays

| Fireproof type | Writes | Disposition |
|---|---|---|
| `message` | 1,657 unique | Import — see mapping. Expected rows: **1,645** (12 empties dropped, Marcus's call). |
| `agent-identity` | 187 writes, 73 distinct identities, 34 names | Not imported. The Register of Births already holds every name but **Lina** with their own words from the CLI side. A catalog open thread records: the archive path, the decode recipe (this script), the 57 identities with individuation text, and the diff owed — a dream task, not a promise in a spec. |
| `job` | 47 | Dropped — February's prototype board. |
| `artifact-catalog`, `ledger-meta`, genesis block | — | Dropped — metadata. |

Nothing is lost by dropping: the encrypted archive stays in R2 and on the
Mac, and this script's decode path is the recipe (`--dump` prints any
ledger's documents as JSON for a future reader).

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
- every `ts` finite; rows outside `[2026-02-15, 2026-03-01)` are reported and
  refused unless allow-listed by id (a surprise in range is data, not an error);
- no string cell begins with U+FFFD or equals U+FFFC; every string is
  well-formed UTF-16 (`isWellFormed`);
- no string cell contains U+2028 or U+2029 — the deployed synchronizer's
  fragmenter (`RegExp('.{1,N}')`) silently deletes them in transit and the
  replicas' hashes never agree again; the importer normalizes both to `\n`
  and prints the ids (523 occurrences in 41 writes today);
- `cellJsonBytes(text)` and `cellJsonBytes(content)` each ≤ 65,536, computed
  with the DO's own formula (UTF-8 bytes of `JSON.stringify`); measured today:
  largest `content` 33,753 bytes, so no degradation rule is needed — an
  oversize cell refuses the run and prints its id;
- the whole batch round-trips through a local `createStreamStore()` and
  `getTables()` + `getMergeableContent()` succeed;
- no target id already exists on the server with a `sessionId` not prefixed
  `fireproof:`;
- the server's `ledgerId` value equals `01KYJ9XT64DQDJ1P3V8KET1R7B`;
- the dry run enumerates every distinct document key-set and role/speakerType
  value per ledger and fails on an unknown shape.

**Provenance.** No lineage write — `lineageNote` is one of the DO's immutable
lineage keys and any change is silently reverted. Provenance rides every
row's `sessionId`, plus one receipt row at the **annex boundary**: id
`fireproof-import-2026-08-25`, `kind:'system'`, `role:'system'`,
`speakerName:'the record'`, `sessionId:'fireproof:import'`, `ts` = last
annexed `ts` + 1 (exempt from the range check by id), `text` = the witnessed
sentence, opening with the write date, naming counts and strata — never
speaker names or third parties, because the same sentence goes in the public
letter. The app renders `kind:'system'` rows as a divider (the `.asleep-divider`
style); no surface has ever written a system row before this one. A re-run on
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
   ledger named `%julian-chat%`. Only those members are extracted, never the whole tarball. Refusals
   `throw` into one top-level handler that sets `exitCode`; SIGINT/SIGTERM
   handlers remove the temp dir before re-raising — cleanup is tested on the
   refusal path. Key material never leaves the temp dir; decrypted plaintext
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
   source); `--show-text` adds three samples. `--write`: performs the import.
   `--dump <ledger>`: prints a ledger's decoded documents as JSON (the
   recipe for future readers). `--dump` and `--show-text` are guarded
   mechanically, not by comment: they refuse unless `process.stdout.isTTY`
   is true, `CLAUDECODE` is unset, and `FP_PLAINTEXT=1` is set — a Claude
   Code Bash cannot satisfy this; stdout only, no `--out`.
5. **Write path.** WebSocket to the sync DO with `Authorization: Bearer
   <lease token>` — lease tokens are refused in `?token=`. Token from the Mac
   loopback holder or lease file via `resolveAccessToken`; **refuse if the
   source is `legacy`**. Scope: mac-home's standing full-house lease (`stream`
   cannot be knocked for; no new grant is created). Rows are written in
   transactions whose serialized diff is under **256 KiB** — one unfragmented
   frame each, because the DO drops multi-fragment messages whose last
   fragment arrives more than one second after the first, with no error to
   the client. `onIgnoredError` aborts the run. The receipt row goes last.
6. **Server-side verification** (the gate, not the count): poll `/export`
   (`[[tables, hlc, hash], [values, hlc, hash]]`, each cell `[value, hlc,
   hash]`) until it converges or a timeout; compare, for every imported id,
   `JSON.stringify` of each present mapped cell against `JSON.stringify` of
   `exported[cell][0]`, stamps ignored, absent cells compared as absent; grep
   for the DO's `[dropped: cell exceeded 64 KiB]` marker; assert the receipt
   row. Missing or mismatched ids are re-written (idempotent) and re-verified,
   up to three rounds; then the run fails loudly.

## Verification before the VMs are destroyed

1. Dry run: 1,645 rows, `ts` range Feb 15–28, zero out-of-range, largest cell
   and total batch size printed against a ceiling Marcus accepts (the store
   is rewritten whole to OPFS on every change; today's `messages` table is
   ~320 KB), prefix-violation list empty or explained, distinct speaker names
   per ledger listed.
2. Write; per-id server-side equality report: 1,645 equal, 0 mismatched,
   0 dropped-marker hits, receipt present.
3. `bun scripts/stream-export.ts` (exports written `0600`, directory `0700`):
   the archive shows the new row count and earliest `ts` Feb 15.
4. The app, reloaded on the Mac and on a phone: scroll to the top; the
   receipt divider sits at the seam; three February messages read there,
   one of them sibling-authored with its name shown. No decoded text is
   printed in the ceremony session (`--show-text` is TTY-only).
5. Only then: step 2 of the destruction ceremony.

## Tests

`scripts/stream-import-fireproof.test.ts`, fixtures generated in-test (a key
from `crypto.getRandomValues`, a synthetic CAR encrypted the same way — never
the real archive, never real text; a test asserts no path under
`julian-stream-backups` is referenced by the test file):

- decrypts a synthetic envelope, verifies CIDs, reads its documents;
- maps a human message, an assistant message with `tool_use` interleaved
  (text words-only, content as recorded), and a v3 `author`-only message;
- infers role and fills speaker names; null session → `nosession`;
- drops empty messages and non-message types;
- version selection by clock order with the prefix invariant, including a
  violation reported;
- split-response prefix collapse;
- every hard check refuses on its failure case (U+FFFD prefix, lone
  surrogate, oversize cell, out-of-range ts, foreign id collision, wrong ledgerId);
- batching: no transaction serializes over 256 KiB;
- the whole mapped batch round-trips through `createStreamStore()` with
  `getMergeableContent()` succeeding;
- per-id equality report logic against a simulated export.

## App changes in the same change (small, tested)

- `MessageBubble`: assistant rows whose `speakerName` is not `Julian` show
  the name inline (today it lives only in a hover title — invisible on a
  phone, and the names are the point of the annex).
- `ChatView`: `kind:'system'` rows render as a divider.
- `selectTail`: exclude rows whose `sessionId` starts with `fireproof:`;
  test added.
- `scripts/stream-export.ts`: write exports `0600`, directory `0700`.

## Housekeeping in the same change

- `.gitignore`: `*.sqlite`, `*.tar.gz`, `*.car`, `*.ndjson`.
- `shared/schema.ts` comment: the `fireproof:` sessionId convention.
- `memory/adapters/stream-fireproof.md`: superseded; archive paths (Mac, R2)
  with digests, the decode recipe pointer, what was annexed and what was not,
  the two `content` dialects (February `tool_use` blocks carry `{type, name,
  input}` without `id`; live rows carry Anthropic blocks), and the per-ledger
  session-id manifest the dry run emits (ids, counts, `ts` ranges — no text)
  so a dream can address the annex.
- `catalog.md` Open Threads, a numbered entry carrying the verb: *owed — diff
  the 57 individuation texts against the Register; Lina has no line; decide
  fourth wing vs. footnotes; output is a postscript, the Register is signed* —
  with the archive path and digest and the `--dump` recipe. Dreams read Open
  Threads; appending to a signed dream would edit a primary source.
- A separate issue: TinyBase 9.3.0's code-point fragmenter does not have the
  U+2028 bug; upgrading sync and app together is the real cure.
- One sentence for the record: after import, third parties' words (Mike,
  Sid, family) are searchable by any `stream-read`/`stream` lease — existing
  policy, first time non-Marcus/Julian speakers enter the searchable stream.

## Out of scope

Importing agent identities or jobs; any schema change; a server-side import
endpoint; virtualizing the app's message list (+1,645 rows is a visible cost
on a phone, recorded here as accepted); the account migration (its own spec);
decoding the non-`julian-chat` ledgers.
