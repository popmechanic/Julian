# CIMD in the wild — who identifies by metadata document vs DCR (August 2026)

**Wayfinder ticket:** #64 · **Date read:** 2026-08-27 (all web reads this date unless noted)
**Question:** As of late August 2026, which MCP clients present an https-URL
`client_id` (OAuth Client ID Metadata Documents, CIMD) versus Dynamic Client
Registration (DCR), and which authorization servers advertise
`client_id_metadata_document_supported`?
**Method:** primary sources only — spec text, vendor docs, changelogs, GitHub
issues/PRs, and read-only GETs of public `.well-known` / metadata documents.
No live probes against third-party services. Where evidence was not found the
cell says **unknown**; nothing below is inferred from training data.
**Prior measurement:** `docs/superpowers/specs/2026-08-09-cimd-probe-protocol.md`
(Aug 9 2026 — Claude Code 2.1.226, MCP Inspector 2.1.0, claude.ai custom
connector: all three registered by DCR against a probe AS that did **not**
advertise `client_id_metadata_document_supported`).

## 0. The spec, verbatim where it matters

- **MCP 2026-07-28, Client Registration** (read 2026-08-27): "Clients supporting all
  options **SHOULD** use the following priority order: 1. pre-registered client
  information … 2. Client ID Metadata Documents if the Authorization Server
  indicates that it supports them (via `client_id_metadata_document_supported`
  …) 3. Dynamic Client Registration as a fallback … 4. Prompt the user."
  "MCP clients and authorization servers **SHOULD** support OAuth Client ID
  Metadata Documents … [draft-ietf-oauth-client-id-metadata-document-00]."
  DCR: "Dynamic Client Registration is deprecated. New implementations should
  use Client ID Metadata Documents instead. This option remains available for
  backwards compatibility with authorization servers that do not support
  Client ID Metadata Documents." Clients/AS "**MAY** support" RFC 7591.
- **MCP 2026-07-28 changelog, Deprecated §4:** "Deprecate the OAuth 2.0 Dynamic
  Client Registration Protocol (RFC7591) as a client registration mechanism in
  favor of Client ID Metadata Documents (PR #2858). It remains available for
  backwards compatibility …" Feature-lifecycle policy: minimum twelve-month
  deprecation window before removal.
- **MCP 2025-11-25** already carried the same priority order and "SHOULD support
  CIMD / MAY support DCR" language; 2026-07-28 adds the formal deprecation.
- **IETF draft:** `draft-ietf-oauth-client-id-metadata-document` — latest
  revision **-02, dated 2026-07-06**; state "I-D Exists" (OAuth WG; no WGLC,
  no IESG state). Authors Aaron Parecki (Okta), Emelia Smith. MCP normatively
  references **-00** (2025-10-08). AS metadata parameter:
  `client_id_metadata_document_supported` — "Boolean value specifying whether
  the authorization server supports retrieving client metadata from a
  `client_id` URL as described in this specification."

The key behavioural consequence, common to every implementation found below:
**a client only presents a URL `client_id` if the AS metadata says
`client_id_metadata_document_supported: true`.** An AS that does not advertise
the flag will never see CIMD from a conforming client, regardless of what the
client is capable of. This is why the Aug 9 probe saw zero CIMD: the probe AS
did not advertise the flag.

## 1. Clients → mechanism

Legend: **CIMD** = presents https-URL `client_id` when the AS advertises support;
**DCR** = registers at `registration_endpoint`; **pre-reg** = static client id
entered/configured. "Default" means what happens with no operator configuration.

| Client | Mechanism (Aug 2026) | Evidence (source · date) |
|---|---|---|
| **Claude Code** (CLI; local 2.1.250) | **CIMD when AS advertises it, else DCR, else pre-reg** (`--client-id`/`--client-secret`). CIMD doc: `https://claude.ai/oauth/claude-code-client-metadata` → `client_id` same URL, `client_name` "Claude Code", `redirect_uris` `["http://localhost/callback","http://127.0.0.1/callback"]` (port-less), `token_endpoint_auth_method` `none`. | Claude Code CHANGELOG **2.1.81**: "Updated MCP OAuth to support Client ID Metadata Document (CIMD / SEP-991) for servers without Dynamic Client Registration" (raw CHANGELOG.md, read 2026-08-27). CHANGELOG **2.1.243**: "Fixed MCP server sign-in started from the desktop app failing with 'Invalid redirect URI' on servers that support client ID metadata documents (for example Linear)". code.claude.com/docs/en/mcp: "Claude Code also supports servers that use a Client ID Metadata Document (CIMD) instead of Dynamic Client Registration, and discovers these automatically." Field reports of the URL `client_id` on the wire: anthropics/claude-code #37747 (2.1.80–81, Mar 23 2026, closed May 24 2026), #47185 (2.1.104, Apr 13 2026: `client_id=https://claude.ai/oauth/claude-code-client-metadata` sent to Linear, closed May 23 2026), #44388 (open, Apr 6 2026, asks for `logo_uri` in the CIMD doc). Metadata document GET 200 `application/json` 2026-08-27. |
| **claude.ai / Claude Desktop / Claude mobile / Cowork** (hosted surfaces, custom connectors) | **CIMD when AS advertises it AND `none` ∈ `token_endpoint_auth_methods_supported`; otherwise DCR.** Also pre-reg via "Advanced settings" client id/secret, and `oauth_anthropic_creds` (directory partners). CIMD doc: `https://claude.ai/oauth/mcp-oauth-client-metadata` → `client_name` "Claude", `redirect_uris` `["https://claude.ai/api/mcp/auth_callback"]`, grants incl. `jwt-bearer`, `token_endpoint_auth_method` `none`. | claude.com/docs/connectors/building/authentication (read 2026-08-27): table lists `oauth_dcr` and `oauth_cimd` both "Supported out of the box"; "The same infrastructure backs Claude.ai, Claude Desktop, Claude mobile, Claude Code, and Cowork"; "Claude selects CIMD only when your authorization server metadata advertises **both** `"client_id_metadata_document_supported": true` **and** `"none"` in `token_endpoint_auth_methods_supported` … If either is missing, Claude falls back to DCR." "For servers expecting high traffic … prefer CIMD or `oauth_anthropic_creds` over DCR. DCR causes Claude to register a new client on every fresh connection." Metadata document GET 200 2026-08-27. The Aug 9 probe's DCR result for claude.ai is consistent: the probe AS did not advertise the flag. |
| **ChatGPT** (apps / connectors) | **CIMD preferred when AS advertises it; DCR when configured; pre-reg supported.** CIMD docs: `https://chatgpt.com/oauth/client.json` (stable redirect) or `https://chatgpt.com/oauth/{callback_id}/client.json`. Live doc: `redirect_uris` `["https://chatgpt.com/connector_platform_oauth_redirect"]`, `token_endpoint_auth_method` `private_key_jwt`, `token_endpoint_auth_methods_supported` `["none","private_key_jwt"]`, `jwks_uri` `https://chatgpt.com/oauth/jwks.json`. | developers.openai.com/plugins/build/auth: "ChatGPT prioritizes CIMD when it is available, but the plugin builder can choose DCR when both CIMD and DCR are available"; "ChatGPT supports CIMD with public-client token exchange (`none`) or signed client assertion token exchange (`private_key_jwt`)". developers.openai.com/api/docs/mcp: "Dynamic client registration remains supported when configured." Metadata document GET 200 2026-08-27. |
| **Codex** (OpenAI CLI/IDE) | **CIMD when AS advertises `client_id_metadata_document_supported: true` "and meets other conditions"; DCR otherwise; pre-reg `client_id` accepted.** CIMD doc per server: `https://chatgpt.com/oauth/codex/<callback_id>/client.json`. | learn.chatgpt.com/docs/extend/mcp (read 2026-08-27). |
| **Responses API MCP tool** (OpenAI hosted) | **Neither** — developer supplies the bearer token; "OAuth client registration and authorization must be handled separately by your application." | developers.openai.com/api/docs/guides/tools-connectors-mcp. |
| **VS Code** (built-in MCP) | **CIMD when AS advertises it; DCR fallback; pre-reg via `oauth.clientId` in mcp.json.** CIMD doc: `https://vscode.dev/oauth/client-metadata.json` → `client_name` "Visual Studio Code", `application_type` `native`, `redirect_uris` `["http://127.0.0.1:33418/","https://vscode.dev/redirect"]`, grants incl. `device_code`, `token_endpoint_auth_method` `none`. | microsoft/vscode PR **#271403 "Use CIMD if supported"**, merged 2025-10-14. den.dev/blog/cimd-vs-code-mcp (2025-11-17): "Starting last week, Visual Studio Code supports CIMD for MCP in its stable build. It hosts its CIMD here: https://vscode.dev/oauth/client-metadata.json". Metadata document GET 200 2026-08-27. Exact VS Code release number: **unknown** (not read from release notes). |
| **Cursor** | **DCR** (plus static credentials). **No CIMD** as of Aug 25 2026. | forum.cursor.com thread 148096: Cursor staff Jan 6 2026: "Cursor supports OAuth for MCP servers via Dynamic Client Registration (DCR) and static credentials. About CIMD … There isn't a specific timeline"; staff May 13 2026: "We don't have a timeline to share yet"; user posts Aug 13/14/25 2026 still "+1 for CIMD support", "currently it is impossible to set it up using Cursor." |
| **MCP Inspector** (official; 2.4.0 released 2026-08-26) | **DCR by default; CIMD available when configured** (`--client-metadata-url` flag / `client.json` "client metadata URL" setting); pre-reg via `--client-id`/`--client-secret`; enterprise-managed IdP option. | modelcontextprotocol.io/docs/2026-07-28/tools/inspector/authorization: "The Inspector identifies itself … through whichever mechanism is configured: dynamic client registration, a pre-registered static client (`--client-id` / `--client-secret`), a Client ID Metadata Document (`--client-metadata-url`), or an enterprise-managed IdP." Inspector issue #1150 (opened 2026-03-16, closed). Aug 9 probe: v2.1.0 registered by DCR (no flag advertised, no metadata URL configured). Whether a *default* metadata URL ships when nothing is configured: **unknown**. |
| **MCP TypeScript SDK** (client helper, v1 and v2) | **CIMD if `provider.clientMetadataUrl` is set AND AS advertises the flag; else DCR; pre-reg via `clientInformation()`.** No default metadata URL — the app must host one. | typescript-sdk PR #1127 "feat: url based client metadata registration (SEP 991)", merged 2025-11-19 (issue #1052). v2 `packages/client/src/client/auth.ts` (main, read 2026-08-27): `const supportsUrlBasedClientId = metadata?.client_id_metadata_document_supported === true; … shouldUseUrlBasedClientId = supportsUrlBasedClientId && clientMetadataUrl`. v2 client CHANGELOG: `registerClient` marked `@deprecated` "(Dynamic Client Registration; prefer Client ID Metadata Documents per SEP-991)"; `validateClientMetadataUrl()` added (#1653). The v2 docs page `/v2/clients/oauth.html` shows only `clientMetadata` + DCR and does not mention `clientMetadataUrl`. |
| **MCP Python SDK** (client) | **CIMD if `client_metadata_url` set AND AS advertises the flag; else DCR.** Server/AS side: **no CIMD** (cannot advertise or fetch). | python-sdk PR #1652 "feat: implement SEP-991 URL-based client ID (CIMD) support", merged 2025-11-24, shipped in **v1.23.0** (2025-12-02). Issue #1801 (open, 2025-12-18): "Authorization servers built with the Python SDK cannot currently support CIMD." |
| **MCP C# SDK** (client) | **CIMD first if `ClientMetadataDocumentUri` set; falls back to DCR if enabled.** | csharp-sdk PR #1023 "Add support for Client ID Metadata Documents to enable URL-based client registration", merged 2025-11-26; `ClientOAuthOptions.cs` contains `ClientMetadataDocumentUri`. |
| **MCP Go SDK** (client) | **CIMD if `ClientIDMetadataDocumentConfig` set AND `asm.ClientIDMetadataDocumentSupported`.** | go-sdk `auth/authorization_code.go` (main, read 2026-08-27): `if cimdCfg != nil && asm.ClientIDMetadataDocumentSupported { … clientID: cimdCfg.URL`. Release version: **unknown**. |
| **FastMCP** (Python framework, client) | **CIMD via `OAuth(client_metadata_url=…)`, "New in version 3.0.0"; otherwise DCR.** Server side: OAuth-proxy providers "support CIMD by default" (docs); whether they emit the flag: **unknown** from the page read. | gofastmcp.com/clients/auth/cimd; PrefectHQ/fastmcp issue #2863 (opened 2026-01-13, closed). |
| **mcp-use** | **unknown** — no CIMD/DCR documentation found; code search for `client_metadata_url`/`clientMetadataUrl` in mcp-use/mcp-use returned nothing (gh search, 2026-08-27). | — |
| **Claude Managed Agents / Claude API MCP connector** | **unknown** ("Claude Managed Agents uses a separate credential set" — claude.com auth doc; mechanism not stated). | claude.com/docs/connectors/building/authentication. |

Observed on the wire, Aug 9 probe (all DCR — consistent with the rule above, since the probe AS did not advertise CIMD): Claude Code 2.1.226, Inspector 2.1.0, claude.ai connector (`python-httpx/0.28.1`, `clientInfo` "Anthropic").

## 2. Authorization servers → `client_id_metadata_document_supported`

| Authorization server | Advertises the flag? | Evidence (source · date) |
|---|---|---|
| **Linear** `https://mcp.linear.app` | **`true`** (live) — also `registration_endpoint`, `none` in token auth methods, `id-jag` grant profile | GET `/.well-known/oauth-authorization-server` 2026-08-27 |
| **Granola** `https://mcp-auth.granola.ai` | **`true`** (live) — also `registration_endpoint`, `device_authorization_endpoint` | GET via `https://mcp.granola.ai/.well-known/oauth-authorization-server` 2026-08-27 |
| **Slack** `https://mcp.slack.com` | **absent** (live) — no `registration_endpoint` either; `client_secret_post` only | GET 2026-08-27 (claude-code #37747 listed Slack as affected in Mar 2026; the live doc today does not carry the flag) |
| **Cloudflare `@cloudflare/workers-oauth-provider`** | **Configurable**: `true` only when `clientIdMetadataDocumentEnabled: true` AND wrangler `compatibility_flags: ["global_fetch_strictly_public"]`; otherwise reports `false`. Validates per draft-00; 5 KB / 10 s fetch limits; cache ≤ 7 days. | README (read 2026-08-27); earliest release body mentioning it: **v0.2.2, 2025-12-20**; hardening PRs #248, #254 merged 2026-07-29; latest v0.10.3 2026-08-10 |
| **Auth0** | **Yes, when the tenant toggle "Client ID Metadata Document Registration" (Settings › Advanced) is on.** Model is **admin pre-import** of the CIMD URL, not open fetch at authorize time: "a tenant admin registers the application by importing its externally hosted CIMD"; "Rate limits for CIMD clients will be introduced in a future release." | auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd; oauth.net lists Auth0 as "coming soon" |
| **Okta** (Workforce/CIC platform, not Auth0) | **unknown** — no developer.okta.com page found mentioning the flag or CIMD (searches 2026-08-27). Okta ships the enterprise-managed-auth (Cross App Access) side instead. | — |
| **Stytch Connected Apps** | **`true` when enabled** in the Connected Apps dashboard ("CIMD discovery and registration" toggle). Announced **2025-10-17**. All CIMD clients are "Third-Party Public". | changelog.stytch.com announcement; stytch docs client-types; den.dev shows a Stytch AS doc with `"client_id_metadata_document_supported": true` |
| **WorkOS Connect / AuthKit** | **Supported since 2025-11-30**, "off by default … enable it in the WorkOS Dashboard under Connect → Configuration"; DCR still supported. Whether the flag is emitted once enabled: **unknown** from pages read. | workos.com/changelog/client-id-metadata-support-for-mcp-auth; workos.com/blog/mcp-client-identity-dcr-cimd-auth-md (2026-08-12) |
| **Clerk** | **CIMD beta, 2026-08-06**: "A compatible client uses an HTTPS URL as its `client_id`." Flag emission: **unknown** from page read. | clerk.com/changelog/2026-08-06-client-id-metadata-documents |
| **Authlete** | **Yes** — "Authlete has supported CIMD since version 3.0.22" (completed Nov 2025); when service property `clientIdMetadataDocumentSupported` is true the discovery doc includes `client_id_metadata_document_supported: true`. | developers.authlete.com CIMD page |
| **Pocket ID** | **Yes, gated by `CIMD_ENABLED` (default off)**; when on, discovery "advertises client_id_metadata_document_supported". PR #1526 merged **2026-08-02**, released **v2.13.0, 2026-08-07**; follow-up #1692 (admin auto-grant to CIMD clients). **Our instance `https://souls.exe.xyz` does not advertise the flag** (live discovery doc 2026-08-27: no `client_id_metadata_document_supported`, no `registration_endpoint`). | github.com/pocket-id/pocket-id/pull/1526; GET souls.exe.xyz/.well-known/openid-configuration |
| **Better Auth (`cimd` plugin)** | AS-side plugin exists; validates against **draft-02**. Flag emission: **unknown** from page read. | better-auth.com/docs/plugins/cimd |
| **Descope, Scalekit, Ping, Authplane** | Listed as CIMD-supporting OAuth servers on oauth.net; not independently verified here. | oauth.net/2/client-id-metadata-document/ |
| **MCP Python SDK auth server** | **No** (issue #1801 open). | github.com/modelcontextprotocol/python-sdk/issues/1801 |
| **MCP TS SDK `server-legacy` `mcpAuthRouter`** | **unknown** — not read. | — |
| **Julian gate** `https://gate.julian.soul.store` | **absent** (live): `registration_endpoint` present, `scopes_supported: ["reading-room"]`, `token_endpoint_auth_methods_supported: ["none"]`, `authorization_response_iss_parameter_supported: true`, **no** `client_id_metadata_document_supported`. | GET `/.well-known/oauth-authorization-server` 2026-08-27 |

oauth.net's implementation list (read 2026-08-27) names as CIMD **MCP clients**: VSCode, MCPJam, Claude.ai, ChatGPT; as **servers**: Auth0 (coming soon), Authlete, Authplane, Descope, Ping, Scalekit, Stytch, WorkOS; as **services**: Bluesky (the pre-MCP production user of the pattern).

## 3. What this means for the gate (facts, not decisions)

1. **The Aug 9 "zero CIMD" result was a property of our probe AS, not of the clients.** Every client surveyed gates CIMD on `client_id_metadata_document_supported: true` in the AS metadata. The probe never advertised it, so no client could have shown it. Today's gate metadata also does not advertise it (§2, last row), so the same three clients would still DCR against the gate today.
2. **The clients that matter to the house are CIMD-capable now:** Claude Code (since 2.1.81; local build 2.1.250), the hosted Claude surfaces (claude.ai / Desktop / mobile / Cowork — `oauth_cimd` "supported out of the box"), ChatGPT and Codex, VS Code, the four official SDKs, FastMCP 3. The identities they would present are fixed, published URLs: `https://claude.ai/oauth/claude-code-client-metadata`, `https://claude.ai/oauth/mcp-oauth-client-metadata`, `https://chatgpt.com/oauth/client.json` (+ callback-id variants), `https://vscode.dev/oauth/client-metadata.json`.
3. **Cursor is the notable DCR-only holdout** (staff statements Jan and May 2026; no shipped support as of Aug 25 2026). MCP Inspector is DCR by default and CIMD only when a metadata URL is configured.
4. **Anthropic's extra condition:** the hosted Claude surfaces require `"none"` in `token_endpoint_auth_methods_supported` in addition to the flag; the gate already advertises exactly `["none"]`.
5. **Loopback redirect matching is the known CIMD sharp edge for Claude Code.** Its document declares port-less `http://localhost/callback` and `http://127.0.0.1/callback`; the actual redirect carries an ephemeral port (e.g. `:3118`, `:53076`). Anthropic's doc: "your authorization server must accept both with the port component ignored" (RFC 8252 §7.3 posture). Linear rejected this in Apr 2026 (#47185); the desktop-initiated path was fixed on the Claude side by 2.1.243. An AS that exact-matches redirect URIs will break Claude Code over CIMD.
6. **ChatGPT authenticates as `private_key_jwt`** at the token endpoint (its document carries a `jwks_uri`); its document lists `none` and `private_key_jwt` as supported methods. An AS supporting only `none` sees the public-client form.
7. **AS-side obligations named by the spec** for whoever turns the flag on: fetch on URL-formatted `client_id`, exact `client_id` match, redirect-URI validation against the document, JSON structure validation, SSRF protection (Cloudflare's library refuses to advertise the flag without `global_fetch_strictly_public`), caching per HTTP headers, and clear display of the redirect hostname on consent for loopback-only clients. The spec's security-considerations page adds trust-policy options (allowlist / open / reputation).
8. **The spec keeps DCR alive for at least twelve months from 2026-07-28**, and every surveyed client still falls back to DCR. Turning CIMD on at the gate is additive; turning DCR off is a separate step the clients above would tolerate (they all have pre-reg or CIMD paths) except Cursor.
9. **Draft status:** MCP pins draft-00; the IETF draft is at -02 (2026-07-06) with no WGLC. Better Auth already validates against -02. Divergences between -00 and -02 were not read for this ticket.
10. **Our Pocket ID (souls.exe.xyz) could advertise the flag** by upgrading to ≥ v2.13.0 and setting `CIMD_ENABLED` (off by default); it does not today. This matters only if the gate ever delegates client identity to Pocket ID rather than handling it itself.

## 4. Sources (URL · date read · what it established)

Spec and standards
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration · 2026-08-27 · priority order; SHOULD CIMD; DCR deprecated warning; flag name
- https://modelcontextprotocol.io/specification/2026-07-28/changelog · 2026-08-27 · Deprecated §4 (PR #2858); twelve-month window
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization · 2026-08-27 · same priority order already in 2025-11-25; CIMD security considerations
- https://blog.modelcontextprotocol.io/posts/2026-07-28/ · 2026-08-27 · "Dynamic Client Registration itself is now formally deprecated in favor of CIMD"; all four Tier-1 SDKs speak 2026-07-28
- https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00 · 2026-08-27 · -00 dated 2025-10-08; parameter definition
- https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/ · 2026-08-27 · latest -02, 2026-07-06; I-D Exists
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/991 · 2026-08-27 · SEP-991, accepted; prototype PR typescript-sdk #839; Bluesky prior art
- https://oauth.net/2/client-id-metadata-document/ · 2026-08-27 · implementation list

Anthropic / Claude
- https://claude.com/docs/connectors/building/authentication · 2026-08-27 · `oauth_cimd` out of the box; selection rule (flag + `none`); surfaces; callback URLs; DCR volume warning
- https://code.claude.com/docs/en/mcp (redirect from docs.anthropic.com/en/docs/claude-code/mcp) · 2026-08-27 · CIMD auto-discovery; `--client-id`/`--client-secret`; 2.1.229/2.1.231 localhost note
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md · 2026-08-27 · 2.1.81 CIMD entry; 2.1.243 desktop/Linear fix; top version 2.1.250
- https://claude.ai/oauth/claude-code-client-metadata · 2026-08-27 · live document (200)
- https://claude.ai/oauth/mcp-oauth-client-metadata · 2026-08-27 · live document (200)
- https://github.com/anthropics/claude-code/issues/37747 · 2026-08-27 · regression 2.1.80; URL client_id observed; closed 2026-05-24
- https://github.com/anthropics/claude-code/issues/47185 · 2026-08-27 · 2.1.104 sent URL client_id to Linear; closed 2026-05-23
- https://github.com/anthropics/claude-code/issues/36861 · 2026-08-27 · docs request, closed
- https://github.com/anthropics/claude-code/issues/44388 · 2026-08-27 · logo_uri request, open
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp · 2026-08-27 · Advanced settings client id/secret; surfaces; no CIMD/DCR mention
- https://leduccc.medium.com/testing-cimd-support-across-anthropics-claude-products-585366dbe089 · 2026-08-27 · **not readable (403 / empty)** — not used
- https://docs.strata.io/guides/ai-identity/connect/claude · 2026-08-27 · gateway vendor doc using self-asserted ids; not evidence about Claude's own behaviour — not used

OpenAI
- https://developers.openai.com/plugins/build/auth · 2026-08-27 · CIMD preferred; URLs; DCR/pre-reg options
- https://developers.openai.com/api/docs/mcp · 2026-08-27 · `none` / `private_key_jwt`; DCR "when configured"
- https://learn.chatgpt.com/docs/extend/mcp · 2026-08-27 · Codex CIMD selection and per-server URL
- https://developers.openai.com/api/docs/guides/tools-connectors-mcp · 2026-08-27 · Responses API: developer supplies token
- https://chatgpt.com/oauth/client.json · 2026-08-27 · live document (200)

VS Code / Cursor / Inspector
- https://github.com/microsoft/vscode/pull/271403 · 2026-08-27 · "Use CIMD if supported", merged 2025-10-14
- https://den.dev/blog/cimd-vs-code-mcp/ · 2026-08-27 · published 2025-11-17; VS Code stable CIMD; Stytch demo AS metadata
- https://vscode.dev/oauth/client-metadata.json · 2026-08-27 · live document (200)
- https://forum.cursor.com/t/mcp-oauth-cimd-support-plans-and-timelines/148096 (+ ?page=2) · 2026-08-27 · staff statements Jan 6 / May 13 2026; user posts to Aug 25 2026
- https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/authorization · 2026-08-27 · `--client-metadata-url`; mechanism "whichever is configured"
- https://github.com/modelcontextprotocol/inspector/issues/1150 · 2026-08-27 · CIMD request, opened 2026-03-16, closed
- Inspector releases (gh) · 2026-08-27 · 2.4.0 on 2026-08-26

SDKs / frameworks
- https://github.com/modelcontextprotocol/typescript-sdk/pull/1127 · 2026-08-27 · merged 2025-11-19; `clientMetadataUrl`
- https://github.com/modelcontextprotocol/typescript-sdk/issues/1052 · 2026-08-27 · tracking issue, closed
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/client/src/client/auth.ts · 2026-08-27 · v2 gating code
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/client/CHANGELOG.md · 2026-08-27 · `registerClient` deprecated; `validateClientMetadataUrl`
- https://ts.sdk.modelcontextprotocol.io/v2/ and /v2/clients/oauth.html · 2026-08-27 · docs page shows DCR only
- https://github.com/modelcontextprotocol/python-sdk/pull/1652 · 2026-08-27 · merged 2025-11-24
- python-sdk release v1.23.0 (gh) · 2026-08-27 · published 2025-12-02, lists #1652
- https://github.com/modelcontextprotocol/python-sdk/issues/1801 · 2026-08-27 · server-side missing, open
- https://github.com/modelcontextprotocol/csharp-sdk/pull/1023 · 2026-08-27 · merged 2025-11-26
- https://github.com/mikekistler/mcp-whats-new · 2026-08-27 · C# fallback-to-DCR behaviour
- https://raw.githubusercontent.com/modelcontextprotocol/go-sdk/main/auth/authorization_code.go · 2026-08-27 · Go gating code
- https://gofastmcp.com/clients/auth/cimd · 2026-08-27 · `client_metadata_url`, new in 3.0.0
- https://github.com/PrefectHQ/fastmcp/issues/2863 · 2026-08-27 · opened 2026-01-13, closed
- gh code search mcp-use/mcp-use · 2026-08-27 · no hits

Authorization servers
- https://mcp.linear.app/.well-known/oauth-authorization-server · 2026-08-27 · flag true
- https://mcp.granola.ai/.well-known/oauth-authorization-server · 2026-08-27 · flag true
- https://mcp.slack.com/.well-known/oauth-authorization-server · 2026-08-27 · flag absent
- https://github.com/cloudflare/workers-oauth-provider · 2026-08-27 · README CIMD section; releases/PRs via gh
- https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd · 2026-08-27 · tenant toggle; admin-import model
- https://changelog.stytch.com/announcements/client-id-metadata-documents-cimd-1 · 2026-08-27 · 2025-10-17
- https://stytch.com/blog/oauth-client-id-metadata-mcp/ · 2026-08-27 · 2025-09-29 explainer
- https://client.dev/ · 2026-08-27 · Stytch-run explainer site; no implementation list
- https://workos.com/changelog/client-id-metadata-support-for-mcp-auth · 2026-08-27 · 2025-11-30
- https://workos.com/blog/mcp-client-identity-dcr-cimd-auth-md · 2026-08-27 · 2026-08-12
- https://clerk.com/changelog/2026-08-06-client-id-metadata-documents · 2026-08-27 · published 2026-08-06, beta
- https://developers.authlete.com/protocols-and-flows/protocol-extensions/oauth-client-id-metadata-document-cimd · 2026-08-27 · since 3.0.22
- https://github.com/pocket-id/pocket-id/pull/1526 · 2026-08-27 · merged 2026-08-02; v2.13.0 2026-08-07 (gh)
- https://souls.exe.xyz/.well-known/openid-configuration · 2026-08-27 · flag absent
- https://better-auth.com/docs/plugins/cimd · 2026-08-27 · draft-02 validation
- https://gate.julian.soul.store/.well-known/oauth-authorization-server · 2026-08-27 · flag absent
- https://mcporbit.com/blog/migrate-mcp-auth-dcr-to-cimd · 2026-08-27 · 2026-08-07 migration guide; names no clients/servers — not used as evidence
- Okta: developer.okta.com searches · 2026-08-27 · nothing found → unknown

Local
- docs/superpowers/specs/2026-08-09-cimd-probe-protocol.md · Aug 9 2026 probe results
- docs/superpowers/specs/2026-08-28-scribe-elf6-mcp-binding-notes.md §3 · CIMD as the naming mechanism; the B4 tripwire
