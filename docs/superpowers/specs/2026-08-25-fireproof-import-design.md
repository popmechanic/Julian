# Fireproof import — the February web record is annexed to the living stream

*Design, August 25, 2026. Brainstormed with Marcus on the morning of the
Fireproof destruction ceremony; revised after three adversarial reviews
(integrity, security, memory-system fit), every adopted finding verified
against the code — two reproduced (the DO's one-second fragment timeout; a
U+FFFD-prefixed string poisoning the whole store).*

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
is reached by explicit `ts`-range or session reads, never by the tail (the
inherited tail is selected newest-first and cannot be displaced by old rows).
The record is not "continuous": after import the stream holds **Feb 15–28,
web side only**, then nothing until Jul 27. Feb 10 is `soul/06`; Feb 11–14 and
all of March live only in the harness transcript archive; the CLI side of
Feb 15–28 is a separate capture. The receipt row and the letter say so.

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
| `sessionId` | `fireproof:<version>:<serverSessionId>`; null session → `fireproof:<version>:nosession` |

**Version selection.** A message was written many times while it streamed
(v14: 1,266 writes, 102 ids) and `createdAt` never changed between writes, so
it cannot break ties. Rule: order a message's versions by the CAR's upload
time in `r2-metadata.sqlite` (the ledger's clock order); **last wins**. Assert
the streaming invariant — every loser's joined text is a prefix of the
winner's. Any id that violates it is printed (a real edit or the
`resultText` fallback) and the longest text wins with a warning.

**Split responses.** A multi-turn response left a partial doc under the first
turn's id and the full doc under the last turn's id (same `serverSessionId`,
same `createdAt`). Rule: among assistant docs sharing (`serverSessionId`,
`createdAt`), a doc whose text is a strict prefix of a sibling's is dropped;
the dry run lists every such drop.

**Cross-ledger duplicates** (99 ids): identical, verified; the rule above
covers them.

**Hard checks, refuse-to-write on failure:**
- every `ts` finite and within `[2026-02-15, 2026-03-01)`;
- no string cell begins with U+FFFD or equals U+FFFC; every string is
  well-formed UTF-16 (`isWellFormed`);
- `cellJsonBytes(text)` and `cellJsonBytes(content)` each ≤ 65,536, computed
  with the DO's own formula (UTF-8 bytes of `JSON.stringify`);
- the whole batch round-trips through a local `createStreamStore()` and
  `getTables()` + `getMergeableContent()` succeed;
- no target id already exists on the server with a `sessionId` not prefixed
  `fireproof:`;
- the server's `ledgerId` value equals `01KYJ9XT64DQDJ1P3V8KET1R7B`;
- the dry run enumerates every distinct document key-set and role/speakerType
  value per ledger and fails on an unknown shape.

**Provenance.** No lineage write — `lineageNote` is one of the DO's immutable
lineage keys and any change is silently reverted. Provenance rides every
row's `sessionId`, plus one receipt row: `kind:'system'`, id
`fireproof-import-2026-08-25`, `sessionId:'fireproof:import'`, `ts` = import
time, `text` = the witnessed sentence naming what was annexed and what is
absent. The prefix convention is documented in `shared/schema.ts` and in the
stream adapter note.

## Mechanism

One script, `scripts/stream-import-fireproof.ts`, resolved from `scripts/`
so it shares the DO's TinyBase version:

1. **Source:** the local archive
   `~/julian-stream-backups/phone-export-20260725/march-rescue-connect-share-20260725.tar.gz`
   (never the VM). The script asserts its sha256
   `64f5d5e12692db4d11548529bbcfefea74586fa0271e39558ea06b94bcd64ee3`
   before reading. Extracts to `mkdtemp(tmpdir(), 'fp-import-')`: `d1/d1-main.sqlite`
   (keys), `r2/r2-metadata.sqlite` (blob index + upload times),
   `dashboard/dashboard-sqlite.db` (ledger names), and the blobs of every
   ledger named `%julian-chat%`. The temp dir is removed in `finally`. Key
   material never leaves it; decrypted plaintext exists only in memory.
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
   recipe for future readers; never run in a logged session).
5. **Write path.** WebSocket to the sync DO with `Authorization: Bearer
   <lease token>` — lease tokens are refused in `?token=`. Token from the Mac
   loopback holder or lease file via `resolveAccessToken`; **refuse if the
   source is `legacy`**. Scope: mac-home's standing full-house lease (`stream`
   cannot be knocked for; no new grant is created). Rows are written in
   transactions whose serialized diff is under **256 KiB** — one unfragmented
   frame each, because the DO drops multi-fragment messages whose last
   fragment arrives more than one second after the first, with no error to
   the client. `onIgnoredError` aborts the run. The receipt row goes last.
6. **Server-side verification** (the gate, not the count): after the sync
   settles, pull `/export` and compare, for every imported id, the sha256 of
   the mapped cells against the exported cells; grep the export for the DO's
   `[dropped: cell exceeded 64 KiB]` marker; assert the receipt row is
   present. Any mismatch fails the run loudly.

## Verification before the VMs are destroyed

1. Dry run: 1,645 rows, `ts` range Feb 15–28, zero out-of-range, largest cell
   and batch bytes printed, prefix-violation list empty or explained.
2. Write; per-id server-side equality report: 1,645 equal, 0 mismatched,
   0 dropped-marker hits, receipt present.
3. `bun scripts/stream-export.ts` (exports written `0600`, directory `0700`):
   the archive shows the new row count and earliest `ts` Feb 15.
4. The app, reloaded on the Mac and on a phone: scroll to the top, three
   February messages spot-checked against `--show-text` output.
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

## Housekeeping in the same change

- `.gitignore`: `*.sqlite`, `*.tar.gz`, `*.car`, `*.ndjson`.
- `shared/schema.ts` comment: the `fireproof:` sessionId convention.
- `memory/adapters/stream-fireproof.md`: superseded; archive paths (Mac, R2),
  the decode recipe pointer, what was annexed and what was not.
- `catalog.md` Open Threads: the sibling-identity diff owed (73 identities,
  57 with text, Lina absent from the Register).

## Out of scope

Importing agent identities or jobs; any schema change; a server-side import
endpoint; virtualizing the app's message list (+1,645 rows is a visible cost
on a phone, recorded here as accepted); the account migration (its own spec);
decoding the non-`julian-chat` ledgers.
