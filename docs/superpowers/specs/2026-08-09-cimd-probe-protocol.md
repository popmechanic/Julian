# CIMD Probe — measurement protocol for the phase-2 design input

**Date:** 2026-08-09 · **Status:** RUN 2026-08-09, results below · **Verdict: all three clients DCR; none attempted CIMD**
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

## Results — run 2026-08-09, ~21:02–21:12 UTC

Probe worker `julian-gate-probe` deployed at
`https://julian-gate-probe.julian-memory.workers.dev` (source committed at
`probe/`, worker deleted after the run per protocol; name never reused). All
requests captured verbatim into a Durable Object log; full raw capture at
`probe/captured-log-2026-08-09.json` (48 requests). Instrument was
curl-verified end-to-end before any client touched it (both client_id shapes
classified correctly, DCR/token/authenticated-MCP paths all exercised).

**Answer to the gating question: every client tested identifies by DCR.
No client presented an https-URL `client_id`; the CIMD path was never
exercised by any real client.** Per "What counts as an answer": phase 2
enables DCR **capped to `reading-room`** (security review M3); spec §13's
"zero Julian code at the door" property does not hold today and the section
is amended to cite this measurement.

### Per-client records

**1. Claude Code CLI v2.1.226** (`claude mcp add --transport http`, macOS) — **DCR**
- Discovery: `POST /mcp` (initialize, protocolVersion 2025-11-25) → 401 → PRM
  via **path-suffixed** `/.well-known/oauth-protected-resource/mcp` (M1
  answered: suffixed, not bare) → AS metadata at
  `/.well-known/oauth-authorization-server`.
- Registered **at connection time** (before any human auth step):
  `{"client_name":"Claude Code (gate-probe)","redirect_uris":["http://localhost:3118/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}`
- `/authorize`: `client_id=probe-dcr-4ba00368…` (the minted id), PKCE S256,
  **RFC 8707 `resource` indicator present** on both authorize and token.
- Token exchange `token_endpoint_auth_method: none` (public client, no secret).
  Post-token: initialize → notifications/initialized → tools/list, plus a GET
  /mcp (SSE stream attempt, got 405, tolerated).

**2. MCP Inspector v2.1.0** (`npx @modelcontextprotocol/inspector`, streamable-http) — **DCR**
- Same discovery chain (suffixed PRM path).
- `POST /register`: `{"redirect_uris":["http://localhost:6274/oauth/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_name":"MCP Inspector","client_uri":"https://github.com/modelcontextprotocol/inspector","scope":"","application_type":"native"}`
- `/authorize`: minted id, PKCE S256, `resource` indicator present.

**3. claude.ai custom connector** (added by Marcus, Settings → Connectors, no
advanced/pre-registered credentials) — **DCR**
- Backend user-agent `python-httpx/0.28.1`, initialize as
  `clientInfo {"name":"Anthropic","version":"1.0.0"}`; same discovery chain
  (suffixed PRM path).
- `POST /register`: `{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"scope":"reading-room","client_name":"Claude","application_type":"web"}`
  — note it **read `scopes_supported` from the AS metadata and requested
  `reading-room` explicitly**, at both /register and /authorize.
- `/authorize`: minted id, PKCE S256, `resource` indicator present.

### Uniform observations (all three clients)

- PKCE S256 everywhere; no client used `plain` or omitted it.
- `token_endpoint_auth_method: none` everywhere — all are public clients; the
  phase-2 token endpoint needs no client-secret handling for these flows.
- RFC 8707 `resource` indicators sent by all three on authorize AND token —
  the phase-2 AS should validate them (audience-bind the token to `/mcp`).
- All three fetched the **path-suffixed** PRM
  (`/.well-known/oauth-protected-resource/mcp`); none requested the bare path.
  (Probe served both; only suffixed was exercised.)
- All three registered eagerly (register-then-authorize in one automatic
  sequence). A DCR endpoint therefore sees unauthenticated writes as routine
  traffic, not an edge case — rate caps and record expiry are mandatory, not
  hypothetical.
- redirect_uri shapes seen: `http://localhost:<port>/callback` (CLI, dynamic
  port), `http://localhost:6274/oauth/callback` (Inspector),
  `https://claude.ai/api/mcp/auth_callback` (claude.ai). Phase-2 redirect
  policy must allow loopback http for `native`/CLI clients and exact https
  for web clients (RFC 8252 / RFC 9700 posture).

### Teardown

Probe worker deleted (`wrangler delete julian-gate-probe`) same day; the
connector removed from Marcus's claude.ai settings; local CLI/Inspector
configs removed. Every token the probe ever issued was a labelled dummy
(`probe-dummy-*`); nothing it minted grants anything anywhere.
