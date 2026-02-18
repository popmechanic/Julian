# Anthropic API Compliance Audit — Authentication & Credential Use

**Date**: 2026-02-18
**Policy Reference**: https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use
**Scope**: Julian codebase — server/server.ts, chat.jsx, index.html

## Policy Summary

Anthropic's authentication and credential use policy states:

1. **OAuth tokens** from Free, Pro, and Max plans are **exclusively for Claude Code and Claude.ai**. Using them in "any other product, tool, or service" — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service.

2. **Developers building products or services** that interact with Claude's capabilities must use **API key authentication via Claude Console** or a supported cloud provider. Anthropic **does not permit** third-party developers to offer Claude.ai login or route requests through Free, Pro, or Max plan credentials on behalf of their users.

---

## Findings

### Finding 1: OAuth PKCE Flow Uses Consumer Credentials in a Third-Party Product

**Severity**: High — likely non-compliant
**Location**: `server/server.ts:24-29`

The server implements a full OAuth PKCE flow against Claude.ai's authorization endpoints using a Client ID extracted from the Claude CLI binary:

```typescript
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const OAUTH_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers";
```

Julian is a custom web application at `julian.exe.xyz` — not Claude Code, not Claude.ai. The tokens obtained are consumer plan tokens (line 182 writes `subscriptionType: "max"`, `rateLimitTier: "default_claude_max_20x"`). These are then used to power a Claude subprocess exposed to web users via HTTP/SSE.

**Policy**: "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service... is not permitted."

### Finding 2: Third-Party Application Offers Claude.ai Login

**Severity**: High — likely non-compliant
**Location**: `chat.jsx` SetupScreen component

The SetupScreen presents an "Sign in with Anthropic" tab directing users to `claude.ai/oauth/authorize`. This is a third-party web application offering Claude.ai login.

**Policy**: "Anthropic does not permit third-party developers to offer Claude.ai login."

**Note**: `docs/architecture.md:203` acknowledges this path has been "broken since Jan 2026" because "Anthropic blocks third-party OAuth apps" — suggesting Anthropic has already taken enforcement action against this pattern.

### Finding 3: Routing Requests Through Consumer Plan Credentials

**Severity**: High — likely non-compliant
**Location**: `server/server.ts:191-219`, `server/server.ts:375-515`

The server loads consumer OAuth credentials from `~/.claude/.credentials.json`, `~/.sculptor/credentials.json`, or `claude-auth.env` — all consumer-tier credential sources — and passes them to a spawned `claude` CLI subprocess exposed to web users.

**Policy**: "Anthropic does not permit third-party developers to... route requests through Free, Pro, or Max plan credentials on behalf of their users."

### Finding 4: Legacy Setup Token Path Also Uses Consumer Credentials

**Severity**: Medium — likely non-compliant
**Location**: `server/server.ts:663-686`

The fallback `/api/setup` endpoint accepts `sk-ant-oat` tokens from `claude setup-token`. These are consumer OAuth-derived credentials being used in a third-party web application.

### Finding 5: Token Refresh Impersonates Claude Code

**Severity**: Medium — non-compliant (compounds Finding 1)
**Location**: `server/server.ts:119-171`

The server proactively refreshes consumer OAuth tokens using Claude CLI's Client ID and scopes, impersonating Claude Code's identity to Anthropic's token endpoint. Refreshed tokens rotate and persist to `~/.claude/.credentials.json`.

---

## What Is NOT a Violation

- **Clerk authentication** — standard JWT auth gate, unrelated to Anthropic API. Fully compliant.
- **Spawning `claude` CLI as a subprocess** — using Claude Code itself is permitted. The issue is the credential source and web wrapping.
- **Fireproof database sync** — uses Clerk auth, not Anthropic credentials. No issue.
- **JulianScreen WebSocket** — pixel display, no Anthropic credential involvement.

---

## Recommended Remediation

### 1. Remove the OAuth PKCE flow

Delete from `server/server.ts`:
- OAuth constants (lines 24-29)
- PKCE helpers and state management (lines 31-56)
- `/api/oauth/start` endpoint
- `/api/oauth/exchange` endpoint
- `refreshTokenIfNeeded()` function (lines 119-171)
- `writeCredentials()` function (lines 173-187)

### 2. Remove "Sign in with Anthropic" UI

Delete the OAuth tab from the SetupScreen component in `chat.jsx`.

### 3. Use API key authentication

- Obtain an `ANTHROPIC_API_KEY` from [Claude Console](https://console.anthropic.com/).
- Set it as an environment variable in `/opt/julian/.env`.
- The Claude CLI natively supports `ANTHROPIC_API_KEY` — no code changes needed for the subprocess spawn.

### 4. Remove consumer credential management

Delete from `server/server.ts`:
- `loadClaudeCredentials()` (lines 60-73)
- `loadSculptorCredentials()` (lines 75-88)
- `loadAuthEnv()` consumer credential paths (lines 191-219)
- `/api/setup` endpoint for `sk-ant-oat` tokens (lines 663-686)

### 5. Simplify the setup flow

Replace the browser-based credential setup with server-side configuration:
- `ANTHROPIC_API_KEY` in `.env` alongside `VITE_CLERK_PUBLISHABLE_KEY`
- `needsSetup()` checks for `ANTHROPIC_API_KEY` in env instead of credential files
- No user-facing credential input needed

### 6. Update architecture documentation

Update `docs/architecture.md` to reflect the new API key auth model and remove references to OAuth PKCE, setup tokens, and consumer credential management.

---

## Summary

Julian's authentication architecture was built around consumer OAuth tokens — the same credentials used by Claude Code and Claude.ai. Anthropic's current terms explicitly prohibit using these tokens in third-party products or services, and prohibit offering Claude.ai login from third-party applications. The remediation path is straightforward: switch to API key authentication via Claude Console, which is the supported path for developers building products on Claude.
