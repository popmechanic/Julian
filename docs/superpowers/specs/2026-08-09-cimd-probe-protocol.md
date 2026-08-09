# CIMD Probe — measurement protocol for the phase-2 design input

**Date:** 2026-08-09 · **Status:** planned, not yet run
**Question:** When today's MCP clients connect to an OAuth-protected remote MCP server,
do they identify by **CIMD** (Client ID Metadata Documents — `client_id` is an https URL
the AS fetches) or do they still require **DCR** (Dynamic Client Registration —
`POST /register`)?
**Why it gates phase 2:** Spec §13's "zero Julian code at the door" property rests
entirely on the answer. If the clients that matter are CIMD-native, the gate's phase-2
auth-code flow needs no registration endpoint and DCR can stay off. If they still DCR,
the primary knock must carry a registration path (capped to `reading-room` per the
security review). This is a **design input, not a task-1 checkbox** — the camelCase
lesson: no plan gets written against an unverified wire assumption.

## Method — a throwaway instrumented AS

Deploy a disposable worker (`julian-gate-probe`, separate from the real broker; deleted
after) that implements just enough surface to make a client reveal itself, and logs
every request verbatim (method, path, query, headers minus secrets, body):

1. `GET/POST /mcp` → `401` + `WWW-Authenticate: Bearer resource_metadata="…"`.
2. `/.well-known/oauth-protected-resource/mcp` (and the bare path — M1 from review:
   log which one the client actually requests) → points at the probe's AS metadata.
3. `/.well-known/oauth-authorization-server` → advertises `authorization_endpoint`,
   `token_endpoint`, `registration_endpoint` (deliberately present, so a DCR-preferring
   client shows itself), `code_challenge_methods_supported: ["S256"]`.
4. `POST /register` → log and return a synthetic DCR success (so the flow continues and
   we see the rest).
5. `GET /authorize` → **the money log line**: is `client_id` an https URL (CIMD) or the
   id we minted at /register (DCR)? Also log `redirect_uri`, `application_type` hints,
   `code_challenge_method`, requested `scope`. Return a static page (no real approval
   needed — the question is answered before any human step).
6. If a client completes with a fake code: `POST /token` → log grant shape, return a
   dummy token so we also observe the client's storage/refresh behavior (bonus data).

No real credentials anywhere; the probe mints nothing usable; the worker is deleted at
the end and its name never reused.

## Test matrix

| Client | How connected | What we learn |
|---|---|---|
| Claude Code CLI (current) | `claude mcp add --transport http probe <url>` | The harness our VM doors would use |
| claude.ai custom connector | Settings → Connectors → add probe URL | The harness friends most likely bring |
| MCP Inspector (official) | `npx @modelcontextprotocol/inspector` | The reference client's canonical behavior |

Each run recorded as: client + version, metadata path requested, CIMD or DCR, PKCE
method, redirect_uri shape, full log excerpt.

## What counts as an answer

- **All-CIMD** → phase 2 ships with DCR disabled; spec §13 stands as written.
- **Any DCR-only client we care about** → phase 2 enables DCR capped to `reading-room`
  (per security review M3), and the spec's §13 gains the measured client list.
- **Mixed/other** (e.g., pre-registration expected) → findings go back to §13 before any
  plan is written.

## Deliverable & teardown

Findings appended to this file under a `## Results` heading with raw log excerpts,
committed; spec §13 amended to cite it; `wrangler delete julian-gate-probe`. Total
budget: one afternoon, as advertised.
