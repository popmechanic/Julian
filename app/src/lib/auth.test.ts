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
