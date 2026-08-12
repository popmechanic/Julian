// The authorization-code face: /register, /authorize, and the
// grant_type=authorization_code branch of /token, plus OAuth discovery.
//
// Same seam approve.test.ts uses: wrangler [vars] do not propagate through
// `SELF`, so every path is proven by calling `handleAuthcode(req, env, gov,
// registrar)` directly with a hand-built env and scripted GOVERNOR/REGISTRAR
// stubs. The GOVERNOR stub models the DO's server-side scope gate faithfully —
// a scope outside AUTHCODE_SCOPES returns { status: 'invalid' } — so the
// "never full-house" guarantee is exercised, not assumed away.
import { describe, expect, test } from 'vitest';
import { handleAuthcode, oauthDiscovery, PENDING_COOKIE } from '../src/as/authcode';
import type { Env } from '../src/env';
import type { GovernorDO, MintResult } from '../src/governor';
import type { RegistrarDO } from '../src/registrar';

const BASE = 'https://gate.test';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

type RegisterMeta = {
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  client_name?: string;
};
type RegisterResult = { client_id: string } | { error: string };
type PendingArgs = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  state: string;
  ttlSeconds: number;
};
type PendingResult = { pendingId: string } | { error: string };
type RedeemArgs = { code: string; client_id: string; redirect_uri: string; code_verifier: string };
type RedeemResult = { elected_scope: string; door_name: string } | { error: string };

interface RegistrarScript {
  register?: RegisterResult;
  pending?: PendingResult;
  redeem?: RedeemResult;
  down?: boolean;
}
interface GovernorScript {
  down?: boolean;
}
interface Calls {
  register: RegisterMeta[];
  createPending: PendingArgs[];
  redeem: RedeemArgs[];
  mint: Array<[string, string, string, string]>;
}

/** A GOVERNOR stub that enforces the real server-side scope gate. */
function govStub(script: GovernorScript, calls: Calls): DurableObjectStub<GovernorDO> {
  const AUTHCODE_SCOPES = ['reading-room', 'stream-read'];
  return {
    async mintAuthcodeLease(
      doorName: string, scope: string, principal: string, claims: string,
    ): Promise<MintResult> {
      calls.mint.push([doorName, scope, principal, claims]);
      if (script.down) throw new Error('governor down');
      if (!AUTHCODE_SCOPES.includes(scope)) return { status: 'invalid' };
      return {
        status: 'ok', accessToken: 'jla_access', refreshToken: 'jlr_refresh',
        expiresIn: 900, scope,
      };
    },
  } as unknown as DurableObjectStub<GovernorDO>;
}

function registrarStub(script: RegistrarScript, calls: Calls): DurableObjectStub<RegistrarDO> {
  return {
    async registerClient(meta: RegisterMeta): Promise<RegisterResult> {
      calls.register.push(meta);
      if (script.down) throw new Error('registrar down');
      if (script.register) return script.register;
      if (meta.token_endpoint_auth_method !== 'none') {
        return { error: 'invalid_client_metadata: only public clients' };
      }
      return { client_id: 'client-abc' };
    },
    async createPending(p: PendingArgs): Promise<PendingResult> {
      calls.createPending.push(p);
      if (script.down) throw new Error('registrar down');
      return script.pending ?? { pendingId: 'pending-xyz' };
    },
    async redeem(p: RedeemArgs): Promise<RedeemResult> {
      calls.redeem.push(p);
      if (script.down) throw new Error('registrar down');
      return script.redeem ?? { elected_scope: 'reading-room', door_name: 'visit:claude.ai' };
    },
  } as unknown as DurableObjectStub<RegistrarDO>;
}

function gateEnv(overrides: Partial<Env> = {}): Env {
  return {
    PUBLIC_URL: BASE,
    MCP_RESOURCE_URL: RESOURCE,
    ...overrides,
  } as unknown as Env;
}

function harness(reg: RegistrarScript = {}, gov: GovernorScript = {}) {
  const calls: Calls = { register: [], createPending: [], redeem: [], mint: [] };
  return {
    calls,
    env: gateEnv(),
    gov: govStub(gov, calls),
    registrar: registrarStub(reg, calls),
  };
}

function setCookieNames(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const all = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? (res.headers.get('Set-Cookie') ? [res.headers.get('Set-Cookie') as string] : []);
  for (const raw of all) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function authorizeUrl(params: Record<string, string>): string {
  const u = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

const HAPPY_AUTHORIZE = {
  response_type: 'code',
  client_id: 'client-abc',
  redirect_uri: REDIRECT,
  code_challenge: 'a-challenge',
  code_challenge_method: 'S256',
  resource: RESOURCE,
  state: 'cli-state-42',
};

function tokenReq(body: Record<string, string>): Request {
  return new Request(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

describe('handleAuthcode /register', () => {
  test('registers a public client and echoes redirect_uris', async () => {
    const h = harness();
    const req = new Request(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.client_id).toBe('client-abc');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.redirect_uris).toEqual([REDIRECT]);
  });

  test('rejects a confidential client with 400', async () => {
    const h = harness();
    const req = new Request(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' }),
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect('error' in body).toBe(true);
    expect(h.calls.createPending).toEqual([]);
  });

  test('a malformed JSON body is a 400, not a crash', async () => {
    const h = harness();
    const req = new Request(`${BASE}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
  });
});

describe('handleAuthcode /authorize', () => {
  test('a happy authorize stages a pending and sets the gate_pending cookie', async () => {
    const h = harness();
    const req = new Request(authorizeUrl(HAPPY_AUTHORIZE));
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${BASE}/approve`);
    const cookies = setCookieNames(res);
    expect(cookies[PENDING_COOKIE]).toBe('pending-xyz');
    expect(h.calls.createPending).toHaveLength(1);
    expect(h.calls.createPending[0]).toMatchObject({
      client_id: 'client-abc', redirect_uri: REDIRECT,
      code_challenge: 'a-challenge', resource: RESOURCE,
      state: 'cli-state-42',
    });
  });

  test('an authorize without state stages a pending with an empty state', async () => {
    const h = harness();
    const params = { ...HAPPY_AUTHORIZE } as Record<string, string>;
    delete params.state;
    const res = await handleAuthcode(new Request(authorizeUrl(params)), h.env, h.gov, h.registrar);
    expect(res.status).toBe(302);
    expect(h.calls.createPending[0]).toMatchObject({ state: '' });
  });

  test('the pending cookie is Secure, HttpOnly, and SameSite=Lax', async () => {
    const h = harness();
    const res = await handleAuthcode(new Request(authorizeUrl(HAPPY_AUTHORIZE)), h.env, h.gov, h.registrar);
    const all = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? [res.headers.get('Set-Cookie') as string];
    const raw = all.find((c) => c.startsWith(`${PENDING_COOKIE}=`)) ?? '';
    expect(raw).toContain('Secure');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
  });

  test('a plain code_challenge_method is rejected 400 with no redirect and no pending', async () => {
    const h = harness();
    const req = new Request(authorizeUrl({ ...HAPPY_AUTHORIZE, code_challenge_method: 'plain' }));
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBe(null);
    expect(setCookieNames(res)[PENDING_COOKIE]).toBeUndefined();
    expect(h.calls.createPending).toEqual([]);
  });

  test('an absent code_challenge_method is rejected 400', async () => {
    const h = harness();
    const params = { ...HAPPY_AUTHORIZE } as Record<string, string>;
    delete params.code_challenge_method;
    const res = await handleAuthcode(new Request(authorizeUrl(params)), h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    expect(h.calls.createPending).toEqual([]);
  });

  test('a non-code response_type is rejected 400', async () => {
    const h = harness();
    const req = new Request(authorizeUrl({ ...HAPPY_AUTHORIZE, response_type: 'token' }));
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    expect(h.calls.createPending).toEqual([]);
  });

  test('a wrong resource is rejected 400 with no pending', async () => {
    const h = harness();
    const req = new Request(authorizeUrl({ ...HAPPY_AUTHORIZE, resource: 'https://evil.test/mcp' }));
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBe(null);
    expect(h.calls.createPending).toEqual([]);
  });

  test('an absent resource is rejected 400', async () => {
    const h = harness();
    const params = { ...HAPPY_AUTHORIZE } as Record<string, string>;
    delete params.resource;
    const res = await handleAuthcode(new Request(authorizeUrl(params)), h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    expect(h.calls.createPending).toEqual([]);
  });

  test('a createPending error (unknown client / bad redirect) is a 400 page, no redirect', async () => {
    const h = harness({ pending: { error: 'invalid_redirect_uri' } });
    const res = await handleAuthcode(new Request(authorizeUrl(HAPPY_AUTHORIZE)), h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBe(null);
    expect(setCookieNames(res)[PENDING_COOKIE]).toBeUndefined();
  });

  test('an unreachable registrar refuses with 503', async () => {
    const h = harness({ down: true });
    const res = await handleAuthcode(new Request(authorizeUrl(HAPPY_AUTHORIZE)), h.env, h.gov, h.registrar);
    expect(res.status).toBe(503);
  });
});

describe('handleAuthcode /token authorization_code', () => {
  test('a redeemable code yields an access_token with scope reading-room', async () => {
    const h = harness();
    const req = tokenReq({
      grant_type: 'authorization_code', code: 'pending-xyz',
      client_id: 'client-abc', redirect_uri: REDIRECT, code_verifier: 'v'.repeat(64),
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      access_token: 'jla_access', token_type: 'Bearer',
      expires_in: 900, refresh_token: 'jlr_refresh', scope: 'reading-room',
    });
    expect(h.calls.mint).toHaveLength(1);
    expect(h.calls.mint[0][0]).toBe('visit:claude.ai');
    expect(h.calls.mint[0][1]).toBe('reading-room');
    expect(h.calls.mint[0][2]).toBe('julian');
  });

  test('never yields full-house even if a tampered registrar elects it — the DO gate refuses', async () => {
    const h = harness({ redeem: { elected_scope: 'full-house', door_name: 'visit:claude.ai' } });
    const req = tokenReq({
      grant_type: 'authorization_code', code: 'pending-xyz',
      client_id: 'client-abc', redirect_uri: REDIRECT, code_verifier: 'v'.repeat(64),
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
    expect('access_token' in body).toBe(false);
  });

  test('a resource that differs from MCP_RESOURCE_URL is refused and mints nothing', async () => {
    const h = harness();
    const req = tokenReq({
      grant_type: 'authorization_code', code: 'pending-xyz',
      client_id: 'client-abc', redirect_uri: REDIRECT, code_verifier: 'v'.repeat(64),
      resource: 'https://evil.test/mcp',
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_target');
    expect('access_token' in body).toBe(false);
    expect(h.calls.redeem).toEqual([]);
    expect(h.calls.mint).toEqual([]);
  });

  test('a matching resource on /token still succeeds', async () => {
    const h = harness();
    const req = tokenReq({
      grant_type: 'authorization_code', code: 'pending-xyz',
      client_id: 'client-abc', redirect_uri: REDIRECT, code_verifier: 'v'.repeat(64),
      resource: RESOURCE,
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ access_token: 'jla_access', scope: 'reading-room' });
    expect(h.calls.mint).toHaveLength(1);
  });

  test('a redeem failure is invalid_grant', async () => {
    const h = harness({ redeem: { error: 'invalid_grant: pkce' } });
    const req = tokenReq({
      grant_type: 'authorization_code', code: 'pending-xyz',
      client_id: 'client-abc', redirect_uri: REDIRECT, code_verifier: 'wrong',
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
    expect(h.calls.mint).toEqual([]);
  });

  test('a missing code is invalid_request, and never redeems', async () => {
    const h = harness();
    const req = tokenReq({
      grant_type: 'authorization_code',
      client_id: 'client-abc', redirect_uri: REDIRECT, code_verifier: 'v',
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
    expect(h.calls.redeem).toEqual([]);
  });

  test('an unreachable governor refuses with 503 after a good redeem', async () => {
    const h = harness({}, { down: true });
    const req = tokenReq({
      grant_type: 'authorization_code', code: 'pending-xyz',
      client_id: 'client-abc', redirect_uri: REDIRECT, code_verifier: 'v'.repeat(64),
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(503);
  });

  test('an unsupported grant_type on /token is unsupported_grant_type', async () => {
    const h = harness();
    const res = await handleAuthcode(tokenReq({ grant_type: 'password' }), h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('unsupported_grant_type');
  });
});

describe('handleAuthcode routing', () => {
  test('an unknown path is 404', async () => {
    const h = harness();
    const res = await handleAuthcode(new Request(`${BASE}/nope`), h.env, h.gov, h.registrar);
    expect(res.status).toBe(404);
  });
});

describe('oauthDiscovery', () => {
  test('protected-resource metadata advertises reading-room only', async () => {
    const res = oauthDiscovery(gateEnv(), '/.well-known/oauth-protected-resource');
    expect(res).not.toBeNull();
    const body = await (res as Response).json() as Record<string, unknown>;
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([BASE]);
    expect(body.scopes_supported).toEqual(['reading-room']);
  });

  test('the /mcp-suffixed protected-resource variant resolves', async () => {
    const res = oauthDiscovery(gateEnv(), '/.well-known/oauth-protected-resource/mcp');
    expect(res).not.toBeNull();
    const body = await (res as Response).json() as Record<string, unknown>;
    expect(body.resource).toBe(RESOURCE);
  });

  test('AS metadata advertises reading-room, S256, and the three endpoints', async () => {
    const res = oauthDiscovery(gateEnv(), '/.well-known/oauth-authorization-server');
    expect(res).not.toBeNull();
    const body = await (res as Response).json() as Record<string, unknown>;
    expect(body.scopes_supported).toEqual(['reading-room']);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.registration_endpoint).toBe(`${BASE}/register`);
    expect(body.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(body.token_endpoint).toBe(`${BASE}/token`);
  });

  test('an unrelated well-known path is null (falls through to the caller)', () => {
    expect(oauthDiscovery(gateEnv(), '/.well-known/openid-configuration')).toBeNull();
  });
});
