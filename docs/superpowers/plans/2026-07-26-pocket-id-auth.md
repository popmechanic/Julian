# Pocket ID Auth Swap Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Clerk with a dedicated self-hosted Pocket ID OIDC issuer (`https://soul.exe.xyz`) across the app, the Bun server, and the sync Worker, preserving default-deny auth end to end.

**Architecture:** The app swaps `@clerk/clerk-js` for `oidc-client-ts` behind an unchanged `getToken()` surface (auth code + PKCE, full-page redirect, refresh-token renewal). Both verifiers keep their jose shape and just change key sourcing: the Bun server derives JWKS from OIDC discovery, the sync Worker renames its env contract from `CLERK_*` to `OIDC_*` with the inline-JWKS test seam intact. Nothing persists user IDs, so there is no data migration.

**Tech Stack:** oidc-client-ts (app), jose (server + worker, already present), Pocket ID (Docker, deployed manually), vitest + bun:test.

**Acceptance:** suite — committed per-package suites are the verification; the live passkey sign-in is a manual runbook task because it requires Marcus's passkey and the deployed issuer.

## Global Constraints

- Branch: all work lands on `ultra/integration-20260726-012506`; never merge to main; the sync Worker is NOT deployed in this effort (post-merge runbook).
- Auth is default-deny everywhere: no valid token → no socket, no export, no API, no public mode. Never widen an accept path.
- Env var contract (exact names): app build reads `VITE_OIDC_ISSUER` and `VITE_OIDC_CLIENT_ID` from the root `.env` (via existing `envDir: '..'`); Bun server reads `OIDC_ISSUER` (falling back to `VITE_OIDC_ISSUER`), `VITE_OIDC_CLIENT_ID` as expected audience, and `OIDC_JWKS_JSON` as inline-JWKS test seam; sync Worker env is `OIDC_ISSUER`, `OIDC_JWKS_URL`, optional `OIDC_JWKS_JSON` (test seam), optional `OIDC_AUDIENCE`.
- Dev seam preserved: with no issuer configured, the app runs local-only and the server skips verification — exactly the semantics of the current missing-Clerk-key mode.
- `clockTolerance: 60` in every verifier.
- TypeScript strict; Svelte 5 runes.
- When done, `grep -ri clerk app/src server sync/src sync/wrangler.toml` must return zero hits.
- Do not touch `memory/`, `soul/`, the letter pipeline, or the JulianScreen server.
- Test servers use PORT=8099; port 8000 belongs to the running legacy app. Concurrency note: the root server integration test owns port 18000; no new test may bind it.

---

### Task 1: App auth module (`oidc-client-ts`)

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Create: `app/src/lib/auth.ts`
- Create: `app/src/lib/auth.test.ts`
- Modify: `app/package.json`

**Interfaces:**
- Consumes: nothing from sibling tasks.
- Produces: `authEnabled(): boolean`, `initAuth(): Promise<void>`, `isSignedIn(): boolean`, `getToken(): Promise<string | null>`, `signIn(): Promise<void>`, `signOut(): Promise<void>`. The consumer-swap task imports exactly these. `getToken()` returns `null` when auth is disabled (dev seam) or signed out — same contract as the Clerk module it replaces.

**Parallelization rationale:** contract-first — the auth surface is pinned here so the consumer rewiring, server, and worker tasks can all proceed in parallel; the surface deliberately mirrors the old `clerk.ts` exports, which a good engineer would do anyway to minimize consumer churn.

Notes that bind this task:
- Config is read lazily inside functions (not at module top level) so tests can stub env between imports.
- Redirect URI is `${window.location.origin}/auth/callback`; scope `openid profile`.
- The bearer defaults to the **access token**. Pocket ID access tokens are expected to be issuer-signed JWTs; if the deployed instance turns out to issue opaque access tokens, the manual deploy task flips `TOKEN_KIND` to `'id'` (ID tokens are always signed JWTs). Keep `TOKEN_KIND` as a single exported const so that flip is one line.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/lib/auth.test.ts
import { describe, expect, test, beforeEach, vi } from 'vitest';

const mockUser = {
  access_token: 'AT', id_token: 'IDT', refresh_token: 'RT', expired: false,
};

const um = {
  getUser: vi.fn(async () => mockUser),
  signinRedirect: vi.fn(async () => {}),
  signinRedirectCallback: vi.fn(async () => mockUser),
  signinSilent: vi.fn(async () => mockUser),
  removeUser: vi.fn(async () => {}),
  events: { addUserLoaded: vi.fn(), addUserUnloaded: vi.fn() },
};

vi.mock('oidc-client-ts', () => ({
  UserManager: vi.fn(() => um),
  WebStorageStateStore: vi.fn(),
}));

describe('auth', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    Object.values(um.events).forEach((f) => f.mockClear?.());
    window.history.replaceState({}, '', '/');
  });

  test('dev seam: no issuer → disabled, signed in, null token', async () => {
    const auth = await import('./auth');
    expect(auth.authEnabled()).toBe(false);
    await auth.initAuth();
    expect(auth.isSignedIn()).toBe(true);
    expect(await auth.getToken()).toBeNull();
  });

  test('enabled: loads existing user and returns access token', async () => {
    vi.stubEnv('VITE_OIDC_ISSUER', 'https://soul.exe.xyz');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'julian');
    const auth = await import('./auth');
    expect(auth.authEnabled()).toBe(true);
    await auth.initAuth();
    expect(auth.isSignedIn()).toBe(true);
    expect(await auth.getToken()).toBe('AT');
  });

  test('completes redirect callback when on /auth/callback and cleans URL', async () => {
    vi.stubEnv('VITE_OIDC_ISSUER', 'https://soul.exe.xyz');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'julian');
    window.history.replaceState({}, '', '/auth/callback?code=x&state=y');
    const auth = await import('./auth');
    await auth.initAuth();
    expect(um.signinRedirectCallback).toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
  });

  test('expired user with refresh token → silent renew before returning token', async () => {
    vi.stubEnv('VITE_OIDC_ISSUER', 'https://soul.exe.xyz');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'julian');
    um.getUser.mockResolvedValueOnce({ ...mockUser, expired: true });
    const auth = await import('./auth');
    await auth.initAuth();
    expect(um.signinSilent).toHaveBeenCalled();
    expect(await auth.getToken()).toBe('AT');
  });

  test('signed out (no user) → not signed in, null token, signIn redirects', async () => {
    vi.stubEnv('VITE_OIDC_ISSUER', 'https://soul.exe.xyz');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'julian');
    um.getUser.mockResolvedValueOnce(null as never);
    const auth = await import('./auth');
    await auth.initAuth();
    expect(auth.isSignedIn()).toBe(false);
    expect(await auth.getToken()).toBeNull();
    await auth.signIn();
    expect(um.signinRedirect).toHaveBeenCalled();
  });
});
```

Vitest environment: these tests need a DOM (`window`). The app's vitest config must run this file under jsdom/happy-dom — if the project default is `node`, add `// @vitest-environment jsdom` as the first line of `auth.test.ts` and add `jsdom` to app devDependencies if absent (check `app/vite.config.ts`/`vitest` config first; `fake-indexeddb` tests currently run under the default environment — do not change the global default).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && bun install && bunx vitest run src/lib/auth.test.ts`
Expected: FAIL — `Cannot find module './auth'`.

- [ ] **Step 3: Implement `app/src/lib/auth.ts`**

```typescript
// OIDC auth against the self-hosted Pocket ID issuer (replaces clerk.ts).
// Auth code + PKCE, full-page redirect; refresh handled by oidc-client-ts.
import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';

// Pocket ID access tokens are issuer-signed JWTs. If the deployed instance
// issues opaque access tokens instead, flip to 'id' (ID tokens are always
// signed JWTs carrying iss/sub/aud/exp) — one-line change, decided at deploy.
export const TOKEN_KIND: 'access' | 'id' = 'access';

function config(): { issuer: string; clientId: string } | null {
  const issuer = import.meta.env.VITE_OIDC_ISSUER as string | undefined;
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined;
  return issuer && clientId ? { issuer, clientId } : null;
}

let um: UserManager | null = null;
let user: User | null = null;

export function authEnabled(): boolean {
  return config() !== null;
}

export async function initAuth(): Promise<void> {
  const cfg = config();
  if (!cfg) return; // dev seam: no issuer → local mode; server skips auth too
  um = new UserManager({
    authority: cfg.issuer,
    client_id: cfg.clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    scope: 'openid profile',
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    automaticSilentRenew: false, // renewal is explicit in getToken()
  });
  um.events.addUserLoaded((u: User) => (user = u));
  um.events.addUserUnloaded(() => (user = null));

  if (window.location.pathname === '/auth/callback') {
    try {
      user = await um.signinRedirectCallback();
    } catch {
      user = null; // stale/duplicate callback — land signed out, never crash boot
    }
    window.history.replaceState({}, '', '/');
    return;
  }
  user = await um.getUser();
  if (user?.expired && user.refresh_token) {
    user = await um.signinSilent().catch(() => null);
  }
}

export function isSignedIn(): boolean {
  if (!authEnabled()) return true; // local mode has no lock
  return !!user && !user.expired;
}

export async function getToken(): Promise<string | null> {
  if (!authEnabled() || !um) return null;
  if (user?.expired && user.refresh_token) {
    user = await um.signinSilent().catch(() => null);
  }
  if (!user || user.expired) return null;
  return TOKEN_KIND === 'id' ? (user.id_token ?? null) : user.access_token;
}

export async function signIn(): Promise<void> {
  await um?.signinRedirect();
}

export async function signOut(): Promise<void> {
  await um?.removeUser();
  user = null;
}
```

- [ ] **Step 4: Add the dependency in `app/package.json`**

Add `"oidc-client-ts": "^3.1.0"` to dependencies. Do NOT remove `@clerk/clerk-js` — `clerk.ts` still imports it and `events.ts` still imports `clerk.ts`; the consumer-swap task removes both together. Run `cd app && bun install`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: full suite green (existing tests + 5 new auth tests), 0 check errors — both auth stacks coexist in this task's tree.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/auth.ts app/src/lib/auth.test.ts app/package.json app/bun.lock
git commit -m "Auth: oidc-client-ts module for Pocket ID (PKCE redirect, refresh, dev seam)"
```

---

### Task 2: Rewire app consumers, delete Clerk

**Type:** implementation
**Depends-on:** 1
**Review:** adversarial

**Files:**
- Modify: `app/src/lib/clerk.ts`
- Modify: `app/package.json`
- Modify: `app/src/lib/api.ts:1`
- Modify: `app/src/lib/events.ts:4`
- Modify: `app/src/App.svelte`
- Modify: `app/src/components/SetupScreen.svelte`

**Interfaces:**
- Consumes: `initAuth()`, `isSignedIn()`, `getToken()`, `signIn()`, `authEnabled()` from the auth module task.
- Produces: no new symbols — the app is Clerk-free.

- [ ] **Step 1: Point `api.ts` and `events.ts` at the new module**

In both files change `import { getToken } from './clerk';` to `import { getToken } from './auth';`. Nothing else in either file changes (header shape `Authorization` + `X-Authorization` stays).

- [ ] **Step 2: Rewire `App.svelte`**

Change `import { initClerk, getToken } from './lib/clerk';` to `import { initAuth, getToken } from './lib/auth';` and in the boot effect change `await initClerk();` to `await initAuth();`. The `startSync(getToken)` call and everything else is untouched.

- [ ] **Step 3: Replace SetupScreen's Clerk branch**

In `SetupScreen.svelte`:
- Imports: `import { fetchHealth } from '../lib/api';` stays; replace the clerk import line with `import { isSignedIn, signIn, authEnabled, getToken } from '../lib/auth';`.
- State: replace `let signedIn = $state(isSignedIn());` initialization semantics — after the redirect flow, sign-in state is settled before mount (initAuth ran in App's boot effect), so: `const signedIn = isSignedIn();` (no listener effect needed).
- Delete the two Clerk `$effect`s (the `addListener` subscription and the `mountSignIn` mount) and the `clerkMount` state.
- Advance condition becomes: `$effect(() => { if (!checking && !needsSetup && signedIn) onReady(); });`
- Template: the signed-out branch becomes a sign-in panel that sends the user to Pocket ID (styling follows whatever the current SetupScreen shell uses — if the design-system restyle has landed, reuse its `.panel`/`.primary` classes; if not, plain equivalents):

```svelte
{:else if !signedIn && authEnabled()}
  <div class="setup">
    <div class="head">
      <h1>SIGN IN</h1>
      <p>JULIAN'S HOUSE HAS A LOCK — YOUR PASSKEY IS THE KEY</p>
    </div>
    <div class="panel">
      <button class="primary" onclick={signIn}>SIGN IN WITH PASSKEY</button>
    </div>
  </div>
```

- `authHeaders()` keeps calling `getToken()` — import already swapped.

- [ ] **Step 4: Delete `app/src/lib/clerk.ts` and drop the dependency**

```bash
git rm app/src/lib/clerk.ts
```

Remove the `"@clerk/clerk-js": "^5.0.0"` line from `app/package.json` dependencies, then `cd app && bun install`.

- [ ] **Step 5: Verify**

Run: `cd app && bun install && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json && grep -ri clerk src/ ; echo "grep exit $? (want 1 = no matches)"`
Expected: all tests pass, 0 check errors, grep finds nothing in `app/src`.

- [ ] **Step 6: Commit**

```bash
git add -A app/src app/package.json app/bun.lock
git commit -m "App: swap Clerk consumers to OIDC auth module; passkey sign-in screen"
```

---

### Task 3: Bun server verifier re-point

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Create: `server/auth.ts`
- Create: `tests/server/auth.test.ts`
- Modify: `server/server.ts`
- Modify: `tests/server/integration.test.ts`

**Interfaces:**
- Consumes: nothing from sibling tasks (env var names come from Global Constraints).
- Produces: `buildVerifier(cfg: AuthConfig | null): Verifier` where `interface AuthConfig { issuer: string; audience?: string; jwksJson?: string; jwksUrl?: string }` and `interface Verifier { verify(token: string): Promise<boolean> }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/server/auth.test.ts
import { describe, expect, test } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { buildVerifier } from "../../server/auth";

const ISSUER = "https://soul.test";

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  return { privateKey, jwksJson: JSON.stringify({ keys: [jwk] }) };
}

async function sign(privateKey: CryptoKey, opts: { iss?: string; sub?: string | null; aud?: string; expOffset?: number } = {}) {
  let jwt = new SignJWT(opts.sub === null ? {} : { sub: opts.sub ?? "marcus" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expOffset ?? 3600));
  if (opts.aud) jwt = jwt.setAudience(opts.aud);
  return jwt.sign(privateKey);
}

describe("buildVerifier", () => {
  test("null config (no issuer) → verify always true (local dev mode)", async () => {
    expect(await buildVerifier(null).verify("anything")).toBe(true);
  });
  test("valid token → true", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey))).toBe(true);
  });
  test("wrong issuer → false", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey, { iss: "https://evil.test" }))).toBe(false);
  });
  test("expired → false", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey, { expOffset: -7200 }))).toBe(false);
  });
  test("missing sub → false", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson });
    expect(await v.verify(await sign(privateKey, { sub: null }))).toBe(false);
  });
  test("audience enforced when configured", async () => {
    const { privateKey, jwksJson } = await makeKeys();
    const v = buildVerifier({ issuer: ISSUER, jwksJson, audience: "julian" });
    expect(await v.verify(await sign(privateKey, { aud: "julian" }))).toBe(true);
    expect(await v.verify(await sign(privateKey, { aud: "other" }))).toBe(false);
    expect(await v.verify(await sign(privateKey))).toBe(false); // no aud claim at all
  });
  test("garbage token → false", async () => {
    const { jwksJson } = await makeKeys();
    expect(await buildVerifier({ issuer: ISSUER, jwksJson }).verify("not-a-jwt")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server/auth.test.ts`
Expected: FAIL — cannot resolve `../../server/auth`.

- [ ] **Step 3: Create `server/auth.ts`**

```typescript
// OIDC bearer verification for the Bun server. Keys come from the issuer's
// discovery document (jwks_uri), an explicit jwksUrl, or inline JWKS (tests).
import { createRemoteJWKSet, createLocalJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

export interface AuthConfig {
  issuer: string;
  audience?: string;
  jwksJson?: string; // test seam: inline JWKS, no network
  jwksUrl?: string;  // explicit override; else derived from discovery
}

export interface Verifier {
  verify(token: string): Promise<boolean>;
}

export function buildVerifier(cfg: AuthConfig | null): Verifier {
  if (!cfg) {
    // No issuer configured = local dev; the app runs unlocked on this machine.
    return { verify: async () => true };
  }
  let keySet: JWTVerifyGetKey | null = cfg.jwksJson
    ? createLocalJWKSet(JSON.parse(cfg.jwksJson))
    : null;

  async function keys(): Promise<JWTVerifyGetKey> {
    if (keySet) return keySet;
    let url = cfg!.jwksUrl;
    if (!url) {
      const res = await fetch(new URL("/.well-known/openid-configuration", cfg!.issuer));
      if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
      url = ((await res.json()) as { jwks_uri: string }).jwks_uri;
    }
    keySet = createRemoteJWKSet(new URL(url));
    return keySet;
  }

  return {
    async verify(token: string): Promise<boolean> {
      try {
        const { payload } = await jwtVerify(token, await keys(), {
          issuer: cfg.issuer,
          clockTolerance: 60,
          ...(cfg.audience ? { audience: cfg.audience } : {}),
        });
        return typeof payload.sub === "string" && payload.sub.length > 0;
      } catch (err) {
        console.error("[auth] token rejected:", (err as Error).message);
        return false; // fail closed — including discovery/JWKS fetch failures
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/server/auth.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Replace the Clerk block in `server/server.ts`**

Replace lines 191–216 (the `── Clerk JWT verification ──` section: `CLERK_PK`, `CLERK_FRONTEND_API`, `JWKS`, and `verifyClerkToken`) with:

```typescript
// ── OIDC bearer verification (Pocket ID) ───────────────────────────────────
import { buildVerifier } from "./auth";

const OIDC_ISSUER = process.env.OIDC_ISSUER || process.env.VITE_OIDC_ISSUER || "";
const verifier = buildVerifier(
  OIDC_ISSUER
    ? {
        issuer: OIDC_ISSUER,
        audience: process.env.VITE_OIDC_CLIENT_ID || undefined,
        jwksJson: process.env.OIDC_JWKS_JSON || undefined,
      }
    : null,
);

async function verifyToken(req: Request): Promise<boolean> {
  // Check Authorization header, fall back to X-Authorization (exe.dev edge proxy strips Authorization)
  const auth = req.headers.get("Authorization") || req.headers.get("X-Authorization");
  if (!OIDC_ISSUER) return true; // no issuer configured = skip auth (local dev)
  if (!auth?.startsWith("Bearer ")) {
    console.warn("[auth] No Authorization header in request");
    return false;
  }
  return verifier.verify(auth.slice(7));
}
```

Then rename every call site: `grep -n "verifyClerkToken" server/server.ts` (14 call sites) and replace each `verifyClerkToken(` with `verifyToken(`. Also remove the now-unused `createRemoteJWKSet, jwtVerify` names from server.ts's own jose import if nothing else in the file uses them (check with grep before deleting the import).

Move the `import { buildVerifier } from "./auth";` line up to the file's import block (imports live at the top; the snippet above shows it inline only for locality).

- [ ] **Step 6: Update the integration test's auth bypass**

In `tests/server/integration.test.ts`, the spawn env currently blanks the Clerk key to bypass auth (comment near the top: `Set VITE_CLERK_PUBLISHABLE_KEY to empty`). Replace that env override with the OIDC equivalents so the spawned server runs in no-issuer mode:

```typescript
      OIDC_ISSUER: "",
      VITE_OIDC_ISSUER: "",
```

and update the comment to say OIDC. Remove the `VITE_CLERK_PUBLISHABLE_KEY` override line.

- [ ] **Step 7: Full server suite**

Run: `bun test tests/`
Expected: all pass, including the existing integration + lib tests on port 18000.

- [ ] **Step 8: Commit**

```bash
git add server/auth.ts server/server.ts tests/server/auth.test.ts tests/server/integration.test.ts
git commit -m "Server: verify OIDC bearers via discovery JWKS, replace Clerk block"
```

---

### Task 4: Sync Worker env contract rename + audience check

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `sync/src/auth.ts`
- Modify: `sync/src/index.ts`
- Modify: `sync/wrangler.toml`
- Modify: `sync/test/auth.test.ts`
- Modify: `sync/test/export.test.ts`

**Interfaces:**
- Consumes: nothing from sibling tasks (env names from Global Constraints).
- Produces: `verifyWithKeySet(token: string, keySet: JWTVerifyGetKey, issuer: string, audience?: string): Promise<{ sub: string } | null>`; `interface Env { JULIAN_SYNC: DurableObjectNamespace; OIDC_ISSUER: string; OIDC_JWKS_URL: string; OIDC_JWKS_JSON?: string; OIDC_AUDIENCE?: string }`; `keySetFor(env: Env)` unchanged in behavior.

- [ ] **Step 1: Extend the tests first**

In `sync/test/auth.test.ts`: keep the four existing tests (update nothing in them — `verifyWithKeySet`'s existing 3-arg calls stay valid because `audience` is optional). Change the `ISSUER` constant value to `'https://soul.test'` (cosmetic honesty). Extend the `sign` helper to accept `aud`:

```typescript
async function sign(privateKey: CryptoKey, opts: { iss?: string; expOffset?: number; aud?: string } = {}) {
  let jwt = new SignJWT({ sub: 'user_marcus' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expOffset ?? 3600));
  if (opts.aud) jwt = jwt.setAudience(opts.aud);
  return jwt.sign(privateKey);
}
```

Add three tests:

```typescript
  test('audience enforced when provided: match → sub', async () => {
    const { privateKey, keySet } = await makeKeys();
    expect(await verifyWithKeySet(await sign(privateKey, { aud: 'julian' }), keySet, ISSUER, 'julian'))
      .toEqual({ sub: 'user_marcus' });
  });
  test('audience mismatch → null', async () => {
    const { privateKey, keySet } = await makeKeys();
    expect(await verifyWithKeySet(await sign(privateKey, { aud: 'other' }), keySet, ISSUER, 'julian')).toBeNull();
  });
  test('audience required but token has none → null', async () => {
    const { privateKey, keySet } = await makeKeys();
    expect(await verifyWithKeySet(await sign(privateKey), keySet, ISSUER, 'julian')).toBeNull();
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd sync && bunx vitest run test/auth.test.ts`
Expected: 3 new tests FAIL (audience param not implemented); 4 old tests PASS.

- [ ] **Step 3: Update `sync/src/auth.ts`**

```typescript
import { jwtVerify, createRemoteJWKSet, createLocalJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export async function verifyWithKeySet(
  token: string, keySet: JWTVerifyGetKey, issuer: string, audience?: string,
): Promise<{ sub: string } | null> {
  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer, clockTolerance: 60, ...(audience ? { audience } : {}),
    });
    return typeof payload.sub === 'string' && payload.sub ? { sub: payload.sub } : null;
  } catch {
    return null;
  }
}

export interface Env {
  JULIAN_SYNC: DurableObjectNamespace;
  OIDC_ISSUER: string;
  OIDC_JWKS_URL: string;
  OIDC_JWKS_JSON?: string; // test seam: inline JWKS instead of remote fetch
  OIDC_AUDIENCE?: string;  // when set, tokens must carry this aud
}

let remoteKeySet: JWTVerifyGetKey | null = null;
export function keySetFor(env: Env): JWTVerifyGetKey {
  if (env.OIDC_JWKS_JSON) return createLocalJWKSet(JSON.parse(env.OIDC_JWKS_JSON));
  remoteKeySet ??= createRemoteJWKSet(new URL(env.OIDC_JWKS_URL));
  return remoteKeySet;
}
```

- [ ] **Step 4: Update `sync/src/index.ts`**

In the fetch handler, change the comment `// Default-deny: no valid Clerk JWT → nothing. No public mode exists.` to `// Default-deny: no valid OIDC JWT → nothing. No public mode exists.` and the verify call to:

```typescript
    const auth = token ? await verifyWithKeySet(token, keySetFor(env), env.OIDC_ISSUER, env.OIDC_AUDIENCE) : null;
```

- [ ] **Step 5: Update `sync/wrangler.toml`**

```toml
[vars]
OIDC_ISSUER = "SET_AT_DEPLOY"     # real value set in the post-merge deploy task
OIDC_JWKS_URL = "SET_AT_DEPLOY"
OIDC_AUDIENCE = "SET_AT_DEPLOY"   # the Pocket ID client_id for the Julian app
```

- [ ] **Step 6: Rename env fixture keys in the other sync tests**

`grep -n "CLERK" sync/test/export.test.ts sync/test/routing.test.ts` — in each env fixture object replace `CLERK_ISSUER` → `OIDC_ISSUER`, `CLERK_JWKS_URL` → `OIDC_JWKS_URL`, `CLERK_JWKS_JSON` → `OIDC_JWKS_JSON`. No other edits.

- [ ] **Step 7: Full sync suite + Clerk sweep**

Run: `cd sync && bun install && bunx vitest run && grep -rn CLERK src/ test/ wrangler.toml; echo "grep exit $? (want 1)"`
Expected: 15 tests pass (12 existing + 3 new); grep finds nothing.

- [ ] **Step 8: Commit**

```bash
git add sync/src/auth.ts sync/src/index.ts sync/wrangler.toml sync/test
git commit -m "Sync worker: CLERK_* → OIDC_* env contract, optional audience check"
```

---

### Task 5: Full verification gate

**Type:** gate
**Depends-on:** 1, 2, 3, 4

**Files:** none.

- [ ] **Step 1:** `cd app && bun install && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json` → green, 0 errors.
- [ ] **Step 2:** `cd sync && bunx vitest run` → 15 pass. `cd shared && bunx vitest run` → 5 pass. `cd scripts && bunx vitest run` → 2 pass.
- [ ] **Step 3:** `bun test tests/` → server suites green (auth + lib + integration on port 18000).
- [ ] **Step 4:** `grep -ri clerk app/src server sync/src sync/wrangler.toml` → zero hits; `grep -rn "VITE_CLERK" . --include="*.ts" --include="*.toml" --include="*.json" | grep -v node_modules | grep -v docs/` → zero hits.
- [ ] **Step 5:** `cd app && bunx vite build` → succeeds.

---

### Task 6: Deploy Pocket ID at soul.exe.xyz and register the Julian client

**Type:** manual
**Depends-on:** none

**Files:** none (VM-side only; root `.env` gains values, never committed).

With Marcus (his passkey is required):

- [ ] **Step 1:** Confirm the `soul` VM name is available on exe.dev; provision it (see the `using-exe-dev` skill / `julian:deploy` for VM conventions).
- [ ] **Step 2:** Run Pocket ID via Docker on the VM: image `ghcr.io/pocket-id/pocket-id`, SQLite at a persisted volume path, env `APP_URL=https://soul.exe.xyz`, `ENCRYPTION_KEY=$(openssl rand -base64 32)` (stored only in the VM's env file), `TRUST_PROXY=true` for the exe.dev reverse proxy, port 1411 behind the proxy.
- [ ] **Step 3:** Marcus opens `https://soul.exe.xyz`, creates the admin account, registers his passkey.
- [ ] **Step 4:** In the admin UI, create OIDC client **Julian**: public client (PKCE enforced, no secret); callback URLs `http://localhost:8000/auth/callback`, `http://localhost:8099/auth/callback`, `http://localhost:5173/auth/callback`, `https://julian.exe.xyz/auth/callback`. Record the `client_id`.
- [ ] **Step 5:** Sanity from the Mac: `curl -s https://soul.exe.xyz/.well-known/openid-configuration | jq .issuer,.jwks_uri,.authorization_endpoint` — all present; `curl -s <jwks_uri> | jq '.keys | length'` ≥ 1.
- [ ] **Step 6:** Token kind check: complete one sign-in (via the app or Pocket ID's own tools), capture the access token, and check whether it is a three-segment JWS whose `iss` matches. If it is not a verifiable JWT, flip `TOKEN_KIND` in the app auth module to `'id'` and commit that one-line change.
- [ ] **Step 7:** Add to root `.env`: `VITE_OIDC_ISSUER=https://soul.exe.xyz` and `VITE_OIDC_CLIENT_ID=<recorded id>`; delete the `VITE_CLERK_PUBLISHABLE_KEY` line. Restart the port-8099 test server.

---

### Task 7: Live smoke — passkey sign-in end to end

**Type:** manual
**Depends-on:** 5, 6

**Files:** none.

- [ ] **Step 1:** `cd app && bunx vite build`, then `PORT=8099 bun run server/server.ts`.
- [ ] **Step 2:** In Chrome at `http://localhost:8099`: SIGN IN WITH PASSKEY → Pocket ID prompt → passkey → redirected back signed in; chat round-trip works; JulianScreen embed live.
- [ ] **Step 3:** Default-deny spot checks: `curl -s -o /dev/null -w "%{http_code}" -X POST localhost:8099/api/send -H 'Content-Type: application/json' -d '{"message":"hi"}'` → `401` (no token); same with a garbage Bearer → `401`.
- [ ] **Step 4:** Refresh behavior: leave the tab past the access-token lifetime, send a message — request succeeds after silent renewal (watch the network panel for the token refresh).
