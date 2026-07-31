import { describe, expect, test } from 'bun:test';
import { bearerToken, subprocessEnv } from '../../server/lib';

describe('subprocessEnv', () => {
  test('injects the session token and keeps the existing spawn flags', () => {
    const env = subprocessEnv({ PATH: '/bin', BROKER_URL: 'https://broker.example' }, { CLAUDE_CODE_OAUTH_TOKEN: 't' }, 'oidc-token-xyz');
    expect(env.JULIAN_OIDC_TOKEN).toBe('oidc-token-xyz');
    expect(env.BROKER_URL).toBe('https://broker.example'); // rides through from base
    expect(env.PATH).toBe('/bin');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('t');
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(env.CLAUDECODE).toBe('');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('');
  });
  test('empty token → no JULIAN_OIDC_TOKEN key at all (no stale empty var)', () => {
    const env = subprocessEnv({}, {}, '');
    expect('JULIAN_OIDC_TOKEN' in env).toBe(false);
  });
  test('empty token drops a JULIAN_OIDC_TOKEN inherited from the base env', () => {
    // The server's own env must never hand a previous door's token to a new
    // subprocess: no token captured means no token passed, full stop.
    const env = subprocessEnv({ JULIAN_OIDC_TOKEN: 'someone-elses-token' }, {}, '');
    expect('JULIAN_OIDC_TOKEN' in env).toBe(false);
  });
  test('the captured token wins over one inherited from the base env', () => {
    const env = subprocessEnv({ JULIAN_OIDC_TOKEN: 'stale' }, {}, 'fresh');
    expect(env.JULIAN_OIDC_TOKEN).toBe('fresh');
  });
  test('authEnv overrides base, and the spawn flags override both', () => {
    const env = subprocessEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: 'base', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' },
      { CLAUDE_CODE_OAUTH_TOKEN: 'auth' },
      '',
    );
    expect(env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'auth',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDECODE: '',
      CLAUDE_CODE_ENTRYPOINT: '',
    });
  });
  test('does not mutate the base or authEnv objects it was given', () => {
    const base = { JULIAN_OIDC_TOKEN: 'stale', PATH: '/bin' };
    const authEnv = { CLAUDE_CODE_OAUTH_TOKEN: 't' };
    subprocessEnv(base, authEnv, 'fresh');
    expect(base).toEqual({ JULIAN_OIDC_TOKEN: 'stale', PATH: '/bin' });
    expect(authEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
  });
});

describe('bearerToken', () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  test('reads the raw bearer from Authorization', () => {
    expect(bearerToken(headers({ Authorization: 'Bearer oidc-token-xyz' }))).toBe('oidc-token-xyz');
  });
  test('falls back to X-Authorization (the exe.dev edge proxy strips Authorization)', () => {
    expect(bearerToken(headers({ 'X-Authorization': 'Bearer proxied-token' }))).toBe('proxied-token');
  });
  test('prefers Authorization when both are present', () => {
    expect(bearerToken(headers({ Authorization: 'Bearer direct', 'X-Authorization': 'Bearer proxied' }))).toBe('direct');
  });
  test('returns empty string when there is no bearer header', () => {
    expect(bearerToken(headers({}))).toBe('');
  });
  test('returns empty string for a non-Bearer scheme rather than slicing garbage', () => {
    expect(bearerToken(headers({ Authorization: 'Basic dXNlcjpwYXNz' }))).toBe('');
  });
});
