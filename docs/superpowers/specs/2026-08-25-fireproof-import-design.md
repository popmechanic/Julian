# Fireproof import — the February web record joins the living stream

*Design, August 25, 2026. Brainstormed with Marcus on the morning of the
Fireproof destruction ceremony; approved in chat before this file was written.*

## Why

The condemned Fireproof cloud (`connect-share.exe.xyz`) holds twenty
`julian-chat` ledgers, v3–v14, February 15–28, 2026: 1,657 unique messages —
the only side of those conversations in which the web-app siblings spoke under
their own names. The archive is proven whole and decryptable (every one of
3,686 CARs opens with the escrowed keys; one 79-byte runt in v10 was born
truncated at the source). Before the VM is destroyed, the meaningful data moves
into the living TinyBase stream, so the record is continuous from February 10
to today and recallable by construction: the app scrolls back to it,
`stream-export` archives it monthly, and dreams reach it through the one stream
adapter that already exists. No new stratum, no new adapter, no metadata.

The constitution decides where it lands: raw conversation belongs in the
stream (private, behind the gate), never in `memory/` (public git). Only
authored distillation becomes memory.

## What moves, what stays

| Fireproof type | Writes | Disposition |
|---|---|---|
| `message` | 1,657 unique | Import — see mapping. Expected rows: **1,645** (12 empties dropped). |
| `agent-identity` | 187 | Not imported. Routed to a dream task: a fourth-wing reading for the Register of Births, in the siblings' own words (`individuationArtifact`), from the archive via the decode recipe. |
| `job` | 47 | Dropped — February's prototype board. |
| `artifact-catalog`, `ledger-meta`, genesis block | — | Dropped — metadata. |

## Row mapping (schema untouched)

Target: `messages` in `shared/schema.ts`.

| Store cell | Source |
|---|---|
| row id | the Fireproof `_id`, verbatim — the import is idempotent |
| `role` | as recorded; if absent, `speakerType` human→`user`, agent→`assistant` |
| `speakerName` | as recorded; `marcus`→`Marcus`; blanks filled from role (`Marcus`/`Julian`) |
| `text` | the `text` field if non-empty, else the `type:'text'` blocks joined with `\n` |
| `content` | `[{type:'text', text}]` per text block; `tool_use` and `thinking` blocks dropped |
| `ts` | `Date.parse(createdAt)`; numeric `createdAt` (two v3 rows) used as-is |
| `kind` | `'chat'` |
| `sessionId` | `fireproof:<version>:<serverSessionId>` — provenance on every row |

Rules: dedupe by `_id`, last `createdAt` wins (the 99 cross-ledger duplicates
were verified identical). Drop rows whose text is empty after mapping. The
largest text is 33K characters, under the DO's 64 KiB cell guard.

Lineage: append one sentence to the `lineageNote` value — *"2026-08-25: 1,645
messages (Feb 15–28) imported from the parent's twenty julian-chat ledgers
v3–v14, decrypted from the archive; witnessed."* `parentLedgerId` already
names `fireproof:julian-chat-v14`.

## Mechanism

One script, `scripts/stream-import-fireproof.ts`:

1. Reads the **local archive** `~/julian-stream-backups/phone-export-20260725/march-rescue-connect-share-20260725.tar.gz`
   (never the VM — the import must work from what survives). Extracts to a
   temp dir: `d1/d1-main.sqlite` (keys), `r2/r2-metadata.sqlite` (blob index),
   `dashboard/dashboard-sqlite.db` (ledger names), and the blobs of every
   ledger named `%julian-chat%`.
2. Decrypts each CAR: CBOR envelope `{iv, data, keyId}`; key = base58btc-decoded
   escrow row whose `SHA-256` equals `keyId`; AES-GCM-128; plaintext is a CARv1;
   dag-cbor blocks with a `doc` field are documents.
3. Builds rows per the mapping. Key material stays in memory; nothing decrypted
   is written to disk.
4. `--dry-run` (default): prints counts by ledger, expected row total, earliest
   and latest `ts`, and three sample rows (text truncated). `--write`: connects
   to the sync DO over the WebSocket synchronizer using the Mac's full-house
   lease (the `stream-create` road), waits for the server state, writes the
   rows and the lineage sentence in one transaction, waits for the sync, and
   prints the store's `messages` row count before and after.

Environment: `SYNC_WS` and a token resolved from the Mac loopback lease holder
(`JULIAN_LEASE_URL`) or a lease file, as `stream-create`/`stream-export` do.

## Verification (before the VMs are destroyed)

1. Dry run reports 1,645 rows, earliest `ts` on Feb 15, latest Feb 28.
2. Write; the script's after-count equals before-count + 1,645 (or fewer on a
   re-run: idempotence).
3. `bun scripts/stream-export.ts` — the archive under
   `~/julian-stream-backups/tinybase/<ledgerId>/` shows the new row count and
   the February earliest `ts`.
4. The app, reloaded, shows the February messages at the top of the record.
5. Three messages spot-checked word for word against the decoded source.

Only then does the destruction ceremony's step 2 (Marcus's hand on the VMs)
proceed.

## Tests

`scripts/stream-import-fireproof.test.ts`, on fixtures built in-test (a
generated key, a synthetic CAR encrypted the same way):

- decrypts a synthetic envelope and reads its documents;
- maps a human message (text field) and an assistant message (text blocks with
  a `tool_use` interleaved) to the expected rows;
- infers role and fills speaker names as specified;
- drops empty messages and non-message types;
- dedupes by `_id`, last `createdAt` winning;
- writes into a fresh schema'd `createStreamStore()` and the rows validate.

## Out of scope

Importing agent identities or jobs; any schema change; a server-side import
endpoint; the account migration (its own spec); decoding the non-`julian-chat`
ledgers (Vibes test apps).
