# Pocket ID Auth — Replace Clerk with Self-Hosted OIDC

**Date:** 2026-07-26
**Branch:** `ultra/integration-20260726-012506` (no merge to main; no deploy of the app)
**Approved intent (Marcus):** drop Clerk; run a dedicated Pocket ID instance at
**`soul.exe.xyz`** as Julian's identity provider. Browser flow: authorization
code + PKCE, full-page redirect. Auth remains **default-deny**: no valid token →
no socket, no export, no public mode.

Pocket ID facts (verified against docs/DeepWiki 2026-07-26): OIDC-certified
provider, passkey-only sign-in, PKCE enforced for public clients, refresh-token
rotation (30-day), clients registered via admin UI, standard discovery +
JWKS endpoints, Docker/SQLite deployment, `APP_URL`/`ENCRYPTION_KEY`/
`TRUST_PROXY` env config.

## Current state (what gets replaced)

All three verifiers accept a Bearer JWT and check only signature/issuer/`sub`;
no Clerk user IDs are persisted anywhere → **no data migration**.

| Touchpoint | Today | After |
|---|---|---|
| `app/src/lib/clerk.ts` | `@clerk/clerk-js`, mounted sign-in, `getToken()` | `app/src/lib/auth.ts`, `oidc-client-ts`, redirect flow, same surface |
| `server/server.ts` | JWKS URL decoded from `VITE_CLERK_PUBLISHABLE_KEY` | JWKS from `OIDC_ISSUER` discovery (`<issuer>/.well-known/openid-configuration` → `jwks_uri`) |
| `sync/src/auth.ts` | `CLERK_ISSUER` / `CLERK_JWKS_URL` / `CLERK_JWKS_JSON` seam | `OIDC_ISSUER` / `OIDC_JWKS_URL` / `OIDC_JWKS_JSON` — same `verifyWithKeySet`/`keySetFor` shape |

## Phase A — Deploy the issuer (interactive, with Marcus)

1. Provision exe.dev VM named `soul` → `https://soul.exe.xyz`. (Confirm name
   availability first; passkeys bind to this origin permanently.)
2. Run Pocket ID via Docker: SQLite at a persisted path, `APP_URL=https://soul.exe.xyz`,
   `ENCRYPTION_KEY` from `openssl rand -base64 32` (stored in the VM env, never
   in the repo), `TRUST_PROXY` set for the exe.dev reverse proxy, MAXMIND unset.
3. Marcus creates the admin account and registers his passkey. (His account is
   the only user; more can be added later — default-deny stays "valid token
   from this issuer".)
4. Register OIDC client **Julian**: public client (PKCE, no secret), callback
   URLs: `http://localhost:8000/*`, `http://localhost:8099/*` (dev; requires
   `ALLOW_INSECURE_CALLBACK_URLS=true`, the default) and the production origin
   (currently `https://julian.exe.xyz/*`) — exact callback path is
   `/auth/callback` (see Phase B). Record `client_id`.
5. Sanity checks from this Mac: discovery document resolves; `jwks_uri` serves
   keys; decide the **bearer token question** — inspect whether Pocket ID
   access tokens are signed JWTs. If yes, the app sends the access token; if
   they are opaque, the app sends the **ID token** (signed JWT with
   `iss`/`sub`/`aud`/`exp`). All downstream design works either way; the choice
   is recorded in `.env.example` comments and the implementation plan.

Backups/ops note: the VM holds only auth state (SQLite + encryption key), no
Julian memory. Losing it means re-deploying and re-registering a passkey —
annoying, not catastrophic. Snapshot per exe.dev norms.

## Phase B — Client swap (app)

- Remove `@clerk/clerk-js`; add `oidc-client-ts` (mature SPA OIDC library:
  redirect flow, storage, automatic renewal against rotating refresh tokens).
- New `app/src/lib/auth.ts` replacing `clerk.ts` with the same surface so
  consumers stay put:
  - `initAuth(): Promise<void>` — construct `UserManager` (authority =
    `VITE_OIDC_ISSUER`, client_id = `VITE_OIDC_CLIENT_ID`, redirect_uri =
    `<origin>/auth/callback`, scope `openid profile`, `userStore` =
    localStorage-backed so reload keeps sessions); on boot, if the URL is the
    callback, complete `signinRedirectCallback()` and clean the URL.
  - `isSignedIn(): boolean`, `getToken(): Promise<string | null>` (returns the
    chosen bearer; `oidc-client-ts` transparently refreshes near expiry),
    `signIn(): Promise<void>` (`signinRedirect()`), `signOut()` (local removal;
    no end-session round-trip needed for v1).
  - **Dev seam preserved:** `VITE_OIDC_ISSUER` unset → `initAuth` no-ops,
    `isSignedIn` true, `getToken` null — exactly the current no-Clerk-key
    local mode, and the server side skips verification in the same mode.
- `SetupScreen`: mounted Clerk widget → a SIGN IN button (styled per the design
  system port) → full redirect to Pocket ID (passkey prompt) → back to
  `/auth/callback`. Signed-out API failures (401) route back to this screen.
- Consumers `api.ts`, `events.ts`, `store.ts` (sync socket): import path
  changes from `./clerk` to `./auth` only; `getToken()` contract unchanged.
- The Bun server must serve the SPA for `/auth/callback` (any non-API path
  falls through to `index.html`) so the redirect lands in the app.
- Env: root `.env` gains `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`; the app
  build reads them via existing `envDir: '..'`. `VITE_CLERK_PUBLISHABLE_KEY`
  is deleted everywhere.

## Phase C — Re-point the verifiers

- **Bun server** (`server/server.ts`): replace the publishable-key decoding
  with `OIDC_ISSUER` (falls back to `VITE_OIDC_ISSUER` from the same `.env`).
  At startup, fetch the discovery document once, build
  `createRemoteJWKSet(jwks_uri)`; `verifyClerkToken` → `verifyToken`, checks
  `iss` = issuer, `exp` (jose default), non-empty `sub`, and `aud` includes
  our `client_id` when the claim is present. No issuer configured → verification
  skipped (existing local-dev mode, unchanged semantics).
- **Sync Worker** (`sync/src/auth.ts`, `wrangler.toml`): env renames
  `CLERK_ISSUER→OIDC_ISSUER`, `CLERK_JWKS_URL→OIDC_JWKS_URL`,
  `CLERK_JWKS_JSON→OIDC_JWKS_JSON` (inline-JWKS test seam carries over
  verbatim); add optional `OIDC_AUDIENCE` checked when set. `keySetFor` logic
  unchanged. Worker is **not deployed** in this session (post-merge runbook
  step); config lands ready.
- Default-deny audit: every `verifyClerkToken` call site (14 in server.ts),
  the events SSE endpoint, export endpoints, and the sync socket upgrade keep
  their reject-on-invalid behavior. Grep for `clerk`/`CLERK` must return zero
  hits in app/, server/, sync/ when done (docs and this spec excepted).

## Error handling

- Refresh failure / revoked session → `oidc-client-ts` fires user-unloaded →
  app state flips to signed-out → SetupScreen. In-flight requests get 401s,
  which already surface as connection errors rather than crashes.
- Issuer unreachable at server startup → log loudly and refuse authed routes
  (fail closed), retry discovery fetch lazily on next request.
- Clock skew: keep `clockTolerance: 60` in all verifiers.

## Testing

Test-first, per-package (`bun install && bunx vitest run`):

- **sync:** existing 12 tests pass with renamed env vars; add one test for the
  `OIDC_AUDIENCE` check (accept matching, reject mismatched) using the inline
  JWKS seam.
- **server:** verification unit tests via the same inline-JWKS pattern
  (valid token passes; bad issuer/expired/no-sub/wrong-aud rejected; no-issuer
  mode skips). Discovery fetch mocked.
- **app:** `auth.ts` tests mocking `oidc-client-ts` (callback detection, token
  passthrough, dev-seam no-op); svelte-check 0 errors; existing 16 tests green.
- **Live (with Marcus, after Phase A):** browser sign-in at `soul.exe.xyz`
  passkey → chat works on PORT=8099; sockets/export rejected without token.

## Rollback

Single-branch revert: Clerk code and env names live in git history; Pocket ID
VM can be paused without touching the app (the app fails closed). No stored
data references either provider's user IDs.

## Out of scope

Deploying the sync Worker (post-merge runbook); multi-user/public mode;
sign-out federation (end_session); migrating any historical data; the five
dream-0006 entry constraints are untouched (no store or ledger changes).
