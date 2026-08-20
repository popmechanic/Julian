// @vitest-environment jsdom
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
  events: { addUserLoaded: vi.fn(), addUserUnloaded: vi.fn(), addSilentRenewError: vi.fn() },
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
    // The repo-root .env (envDir: '..') carries real issuer values on a
    // configured machine; stub them empty so the dev seam is testable anywhere.
    vi.stubEnv('VITE_OIDC_ISSUER', '');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', '');
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

  test('requests offline_access and lets oidc-client-ts renew in the background (#5)', async () => {
    vi.stubEnv('VITE_OIDC_ISSUER', 'https://soul.exe.xyz');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'julian');
    // Import the mocked module inside the test: beforeEach resets the registry,
    // so the constructor spy is fresh and shares a registry with ./auth.
    const { UserManager } = await import('oidc-client-ts');
    const auth = await import('./auth');
    await auth.initAuth();
    const cfg = vi.mocked(UserManager).mock.calls[0][0];
    // No refresh token without offline_access — signinSilent would have nothing
    // to spend, and every session would die at the access token's expiry.
    expect(cfg.scope).toBe('openid profile offline_access');
    expect(cfg.automaticSilentRenew).toBe(true);
  });

  test('background renewal failures are reported, not swallowed (#5)', async () => {
    vi.stubEnv('VITE_OIDC_ISSUER', 'https://soul.exe.xyz');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'julian');
    const auth = await import('./auth');
    await auth.initAuth();
    // automaticSilentRenew fails silently by default — with no
    // silent_redirect_uri configured it can fail on every cycle and the only
    // symptom is a session that quietly expires. Say so on the console.
    expect(um.events.addSilentRenewError).toHaveBeenCalled();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const listener = um.events.addSilentRenewError.mock.calls[0][0] as (e: Error) => void;
      listener(new Error('renew failed'));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
