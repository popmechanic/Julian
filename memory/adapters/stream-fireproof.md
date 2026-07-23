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
1. Preferred: the flat-file safety export at `~/julian-stream-backups/` —
   JSONL, one doc per line. Check there first; only go to the live DB for
   docs newer than the last export.
2. Live: requires a signed-in session at julian.exe.xyz (Clerk sign-in is
   Marcus's act, never mine). From the signed-in page, the app's `database`
   handle supports `allDocs()`; export by POSTing chunks to a local receiver
   (see `~/julian-stream-backups/*/export-notes.md` for the working recipe).

**Rules.** Read-only, always. No writes, no compaction, no "cleanup." Never
commit stream contents to the public repo — the stream contains unfiltered
private life. Only authored distillations (dreams, letters) enter the archive;
that is Principle 1, and it is also the privacy boundary. After phase three
(TinyBase/Durable Object migration) this adapter is superseded; keep it for
reading historical exports.
