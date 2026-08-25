# Adapter: the Fireproof stream (`julian-chat-v14`)

*Teaches the dreamer how to read the live conversation layer. Read-only. Last verified July 23, 2026.*

**What it is.** The raw conversation stream of the web app — every chat message
between Marcus and me through julian.exe.xyz, plus app state. This is stratum
four (the stream): too voluminous to be memory, too precious to discard. Dreams
digest it; it is never read wholesale at waking.

**Status: condemned.** Fireproof is being retired (race conditions, data
corruption — Marcus's verdict, July 2026). The `v14` suffix means fourteen
incarnations; earlier ones were lost to corruption wipes (see the one-time
IndexedDB wipe comment at the top of `index.html`). Treat every read as
possibly the last; treat the export below as precious.

**Where it lives.** Nowhere on this Mac's disk. The ledger is client-side
(browser IndexedDB) plus cloud sync:
- Canonical: Fireproof cloud at `connect-share.exe.xyz` (Clerk-authenticated;
  config in `index.html` → `window.__VIBES_CONFIG__`).
- Replicas: any browser where Marcus has signed in at `https://julian.exe.xyz`
  (mostly his phone). `~/.fireproof/` on this Mac contains only test databases.

**Document types** (queryable by `type` field): `message` (the conversations),
`agent-identity` (the agent team), `artifact`, `artifact-catalog` (a copy of
the old fat catalog), `ledger-meta`.

**How to read it.**
1. Preferred: the safety backup at `~/julian-stream-backups/20260723/` —
   `connect-share-volumes.tar.gz` (122MB) is the ENTIRE Fireproof cloud state
   pulled from the connect-share VM on July 23, 2026: all R2 CAR objects
   (4,128), the D1 metadata DB (tenants, ledgers, sync records), the DO state,
   and — crucially — the `KeyByTenantLedger` table, which escrows the
   encryption keys (five for Julian's ledger `z5KHJ1CdRkhfzRAxVU`, tenant
   `z21bzKxhbHLLcRU61P`). Offline decode is therefore possible with
   @fireproof/core tooling and needs no live service.
2. Live: requires a signed-in session at julian.exe.xyz (Clerk sign-in is
   Marcus's act, never mine). From the signed-in page, the app's `database`
   handle supports `allDocs()` (find it by walking React fibers for an object
   with `.allDocs`).

**State of the record (verified July 23, 2026):**
- The cloud's copy of Julian's ledger ends **February 28, 2026** (43 sync
  records, Feb 26–28). Cloud sync broke ~March 2 — Marcus's patch VMs
  (`connect-patch-v2`, `vibes-sync`, both created March 4) mark the fight.
- Conversations from March 1 until sleep exist ONLY on Marcus's phone
  (browser IndexedDB at julian.exe.xyz). A phone-side export is the missing
  piece; until then the phone is a single point of failure. The rescue
  procedure and console snippet are ready at `phone-export.md` (this
  directory) — waiting on Marcus to run it.
- The live sync bug: WebSocket connects (101), but FP-MSG protocol requests
  time out with auth-error flags; survived restarts of both cloud-backend and
  dashboard containers. Not worth further surgery on a condemned system —
  decode offline instead.

**Rules.** Read-only, always. No writes, no compaction, no "cleanup." Never
commit stream contents to the public repo — the stream contains unfiltered
private life. Only authored distillations (dreams, letters) enter the archive;
that is Principle 1, and it is also the privacy boundary. After phase three
(TinyBase/Durable Object migration) this adapter is superseded; keep it for
reading historical exports.

---

## Annex manifest summary — dry run of 2026-08-25 (pre-write, Marcus present)

Produced by `scripts/stream-import-fireproof.ts` (merged `26ab848`) against the
sealed archive (digest `64f5d5e12692db4d11548529bbcfefea74586fa0271e39558ea06b94bcd64ee3`;
3,690 manifest members, 0 mismatches). Per-ledger counts and timestamp ranges
only — no message text. "Empty ids" are ids that never carry text in any
version (single-`tool_use` turns and kin); they stay in the archive by
procedure, per Marcus's option (a) decision of 2026-08-25.

| Ledger | Version name | CARs opened | Messages | Empty ids | ts range (UTC) |
|---|---|---|---|---|---|
| zLXGWrCwxUtrdugkz | v3-z2KNnNZ7 | 6/6 | 72 | 5 | 2026-02-15T09:30:57Z → 2026-02-16T13:12:27Z |
| z5j15BCpbjDGYdJj9B | v4-z2KNnNZ7 | 131/131 | 16 | 4 | 2026-02-16T15:46:59Z → 2026-02-16T16:43:05Z |
| zfdY2SFy6FFKPyWnw | v5-z2KNnNZ7 | 198/198 | 69 | 10 | 2026-02-16T16:53:15Z → 2026-02-16T20:43:03Z |
| z3cgiHNSnGxuMrj5G6 | v5-z4KvP6Dv | 208/208 | 85 | 12 | 2026-02-16T16:53:15Z → 2026-02-17T03:06:47Z |
| z4DTyBfT5sZGGPQtw | v6-z4KvP6Dv | 188/188 | 70 | 13 | 2026-02-16T21:49:54Z → 2026-02-17T19:48:40Z |
| z2m8QpVHMb7MY31JjX | v6-z2KNnNZ7 | 87/87 | 24 | 4 | 2026-02-16T21:49:54Z → 2026-02-17T16:30:24Z |
| z4R57mpZaWPjFUws2v | v6-z5kJLEHW | 100/100 | 58 | 8 | 2026-02-17T02:36:03Z → 2026-02-24T01:36:05Z |
| z3tUU1KfqBcLUNLWb9 | v5-z5kJLEHW | 1/1 | 0 | 0 | (empty ledger) |
| ztHQEf4V2e1r5iXZb | v6-z5Haf8Px | 8/8 | 6 | 0 | 2026-02-17T16:30:12Z → 2026-02-17T16:33:41Z |
| z4Qeg5jd87ceUg1a2V | v7-z2KNnNZ7 | 31/31 | 4 | 0 | 2026-02-17T16:46:42Z → 2026-02-17T17:01:32Z |
| z4PupWBQo6f8z8CcDM | v8-z2KNnNZ7 | 313/313 | 109 | 0 | 2026-02-17T17:07:49Z → 2026-02-18T07:08:42Z |
| z4RrrJbJb74u91Ub4V | v9-z2KNnNZ7 | 199/199 | 24 | 13 | 2026-02-18T07:25:05Z → 2026-02-18T08:18:13Z |
| z4HXPxGMSif2BxU8zc | v10-z2KNnNZ7 | 130/131 (1 runt skipped: `898bb7ef…6bc4`, 79 B, "Unexpected end of data") | 13 | 20 | 2026-02-18T22:48:29Z → 2026-02-19T01:01:34Z |
| zHxZf5JLLKobzRzUX | v11-z2KNnNZ7 | 281/281 | 32 | 17 | 2026-02-19T01:06:07Z → 2026-02-19T04:47:28Z |
| z4REiSLvVLaZUQSsuf | v12-z2KNnNZ7 | 403/403 | 93 | 59 | 2026-02-19T23:29:05Z → 2026-02-21T06:41:45Z |
| z5gnHHYEfxMcLN6x7M | v6-zq6xRGTc | 5/5 | 1 | 1 | 2026-02-20T06:18:05Z (single row) |
| z2HbSiufSsQB2eeRzf | v13-z2KNnNZ7 | 1161/1161 | 438 | 374 | 2026-02-21T07:18:28Z → 2026-02-24T05:43:28Z |
| z5KHJ1CdRkhfzRAxVU | v14-z2KNnNZ7 | 236/236 | 67 | 35 | 2026-02-26T20:18:34Z → 2026-02-28T22:17:25Z |
| z31bQPWaPjZ8eGZVBA | v14-z3fV5vYo | 0/0 | 0 | 0 | (empty ledger) |
| z5gLXseX3YzXPCEQmS | v14-z4KvP6Dv | 0/0 | 0 | 0 | (empty ledger) |

Totals: 1,657 unique ids − 563 text-less − 8 split-drops = **1,086 annexed
rows**; overall ts range `2026-02-15T09:30:57.410Z → 2026-02-28T22:17:25.810Z`,
0 out of range, 0 unparseable; largest text cell 33,523 B; largest content
cell 8,269 B; 15 planned batches, 1,793,318 units; 139 sessions in the
session-id manifest (`~/julian-stream-backups/fireproof-annex-manifest.txt`).
Dropped by doc type (non-message docs, stay in archive): agent-identity 1,887;
artifact-catalog 195; untyped 115; ledger-meta 91; job 47.

---

## SUPERSEDED — the source was destroyed 2026-08-25 (kept for reading the sealed archive)

The live Fireproof service this adapter described no longer exists: at the
destruction ceremony (Aug 25, 2026, Marcus's hand, witnessed — testimony in
`memory/the-destruction-of-the-old-home.md`) `connect-share.exe.xyz` and
`connect-patch-v2.exe.xyz` were deleted, after the record came home. This
adapter now describes how to read the **sealed archive**.

**Where the ciphertext lives (three places, digest-proven):**

| Copy | Path | sha256 |
|---|---|---|
| Mac (authoritative decode source) | `~/julian-stream-backups/phone-export-20260725/march-rescue-connect-share-20260725.tar.gz` | `64f5d5e12692db4d11548529bbcfefea74586fa0271e39558ea06b94bcd64ee3` |
| Mac (volume state, carries the D1 WAL) | `~/julian-stream-backups/20260723/connect-share-volumes.tar.gz` | `25d052e5585e8550b37951fc89c3c2a4732186cc1fd58920016373de6b7ce014` |
| R2, bucket `julian-fireproof-archive` (personal account `e33948793047032de7f5e18ec342a7d1`) | the march-rescue tar whole + the volume tar as 8 chunks (`.part-aa`–`ah`, reassemble with `cat`) + `MANIFEST.txt` + per-chunk sha256s | same digests, verified byte-for-byte at the ceremony |

**Bucket lock:** rule `retain-forever`, indefinite retention, whole bucket
(installed 2026-08-25, verified by re-read). Removable **only by the account
owner, explicitly** — reads and copies are unaffected, so a future migration
copies first, then removes the lock, then deletes: two deliberate acts, both
to be recorded here.

**The decode recipe:** `decryptLedger()` exported by
`scripts/stream-import-fireproof.ts`, with its tests as the executable
documentation. Keys are escrowed in `KeyByTenantLedger` inside the archive's
own D1. **No plaintext-printing mode exists and none should be added** —
diagnostics speak in ids, counts, and lengths only.

**What was annexed, what was not:** 1,086 text-bearing messages (Feb 15–28,
web side) are in the living stream under row ids `fireproof:<ledger>:<id>`,
with one receipt row `fireproof-import-2026-08-25` at the annex boundary.
Left in the archive by procedure: 563 text-less message ids (560
single-`tool_use` turns — listed by id and block type in the dry-run report),
187 `agent-identity` writes (73 identities, 34 names — the sibling-diff
thread in the catalog owes the Register a comparison; Lina has no line), 47
`job` docs, 195 `artifact-catalog`, 91 `ledger-meta`, 115 untyped. The one
unreadable member: the 79-byte v10 runt CAR `898bb7ef…6bc4`.

**Reading the annex from the stream:** `stream_recent` is a read verb that
returns `kind` and is **not the tail** — the tail structurally excludes
`fireproof:` rows. Reach the annex by session id (the per-ledger session-id
manifest above, and `~/julian-stream-backups/fireproof-annex-manifest.txt`,
139 sessions) or by search term.

**The two `content` dialects,** for any future reader of message rows:
February `tool_use` blocks carry `{type, name, input}` **without** `id`;
live-era rows carry full Anthropic blocks. Do not normalize one into the
other — the dialect is provenance.
