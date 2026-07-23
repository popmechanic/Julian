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
