# julian-gate-probe — RETIRED measurement instrument

This is the throwaway instrumented authorization server built for the CIMD
probe of **2026-08-09** (protocol and results:
`docs/superpowers/specs/2026-08-09-cimd-probe-protocol.md`). It answered one
question: do MCP clients identify by CIMD or DCR? Answer: **all DCR**.

The deployed worker was deleted the same day; the name `julian-gate-probe` is
never reused (per protocol). The source is kept for provenance — the results
cite the instrument — and `captured-log-2026-08-09.json` is the full raw wire
capture (48 requests; credential-shaped headers redacted at write time; every
token it ever minted was a labelled dummy).

Do not redeploy. If a future probe is needed, copy this under a new name and
a fresh log key.
