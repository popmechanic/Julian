# MCP 2026-07-28 for the gate — SDK v2 migration cost and the backward-compat matrix

Wayfinder research ticket #63. Facts only; nothing is migrated here. Every
claim below about the 2026-07-28 revision or the v2 SDK is cited to a
primary source read on 2026-08-28 (Sources, §9). Where a page could not be
read, or a fact was not verified, it is marked as such — MCP 2026-07-28 and
SDK v2 are both after the author's training data, so nothing is filled in
from memory.

## 0. The question, and the short answer

**What does it cost to make the gate speak MCP `2026-07-28` beside the old era?**

Short answer: the gate's `/mcp` face is a 696-line hand-rolled, SDK-less,
stateless JSON-RPC handler (`broker/src/mcp.ts`), and that posture is
*exactly* what the new revision asks for — no sessions, no GET stream, one
POST per message. The old-era behaviour needs no change to keep serving
legacy clients: the spec's dual-era rule is "an `initialize` request selects
legacy semantics; a request carrying the modern per-request `_meta` is served
statelessly according to this revision", both on one endpoint ([versioning]).
What is *added* for the modern era is: era detection from `_meta`, a
`server/discover` method, validation of three HTTP headers against the body,
`resultType: "complete"` plus `_meta` serverInfo on every result, top-level
`ttlMs`/`cacheScope` on five result kinds, the `-32020`/`-32022`/`-32602`
error-and-HTTP-status rules, and removing `ping`/`initialize` from the modern
method set. The SDK v1 devDependency (`@modelcontextprotocol/sdk ^1.0`, locked
at 1.30.0) is used **only** by the Node acceptance harness as a *client*; it
cannot speak the modern era, so proving the modern path with "software that
did not read our code" means adding `@modelcontextprotocol/client@2.0.0`
beside it (both installable at once — different package names, [upgrade]).

Estimate (§7): the hand-rolled dual-era path is roughly **150–200 lines of
worker code, ~400–500 lines of tests, one new devDependency, two files
touched in `src/`, three in tests**. Adopting the v2 server SDK instead is a
rewrite of the face (§7, path B) and is not required to be conformant.

## 1. What we have (read 2026-08-28)

### `broker/src/mcp.ts` (696 lines)

| Lines | What | 2026-07-28 relevance |
|---|---|---|
| 1–5 | header comment: hand-rolled, stateless, JSON only, no SDK | the spec's modern posture already |
| 15 | `PROTOCOL_VERSION = '2025-06-18'` | becomes one of two supported versions |
| 16 | `SERVER_INFO = { name: 'julian-gate', version: '1.0.0' }` | must also ride `_meta['io.modelcontextprotocol/serverInfo']` on modern results |
| 26 | `CACHE_META = { 'io.modelcontextprotocol/cacheControl': { ttlMs: 300_000 } }` | not a reserved key in the 2026-07-28 `_meta` table; caching is now top-level `ttlMs`+`cacheScope` (§5) |
| 142–151 | `RpcRequest`, `rpcResult`, `rpcError` — always HTTP 200, `Content-Type: application/json` | modern errors `-32020`/`-32021`/`-32022`/missing-`_meta` MUST be HTTP 400; unknown method MUST be HTTP 404 (§4) |
| 155–221 | `TOOLS` with raw JSON-Schema `inputSchema` | unchanged; JSON Schema 2020-12 default dialect (spec basic §"JSON Schema Usage") |
| 555–568, 571–589 | `resources/read` / `resources/list` errors use `-32002` | 2026-07-28 moved resource-not-found to `-32602`; `-32002` stays legal only as an implementation-defined code (§4) |
| 595–696 | `handleMcp`: body parse, batch refusal, id-less → 202, `switch(method)` | detection branch + `server/discover` + modern result stamping go here |
| 622–624 | id-less message → bare 202 regardless of method | still correct for both eras ([streamable-http] "notification … 202 Accepted with no body") |
| 633–640 | `initialize` answers `2025-06-18` | legacy lane only; on the modern lane `initialize` is an unknown method |
| 642–643 | `ping` → `{}` | `ping` is **removed** in 2026-07-28 ([changelog] major #5); legacy lane only |
| 645–651, 676–680 | `tools/list`, `prompts/list` carry `_meta: CACHE_META` | modern: `ttlMs`, `cacheScope` top-level, required (§5) |
| 653–668 | `tools/call`; unknown tool → `-32602` | unchanged (spec lists "Unknown tool" as a protocol error) |
| 670–674 | `resources/list`, `resources/read` carry no cache hint by design (COLD M-7) | modern **requires** `ttlMs` on both; `ttlMs: 0` = "immediately stale" preserves the M-7 decision explicitly (§5) |
| 693–694 | default → `-32601` at HTTP 200 | modern: `-32601` MUST be HTTP 404 ([streamable-http] "Protocol Version Header") |

### `broker/src/index.ts` (213 lines)

| Lines | What | Relevance |
|---|---|---|
| 41–48 | `challenge401`: RFC 9728 `WWW-Authenticate: Bearer resource_metadata=…` | unchanged; auth is not era-switched ([support-2026]) |
| 161–173 | `/mcp` route: authenticate → non-POST 405 → `handleMcp` | GET/DELETE 405 is exactly what a modern-only server SHOULD do ([streamable-http] "Earlier Streamable HTTP Revisions"); `Origin` is **not** validated anywhere on `/mcp` (grep: no `Origin` handling in `index.ts` or `mcp.ts`) — a pre-existing gap, not a migration item, but the 2026-07-28 binding page repeats the MUST (§4) |

### `broker/package.json`

- `devDependencies["@modelcontextprotocol/sdk"] = "^1.0.0"`, locked to
  **1.30.0** in `bun.lock` (line 157). Not a runtime dependency of the worker.
- Where the SDK is imported: only `broker/test-mcp-client/harness.test.ts`
  lines 17–18 (`Client`, `StreamableHTTPClientTransport`) — the Node
  acceptance harness (`vitest.node.config.ts`, `bun run test:mcp`), 12 tests,
  971 lines. The workers-pool suite `broker/test/mcp.test.ts` (78 tests)
  drives `handleMcp` directly with hand-built `Request`s and imports no SDK.
- Toolchain on this machine: node v24.16.0, bun 1.3.0 — both satisfy v2's
  `engines.node >= 20` ([server npm]).

### `docs/superpowers/specs/2026-08-28-scribe-elf6-mcp-binding-notes.md`

- §4 Transport: the design wants "every request self-describing … the
  operation in HTTP headers (`Mcp-Method`, `Mcp-Name`) — so the ledger can be
  written at the edge from the envelope"; MRTR and MCP Apps named as futures.
- §8 Migration: "Broker speaks `2025-06-18` on SDK `^1.0`; v2 is split
  packages, breaking; the spec's backward-compat matrix covers running both
  eras; Cloudflare Agents SDK supports 2026-07-28 day zero. Order: (1) gate
  speaks 2026-07-28 beside 2025-06-18, re-run the CIMD probe; …"
  - Verified: v2 is split packages (§6). Verified with a correction: the
    "SDK `^1.0`" is a *dev* dependency used only as a test client; the face
    is SDK-less, so "breaking" applies to the harness, not the worker.
  - Verified: Cloudflare `agents` 0.20.0 (published 2026-07-27T17:57Z, the
    same day as SDK 1.30.0 and ~6 h before `@modelcontextprotocol/server@2.0.0`
    at 23:55Z) added "MCP SDK v2 client and server support" pinned to
    `2.0.0-beta.5`; 0.21.0 (2026-08-18) and 0.22.0 (2026-08-27) pin `2.0.0`
    ([agents changelog], [agents npm]). "Day zero" is accurate for the beta
    pin.

### Existing tolerance test that the migration must re-decide

`broker/test/mcp.test.ts` 239–271 and `harness.test.ts` 582–600 pin that a
"raw v2-shaped envelope" — headers `MCP-Protocol-Version: 2024-11-05`,
`Mcp-Method`, `Mcp-Name`, plus `params._meta.protocolVersion` (the **bare**
key, not `io.modelcontextprotocol/protocolVersion`) — is served like any
other call and that "the version header is deliberately *ignored*, never
validated — a decision, not a conformance claim". Under 2026-07-28 detection
(§3) that request is **legacy** (no reserved envelope key), so it keeps being
served; but on the modern lane the header MUST be validated (§4), so the
comment's decision becomes lane-specific rather than face-wide.

## 2. The breaking changes of 2026-07-28 that touch our code

From [changelog] (since 2025-11-25; our face is at 2025-06-18, so the
2025-11-25 deltas apply too but are not the subject of this ticket):

| # | Change | Touches |
|---|---|---|
| M1 | No protocol sessions, no `Mcp-Session-Id`; list endpoints must not vary per-connection (they MAY vary by the authorization presented on the request — [tools] "MUST NOT vary per-connection … MAY vary by the authorization presented") | already true: `mcp.ts` 591–594 (stateless), 225–227 (`visibleTools(scope)` varies by lease scope, which is per-request auth) |
| M2 | No `initialize`/`notifications/initialized`; every request carries `_meta` `io.modelcontextprotocol/protocolVersion` (required), `clientCapabilities` (required), `clientInfo` (SHOULD); servers SHOULD stamp `io.modelcontextprotocol/serverInfo` in every result's `_meta` | `mcp.ts` 633–640 (legacy only), every `rpcResult` call (modern stamp) |
| M3 | `server/discover` MUST be implemented | new `case` in `handleMcp` (§4) |
| M4 | GET stream and `resources/subscribe` replaced by `subscriptions/listen` | nothing to add: we never served GET (405, `index.ts` 169–171) and declare no `listChanged`; a modern client that sends `subscriptions/listen` gets `-32601` at 404 unless implemented — acceptable (spec ¶ on scribe notes §8 item 4 puts it last) |
| M5 | `ping`, `logging/setLevel`, `notifications/roots/list_changed` removed | `mcp.ts` 642–643 (`ping` legacy-only) |
| M7/M8 | MRTR; every result carries required `resultType` (`"complete"`) | every modern `rpcResult` (§4) |
| M9 | no `Last-Event-ID`, no resumability | nothing: never emitted |
| m4 | `Mcp-Method`, `Mcp-Name` REQUIRED on Streamable HTTP POSTs; `x-mcp-header` optional for servers | `handleMcp` entry (§4); our tool schemas declare no `x-mcp-header`, so no `Mcp-Param-*` handling is required beyond "reject unrecognised… invalid characters" (which only applies to *recognised* names — none) |
| m5 | `ttlMs` + `cacheScope` REQUIRED on `tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list` (+ `server/discover`, per [caching]) | `mcp.ts` 645–651, 670–674, 676–680 (§5) |
| m6 | resource-not-found `-32002` → `-32602` | `mcp.ts` 559, 563, 566, 579, 581 |
| m12 | error-code policy: `-32000…-32019` implementation-defined (grandfathered); `-32020…-32099` reserved; `HeaderMismatch -32020`, `MissingRequiredClientCapability -32021`, `UnsupportedProtocolVersion -32022` | `rpcError` callers (§4) |
| D1 | Roots, Sampling, Logging deprecated | none used (scribe notes §4) |
| D4 | DCR deprecated in favour of CIMD (PR #2858) | outside this ticket; it is the "re-run the CIMD probe" item of scribe notes §8 and the sibling research ticket |

Not verified from the 2025-11-25 changelog (out of scope): what else moved
between 2025-06-18 and 2025-11-25 that our legacy lane would be held to if we
advertised `2025-11-25`. The dual-era design below advertises exactly
`["2026-07-28", "2025-06-18"]` — the two versions we implement.

## 3. Can both eras be served from one `/mcp`? How is the era detected?

**Yes, on one endpoint, concurrently.** [versioning] "Backward Compatibility
with Initialization-Based Versions":

> A dual-era **server** selects its behavior from how the client opens:
> — A request carrying modern per-request `_meta` is served statelessly
> according to this revision.
> — An `initialize` request selects legacy semantics, scoped to … the session
> (HTTP), as specified by the negotiated legacy protocol version.
> A dual-era server **MAY** serve both eras concurrently on the same endpoint
> or process.

Since our legacy lane already issues no session (`Mcp-Session-Id` never set,
`mcp.test.ts` 236, `harness.test.ts` 535), "session-scoped legacy semantics"
collapses to "per request" — the same posture SDK v2 calls
`legacy: 'stateless'` and serves by default ([legacy-clients]).

**Detection rule** (what the SDK's `isLegacyRequest` does, [support-2026]):
"`isLegacyRequest` returns `true` only for requests with no per-request
`_meta` envelope claim; route `false` traffic to the modern handler (a
malformed modern claim is `false` and answered `-32602` / `-32020` by the
modern path)." I.e.:

1. Parse the body. If `params._meta['io.modelcontextprotocol/protocolVersion']`
   is **absent** → legacy lane (today's `handleMcp` unchanged; `initialize`,
   `ping`, `-32002`, `_meta.cacheControl`, HTTP 200 for every JSON-RPC error).
2. If present → modern lane. Then, in order ([streamable-http] "Server
   Validation" + [versioning]):
   - `MCP-Protocol-Version` header missing, or ≠ the `_meta` value → HTTP 400,
     `-32020 HeaderMismatch`.
   - version not in our supported set → HTTP 400, `-32022` with
     `data: { supported: ["2026-07-28", "2025-06-18"], requested }`.
   - `io.modelcontextprotocol/clientCapabilities` missing → HTTP 400, `-32602`
     ("A request missing any required field is malformed … `-32602` … On HTTP
     … `400 Bad Request`", [basic] "_meta").
   - `Mcp-Method` missing or ≠ `method`; for `tools/call`/`resources/read`/
     `prompts/get`, `Mcp-Name` missing or ≠ `params.name`/`params.uri` after
     Base64-sentinel decoding → HTTP 400, `-32020`.
   - unknown method (including `initialize`, `ping`) → HTTP 404, `-32601`.

**The compatibility matrix** ([versioning]), read for our clients:

| Client | Server = *our dual-era gate* | Outcome |
|---|---|---|
| Legacy (claude.ai, Claude Code as of the last live probe — era not re-verified today) | dual-era | **Works.** "The server answers `initialize` and serves the client according to the negotiated legacy revision." |
| Modern (SDK v2 client with `mode: { pin: '2026-07-28' }`) | dual-era | Works: first modern request succeeds; `server/discover` optional. |
| Dual-era (SDK v2 client `mode: 'auto'`, or Cloudflare `agents` ≥ 0.20.0 `MCPClientConnection`) | dual-era | Works: probes `server/discover`, "the client stays modern". |
| Legacy | modern-only (if we ever dropped the legacy lane) | **Fails**: 400, "Legacy clients have no fall-forward mechanism." This is why the lane is kept. |

HTTP-specific rule that makes the client-side fallback deterministic
([streamable-http] "Backward Compatibility"): a dual-era client tries a modern
request first; on `400` it inspects the body — a recognised modern JSON-RPC
error (`-32020`/`-32021`/`-32022`) means "modern server, retry/correct";
"empty or not a recognized modern JSON-RPC error" means "fall back to
`initialize`". Consequence for us: **until** we implement the modern lane, a
modern-enveloped request to today's face is served on the legacy path and
answered HTTP 200 with a 2025-shaped result (no `resultType`), which a strict
2026 client rejects ("On a 2026-era exchange `resultType` is REQUIRED; an
absent value is a spec violation surfaced as a typed error", [support-2026]).
That is the current failure mode, and it is silent from the server's side.

One more matrix row worth quoting because it bounds what a 2025-06-18 legacy
lane may assume: "A server that supports clients implementing protocol versions
earlier than `2025-06-18` (which did not define the `MCP-Protocol-Version`
header) **MAY** treat a request that omits the header as protocol version
`2025-03-26`" ([streamable-http] "Protocol Version Header"). Our legacy lane
today ignores the header entirely; that stays permissible on the legacy lane.

## 4. What `server/discover` must return, and the modern-lane rules

[discover]: "Servers **MUST** implement it." Request carries only `_meta`.
Response:

```json
{
  "jsonrpc": "2.0", "id": "…",
  "result": {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28", "2025-06-18"],
    "capabilities": { "tools": {}, "resources": {}, "prompts": {} },
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "julian-gate", "version": "1.0.0" } },
    "instructions": "…optional…",
    "ttlMs": 3600000,
    "cacheScope": "public"
  }
}
```

- `supportedVersions` — "Protocol versions the server supports. The client
  should choose one of these for subsequent requests." Listing `2025-06-18`
  is honest (we implement it on the legacy lane); the [versioning] example
  lists two.
- `capabilities` — same object `initialize` returns today (`mcp.ts` 638).
  No `extensions` (we advertise none). `listChanged` must NOT be claimed
  (we have no `subscriptions/listen`).
- `_meta['io.modelcontextprotocol/serverInfo']` — SHOULD. [support-2026]
  notes the final revision (spec PR #3002) moved `serverInfo` out of the
  `DiscoverResult` body into `_meta`.
- `instructions` — optional; the natural home for a one-line pointer to
  `wake_julian` (not required).
- `ttlMs`/`cacheScope` — REQUIRED ([caching] lists `server/discover` first).
  `capabilities` do not vary by lease, but `supportedVersions`/`capabilities`
  are the same for every caller, so `"public"` is accurate; the visible tool
  *list* is not returned here.

Modern-lane rules that apply to **every** method (all from [basic] "_meta",
[streamable-http], [schema]):

- Results: add `resultType: "complete"` (required) and
  `_meta['io.modelcontextprotocol/serverInfo']` (SHOULD). Our tool results
  already carry `content` + `structuredContent`; `isError` unchanged.
- Errors and HTTP status: `-32602` missing-required-`_meta` → 400;
  `-32020` header mismatch → 400; `-32021` missing client capability → 400
  (we require none, so never emitted); `-32022` → 400; `-32601` → 404. Every
  other JSON-RPC error (tool refusals as `isError` results, `-32602` unknown
  tool, `-32700`, `-32600`) stays at 200 as today. [support-2026] confirms the
  SDK keeps "every other handler-produced code … the in-band 200".
- `MissingRequiredClientCapabilityError`: "A server **MUST NOT** rely on
  capabilities the client has not declared." We rely on none.
- `io.modelcontextprotocol/logLevel`: "servers MUST NOT emit
  `notifications/message` for requests that did not include this field" —
  we never emit them; nothing to do.
- Notification POSTs on the modern lane: this revision "defines no
  client-to-server *notifications* over Streamable HTTP" and "header
  requirements for notification POSTs are not defined by this revision" — our
  id-less → 202 rule (`mcp.ts` 622–624) stays as is on both lanes.
- `Origin`: "Servers **MUST** validate the `Origin` header on all incoming
  connections … If the `Origin` header is present and invalid, servers
  **MUST** respond with HTTP 403 Forbidden." This MUST is not new in
  2026-07-28 (it is in the 2025-era binding too) and the gate does not do it
  today; recorded here as a pre-existing gap the migration should not
  pretend to close.
- Header names are case-insensitive; values case-sensitive
  ([streamable-http] "Case Sensitivity"). `Request.headers.get()` is already
  case-insensitive on Workers.
- `Mcp-Name` Base64 sentinel: `=?base64?…?=`; "servers **MUST** decode an
  encoded `Mcp-Name` … before comparing". Our tool names and
  `julian://package/<path>` URIs are ASCII, but a client MAY still encode
  (e.g. a URI with a space), so the decoder (~10 lines) is required.
- `x-mcp-header`/`Mcp-Param-*`: optional for servers; we declare none. The
  only server MUST that survives is "reject requests with a *recognized*
  `Mcp-Param-{Name}` header that contains invalid characters" — with no
  recognised names, nothing to implement. (Mentioned so the choice is
  deliberate: the scribe notes §4 want "the ledger written at the edge from
  the envelope" — `Mcp-Method`/`Mcp-Name` suffice for that; `Mcp-Param-*`
  would be a later opt-in per tool.)

## 5. The `_meta` fields and the cache fields, exactly

Reserved `_meta` keys in 2026-07-28 ([basic] "_meta", table):
`progressToken`, `io.modelcontextprotocol/protocolVersion`,
`io.modelcontextprotocol/clientInfo`, `io.modelcontextprotocol/clientCapabilities`,
`io.modelcontextprotocol/logLevel`, `io.modelcontextprotocol/subscriptionId`,
`traceparent`/`tracestate`/`baggage`. Per-request required: `protocolVersion`,
`clientCapabilities`. Per-response SHOULD: `io.modelcontextprotocol/serverInfo`.

Our `io.modelcontextprotocol/cacheControl` key (`mcp.ts` 26) is **not** in
that table. Its provenance (which draft/revision introduced it) was not
re-verified for this ticket; what is verified is that 2026-07-28 expresses
caching as top-level `ttlMs` + `cacheScope` on a `CacheableResult`
([changelog] m5, [caching]). On the modern lane the `_meta` hint should be
replaced, not duplicated (a reserved-prefix key the spec does not define is
"implementations MUST NOT make assumptions about values at these keys" —
harmless, but noise). On the legacy lane it can stay as is.

Required cache fields on the modern lane, with the value each of our
results should carry and why ([caching]):

| Result | `ttlMs` | `cacheScope` | Reason |
|---|---|---|---|
| `server/discover` | e.g. 3 600 000 | `public` | identical for every caller |
| `tools/list` | 300 000 (today's hint) | **`private`** | the list varies by lease scope (`visibleTools`, `mcp.ts` 225–227); "`private` is appropriate … for filtered list results that vary per user"; a `public` scope would let a shared cache hand a full-house listing to a reading-room token |
| `prompts/list` | 300 000 | `private` | varies by `scopeAllows(scope,'package','list')` (`mcp.ts` 678) |
| `resources/list` | **0** | `private` | REQUIRED now; `0` = "immediately stale", which preserves the COLD M-7 decision (a package URI carries no pin; `mcp.ts` 18–25) in the spec's own vocabulary instead of by omission |
| `resources/read` | **0** | `private` | same |
| `resources/templates/list` | — | — | not served (`-32601`) |

"`ttlMs` is absent → clients SHOULD assume a default of 0 … This should only
occur in older server versions" — so omission is tolerated by clients but is
a MUST-violation for a 2026-07-28 server; `0` is the conformant spelling of
"never cache".

## 6. SDK v2 package layout, and whether it runs on Workers

Layout ([README], [upgrade] "Packaging & runtime", [server npm]):

| Package | Role | Published |
|---|---|---|
| `@modelcontextprotocol/server` 2.0.0 | servers: `McpServer`, `createMcpHandler`, `WebStandardStreamableHTTPServerTransport`, `requireBearerAuth` (web-standard), `oauthMetadataResponse`, `isLegacyRequest`, `legacyStatelessFallback`, `hostHeaderValidationResponse`, `originValidationResponse`, `inputRequired`, `createRequestStateCodec`; subpaths `./stdio`, `./validators/ajv`, `./validators/cf-worker` | 2026-07-27T23:55Z; deps `zod ^4.2.0`, `@modelcontextprotocol/core 2.0.0`; `engines.node >= 20`; 6.3 MB unpacked (cjs+mjs+d.ts) |
| `@modelcontextprotocol/client` 2.0.0 | clients: `Client`, `StreamableHTTPClientTransport`, `versionNegotiation`, OAuth client helpers | same day |
| `@modelcontextprotocol/core` 2.0.0 | public Zod `*Schema` constants | deps `zod` only |
| `@modelcontextprotocol/core-internal` | private, never import | not published |
| `@modelcontextprotocol/node` / `express` / `hono` / `fastify` 2.0.0 | thin runtime adapters | not needed on Workers |
| `@modelcontextprotocol/server-legacy` 2.0.0 | frozen v1 `SSEServerTransport` + the v1 OAuth **authorization-server** router (`mcpAuthRouter` etc.); `deprecated` on npm, "planned for removal in v3" | irrelevant to us: our AS is our own (`broker/src/as/*`) |
| `@modelcontextprotocol/codemod` | `npx @modelcontextprotocol/codemod@latest v1-to-v2 .` — "handles the v1→v2 SDK surface upgrade only — adopting the 2026-07-28 protocol revision … is architectural and not codemod-automatable" ([migration]) | — |
| `@modelcontextprotocol/sdk` 1.30.0 | v1, "continues to receive bug fixes and security updates for at least 6 months after v2's release" ([README]) | 2026-07-27T17:54Z |

Tool/prompt schemas use Standard Schema ("bring Zod v4, Valibot, ArkType, or
any compatible library", [README]). **Not verified**: whether v2's
`registerTool` still accepts a raw JSON-Schema object as `inputSchema` (our
`TOOLS` are raw JSON Schema, `mcp.ts` 155–221); [upgrade] has a section
"Standard Schema objects (raw shapes deprecated)" that was not read in full.

Runs on Workers: yes, by the SDK's own account and shape.
- [web-standard]: "`createMcpHandler` returns a `{ fetch }` object — the
  shape Cloudflare Workers, Deno, and Bun expect … The deployed worker
  answers MCP requests on every path, with no Node adapter and no body
  middleware." Run/verify section names `wrangler dev server.ts`.
- `package.json` `exports["./_shims"]` has a `workerd` condition
  (`dist/shimsWorkerd.mjs`) beside `browser`/`node`; `./validators/cf-worker`
  exists (source `packages/server/src/validators/`, `shimsWorkerd.ts`).
- [authorization-v2]: "On hosts whose HTTP surface is a `fetch(request)`
  handler — Cloudflare Workers, Deno, Bun, Hono — the gate is
  `requireBearerAuth` from `@modelcontextprotocol/server`"; auth is
  pass-through: `handler.fetch(request, { authInfo })`, read as
  `ctx.http.authInfo`; "The per-request factory itself receives the same value
  as `ctx.authInfo`, so it can register a different tool set per caller before
  any handler runs" — the hook our `visibleTools(scope)` would move into.
- [http-v2]: `responseMode: 'json'` "never streams" — our JSON-only wire
  contract is expressible; `subscriptions/listen` still streams.
- Not measured: the bundled size of `@modelcontextprotocol/server` +
  `zod@4` inside a Workers bundle (the 6.3 MB is npm unpacked, three
  formats). The Workers 3 MB/10 MB compressed script limits were not checked
  against it.

Cloudflare's own layer ([cf-transport], [cf-handler], [cf-migrate],
[agents changelog]):
- `agents/mcp/server` `createMcpHandler(factory, options)` wraps the upstream
  handler and adds `route` (default `/mcp`), `legacy: "stateless" | "reject"`,
  `responseMode`, `allowedHostnames`, `allowedOriginHostnames`, `corsOptions`
  (default CORS preflights "allow the stateless `Mcp-Method` and `Mcp-Name`
  request headers"), `authContext`. Peer-pins **exactly**
  `@modelcontextprotocol/server@2.0.0` (and `sdk@1.30.0` for the legacy
  `createLegacyMcpHandler`/`McpAgent` lane, the latter "deprecated and
  feature-frozen"). `agents` 0.22.0 also peer-lists `ai`, `react`, `vite`,
  `zod ^4`, `@ai-sdk/react`, etc. — a large surface for one route.
- `@cloudflare/workers-oauth-provider` 0.10.3 (2026-08-10) is an
  **authorization server** with no dependencies; its README cites the
  2026-07-28 authorization pages and implements CIMD per
  `draft-ietf-oauth-client-id-metadata-document-00` "the revision pinned by
  MCP 2026-07-28". It has no MCP protocol version of its own; not relevant
  to the transport question, relevant to the CIMD sibling ticket.

## 7. Cost estimate (ESTIMATE — not measured, not planned)

Two paths. Both keep the legacy lane byte-identical to today.

### Path A — hand-rolled dual-era, no SDK in the worker (recommended for this ticket's question)

| # | File | Change | Rough lines | Risk |
|---|---|---|---|---|
| A1 | `broker/src/mcp.ts` | era detection after body parse (~lines 613–630): read `params._meta['io.modelcontextprotocol/protocolVersion']`; absent → existing switch unchanged | +15 | low |
| A2 | `broker/src/mcp.ts` | modern-lane validation: `MCP-Protocol-Version` ≡ `_meta` (else 400/`-32020`); version ∈ `SUPPORTED` (else 400/`-32022` with `data.supported`); `clientCapabilities` present (else 400/`-32602`); `Mcp-Method` ≡ `method`; `Mcp-Name` ≡ `params.name`/`params.uri` for the three methods, with `=?base64?…?=` decode | +60–80 | medium: the sentinel decoder and "missing vs mismatched" table have edge cases; a typo here 400s every modern client |
| A3 | `broker/src/mcp.ts` | `rpcResult`/`rpcError` gain an `era`+`status` parameter (or a modern-lane wrapper): stamp `resultType: 'complete'` + `_meta.serverInfo`; map `-32020/-32021/-32022`/missing-`_meta` → 400, `-32601` → 404 | +25 | low |
| A4 | `broker/src/mcp.ts` | `case 'server/discover'` (§4) | +20 | low |
| A5 | `broker/src/mcp.ts` | modern-lane cache fields on `tools/list`, `prompts/list`, `resources/list`, `resources/read` (§5); drop `_meta.cacheControl` on that lane | +15 | low; the `private` scope decision is a security choice, record it |
| A6 | `broker/src/mcp.ts` | modern lane: `initialize`, `ping` → `-32601`/404; resource errors `-32002` → `-32602` (legacy lane may follow — `-32002` is grandfathered either way) | +10 | low |
| A7 | `broker/src/index.ts` | none required. Optional: `Origin` validation (pre-existing MUST) | 0 (+10 if taken) | — |
| A8 | `broker/test/mcp.test.ts` | modern-lane tests: detection, each 400/404 rule, `server/discover` shape, cache fields, `resultType`, serverInfo stamp, sentinel decode, legacy lane unchanged (re-run all 78) | +250–350 | low |
| A9 | `broker/package.json` + `bun.lock` | add `@modelcontextprotocol/client@2.0.0` as a devDependency **beside** `sdk@1.30.0` ([upgrade]: different names, coexist; "objects must not flow between v1-imported and v2-imported code") | +1 dep | low; zod@4 arrives transitively in devDeps only |
| A10 | `broker/test-mcp-client/harness.test.ts` | a second connect path: `new Client(…, { versionNegotiation: { mode: { pin: '2026-07-28' } } })` from `@modelcontextprotocol/client`, over the same `StreamableHTTPClientTransport` (v2 import); prove `getProtocolEra() === 'modern'`, `tools/list`, `package_read`, and that the v1 `Client` (legacy) still passes in the same run; the `ping is exactly {}` leg (553–559) becomes legacy-only | +100–150 | medium: the v2 client sends `Accept: application/json, text/event-stream` and `Content-Type: application/json` (we answer JSON; fine), but the client's response-cache layer and `resultType` strictness are exactly the behaviours we have not yet exercised — expect a first run to find something |
| A11 | `docs/superpowers/specs/…` (spec §7 posture), scribe notes §8 item 1 | record the dual-era posture and the header-validation decision | prose | — |

Path A total: ~150–200 lines in `src/` (one file, plus an optional 10 in
`index.ts`), ~400–500 lines of tests across two files, one devDependency.
Nothing in the worker's runtime dependency list changes.

Risks specific to path A:
1. **Silent modern-client failure today** (§3): until A1–A3 land, a strict
   2026 client is answered 200 with no `resultType` and rejects locally; no
   ledger row records the mismatch. Detection + `-32022` is the cheapest
   first step and is deployable alone.
2. **Which era our real clients speak** (claude.ai connector, Claude Code)
   was not re-probed for this ticket; the legacy lane covers them regardless.
3. **`cacheScope: private`** must be chosen for the two lists; `public` is a
   scope-leak through shared caches ([caching] "Security Considerations").
4. **Lane drift**: two result shapes in one file. Mitigation: one
   `answer(era, id, result)` helper, tests that diff the legacy lane against
   today's fixtures.

### Path B — adopt `@modelcontextprotocol/server@2.0.0` `createMcpHandler` in the worker

| # | Change | Rough lines | Risk |
|---|---|---|---|
| B1 | replace `handleMcp` with a per-request factory: `new McpServer(SERVER_INFO, { capabilities })`, `registerTool` ×7 gated by `authInfo` scope, `registerResource`/prompt equivalents, `responseMode: 'json'`, `cacheHints` for the five results | −500 / +300 in `mcp.ts` | high: every ledgered-read/latch/sitting/shared-lease rule (`mcp.ts` 315–437) must be re-threaded through SDK handler context; the `-32002` classes, the exact `ping {}` and `_meta` contracts, and the "no session id ever" tests all change shape |
| B2 | map `LeaseIdentity` → `AuthInfo` (`{ token, clientId, scopes, expiresAt }`); keep our own `authenticate` in front, pass `{ authInfo }` | +30 | low |
| B3 | `broker/package.json`: `@modelcontextprotocol/server@2.0.0` + `zod@^4.2` become **runtime** deps; bundle size unmeasured | — | medium |
| B4 | `broker/test/mcp.test.ts`: 78 tests re-pointed from `handleMcp(req…)` to `handler.fetch(req, { authInfo })`; many assertions rewritten | ~1 000 lines touched | high |
| B5 | harness: as A9–A10 | +100–150 | medium |
| B6 | not verified: raw JSON-Schema `inputSchema` acceptance; `structuredContent` passthrough; whether `responseMode: 'json'` drops anything we emit (we emit no mid-call notifications, so likely nothing) | — | unknown |

Path B buys dual-era, header validation, `server/discover`, cache fields,
MRTR (`inputRequired`) and `subscriptions/listen` for free, which matters
for scribe-notes §8 items 2–4 (`record.append` with `input_required`
challenges; the record tail). It does not help item 1 more than path A does,
and it costs the SDK-less posture the spec §7 chose ("The SDK appears only
here, and only as a client", `harness.test.ts` 7–8).

Path C (Cloudflare `agents/mcp/server`) is path B plus the `agents` peer
surface; not costed further.

### Order that is deployable alone (scribe notes §8 item 1)

1. A1 + A2 + `-32022` only (answer modern requests honestly with
   `supported: ["2025-06-18"]`) — a strict 2026 client now fails **loudly
   and correctly**, and a dual-era client falls back to `initialize`.
   Smallest possible change, fully conformant with [versioning] for a
   modern-only-rejecting server.
2. A3–A6 + A8 (the modern lane proper).
3. A9–A10 (the outside witness).
4. Then the CIMD re-probe (sibling ticket).

## 8. What was not verified

- Whether the 2026-07-28 `lifecycle` page exists separately: the URL
  `…/2026-07-28/basic/lifecycle` returned the **versioning** page's content
  (redirect or alias); treated as the same source.
- The origin of `io.modelcontextprotocol/cacheControl` (our current hint key).
- v2 `registerTool` acceptance of raw JSON-Schema `inputSchema`.
- Workers bundle size of `@modelcontextprotocol/server` + `zod@4`.
- The era currently spoken by claude.ai's connector and Claude Code.
- The 2025-11-25 changelog (deltas between our `2025-06-18` and the previous
  revision) — out of scope; the design above advertises only versions we
  implement.
- Cloudflare's `/agents/model-context-protocol/mcp-server/` URL: 404; the
  transport, handler-API, migrate-to-v2 and authorization pages were read
  instead.

## 9. Sources (all read 2026-08-28)

Spec, 2026-07-28:
- [versioning] https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- [streamable-http] https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- [changelog] https://modelcontextprotocol.io/specification/2026-07-28/changelog
- [discover] https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- [basic] https://modelcontextprotocol.io/specification/2026-07-28/basic/index (the `_meta` and "JSON Schema Usage" sections)
- [caching] https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching
- [schema] https://modelcontextprotocol.io/specification/2026-07-28/schema (`HeaderMismatchError`, `UnsupportedProtocolVersionError`, `DiscoverResult`)
- [tools] https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- [resources] https://modelcontextprotocol.io/specification/2026-07-28/server/resources
- [prompts] https://modelcontextprotocol.io/specification/2026-07-28/server/prompts
- (lifecycle) https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle — resolved to the versioning content, see §8

TypeScript SDK v2:
- [v2 index] https://ts.sdk.modelcontextprotocol.io/v2/
- [migration] https://ts.sdk.modelcontextprotocol.io/v2/migration/
- [upgrade] https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html (TL;DR, "Packaging & runtime", "Imports & transports", "HTTP & headers", "Errors")
- [support-2026] https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html (whole page)
- [web-standard] https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard.html
- [http-v2] https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html
- [authorization-v2] https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html
- [legacy-clients] https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html
- [protocol-versions] https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html
- [README] https://github.com/modelcontextprotocol/typescript-sdk (README.md on `main`; `packages/` listing: client, codemod, core-internal, core, middleware, server-legacy, server; `packages/server/package.json`; `packages/server-legacy/README.md` + `package.json`; `packages/core/package.json`; `packages/server/src` listing; `examples/` listing and `examples/dual-era/{README.md,server.ts}`)
- GitHub releases API: `1.30.0` 2026-07-27T17:54:36Z; `@modelcontextprotocol/server@2.0.0`, `server-legacy@2.0.0`, `node@2.0.0`, `hono@2.0.0` 2026-07-27T23:55Z
- [server npm] https://registry.npmjs.org/@modelcontextprotocol%2Fserver (2.0.0, `engines.node>=20`, deps `zod ^4.2.0` + `core 2.0.0`, exports `. ./stdio ./_shims ./validators/ajv ./validators/cf-worker`, unpacked 6 299 914 B); likewise `%2Fserver-legacy`, `%2Fcore`, `%2Fsdk` (dist-tag latest 1.30.0, 2026-07-27T17:56Z)

Cloudflare:
- [cf-mcp] https://developers.cloudflare.com/agents/model-context-protocol/
- [cf-transport] https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/
- [cf-handler] https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- [cf-migrate] https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/
- [cf-auth] https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- [agents npm] https://registry.npmjs.org/agents (0.20.0 2026-07-27T17:57Z peer `server@2.0.0-beta.5`; 0.21.0 2026-08-18; 0.22.0 2026-08-27 peer `server@2.0.0`, `client@2.0.0`, `sdk@1.30.0`)
- [agents changelog] https://raw.githubusercontent.com/cloudflare/agents/main/packages/agents/CHANGELOG.md (0.20.0 entry #1557) and `packages/agents/package.json`
- [oauth-provider] https://raw.githubusercontent.com/cloudflare/workers-oauth-provider/main/README.md and CHANGELOG.md (0.10.3, 2026-08-10); https://registry.npmjs.org/@cloudflare%2Fworkers-oauth-provider

Local (this worktree, branch `research/mcp-sdk-v2`):
- `broker/src/mcp.ts`, `broker/src/index.ts`, `broker/package.json`, `broker/bun.lock`, `broker/wrangler.toml`, `broker/vitest.node.config.ts`, `broker/test/mcp.test.ts`, `broker/test-mcp-client/harness.test.ts`, `docs/superpowers/specs/2026-08-28-scribe-elf6-mcp-binding-notes.md` §4, §8
