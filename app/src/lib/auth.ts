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
  // Block bodies, not concise ones: these callbacks are typed to return
  // `void | Promise<void>`, so an assignment expression body would not typecheck.
  um.events.addUserLoaded((u: User) => {
    user = u;
  });
  um.events.addUserUnloaded(() => {
    user = null;
  });

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
