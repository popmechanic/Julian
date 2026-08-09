// The knock, proven against a scripted governor.
//
// Same seam lease-auth.test.ts uses: the point of these tests is what
// handleDevice asks the governor and how it maps the answer onto the RFC
// 8628 wire shape — not what the DO itself decides (governor-leases.test.ts
// owns that half).
import { describe, expect, test } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import type { DevicePollResult, KnockCreated, KnockRefused, MintResult } from '../src/governor';

const BASE = 'https://gate.test';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface Script {
  knockCreate?: (clientId: string, host: string, purpose: string) => KnockCreated | KnockRefused;
  devicePoll?: (deviceCode: string, clientId: string) => DevicePollResult;
  mintFromRefresh?: (refreshToken: string) => MintResult;
  governorDown?: boolean;
}

interface Calls {
  knockCreate: Array<[string, string, string]>;
  devicePoll: Array<[string, string]>;
  mintFromRefresh: string[];
}

function gateEnv(script: Script = {}): { env: Env; calls: Calls } {
  const calls: Calls = { knockCreate: [], devicePoll: [], mintFromRefresh: [] };
  const stub = {
    async knockCreate(clientId: string, host: string, purpose: string): Promise<KnockCreated | KnockRefused> {
      calls.knockCreate.push([clientId, host, purpose]);
      if (script.governorDown) throw new Error('governor down');
      return script.knockCreate
        ? script.knockCreate(clientId, host, purpose)
        : { deviceCode: 'dc1', userCode: 'BCDF-GHJK', expiresIn: 900, interval: 5 };
    },
    async devicePoll(deviceCode: string, clientId: string): Promise<DevicePollResult> {
      calls.devicePoll.push([deviceCode, clientId]);
      if (script.governorDown) throw new Error('governor down');
      return script.devicePoll ? script.devicePoll(deviceCode, clientId) : { status: 'pending' };
    },
    async mintFromRefresh(refreshToken: string): Promise<MintResult> {
      calls.mintFromRefresh.push(refreshToken);
      if (script.governorDown) throw new Error('governor down');
      return script.mintFromRefresh ? script.mintFromRefresh(refreshToken) : { status: 'invalid' };
    },
    async validateAccess(): Promise<null> { return null; },
    async legacyAllowed(): Promise<boolean> { return false; },
    async reserveLease(): Promise<never> { throw new Error('not used by device-flow tests'); },
    async entries(): Promise<unknown[]> { return []; },
  };
  const env = {
    GOVERNOR: { idFromName: () => 'governor-id', get: () => stub },
    OIDC_ISSUER: 'https://soul.test',
    OIDC_AUDIENCE: 'julian-app',
    OIDC_JWKS_URL: 'https://soul.test/.well-known/jwks.json',
    AGENTMAIL_API_KEY: 'test-key-abc',
    AGENTMAIL_INBOX_ID: 'julian-marcus@agentmail.to',
    LEGACY_WINDOW_END: '2099-01-01T00:00:00.000Z',
    APPROVER_SUBS: 'user_marcus',
    GATE_CLIENT_ID: 'test-client',
    GATE_REDIRECT_URI: `${BASE}/auth/callback`,
    PUBLIC_URL: BASE,
    SESSION_SECRET: 'test-secret',
    INTROSPECT_SECRET: 'test-secret',
    BREAKGLASS_SECRET: 'test-secret',
  } as unknown as Env;
  return { env, calls };
}

function form(fields: Record<string, string>): RequestInit {
  const body = new URLSearchParams(fields);
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  };
}

describe('POST /device', () => {
  test('happy path returns RFC-shaped snake_case JSON', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(
      new Request(`${BASE}/device`, form({ client_id: 'd', host: 'h', purpose: 'p' })),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['device_code', 'expires_in', 'interval', 'user_code', 'verification_uri']);
    expect(body).toEqual({
      device_code: 'dc1', user_code: 'BCDF-GHJK',
      verification_uri: `${BASE}/approve`, expires_in: 900, interval: 5,
    });
  });

  test('JSON body → 400 invalid_request', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'd', host: 'h', purpose: 'p' }),
    }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  test('missing client_id → 400 invalid_request naming the field', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(
      new Request(`${BASE}/device`, form({ client_id: '', host: 'h', purpose: 'p' })),
      env,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; error_description?: string };
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('client_id');
    expect(calls.knockCreate).toEqual([]);
  });

  test('missing host and purpose → 400 invalid_request', async () => {
    const { env } = gateEnv();
    const noHost = await worker.fetch(new Request(`${BASE}/device`, form({ client_id: 'd', host: '', purpose: 'p' })), env);
    expect(noHost.status).toBe(400);
    expect((await noHost.json() as { error_description: string }).error_description).toContain('host');

    const noPurpose = await worker.fetch(new Request(`${BASE}/device`, form({ client_id: 'd', host: 'h', purpose: '' })), env);
    expect(noPurpose.status).toBe(400);
    expect((await noPurpose.json() as { error_description: string }).error_description).toContain('purpose');
  });

  test('knock flooding → 429 slow_down', async () => {
    const { env } = gateEnv({ knockCreate: () => ({ error: 'slow_down' }) });
    const res = await worker.fetch(new Request(`${BASE}/device`, form({ client_id: 'd', host: 'h', purpose: 'p' })), env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'slow_down' });
  });

  test('governor unreachable → 503', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(new Request(`${BASE}/device`, form({ client_id: 'd', host: 'h', purpose: 'p' })), env);
    expect(res.status).toBe(503);
  });

  test('requires no Authorization header — a bearer present is simply ignored', async () => {
    const { env } = gateEnv();
    const req = new Request(`${BASE}/device`, {
      ...form({ client_id: 'd', host: 'h', purpose: 'p' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer garbage' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
  });
});

describe('POST /token — device grant', () => {
  test('all four poll states map to RFC error codes at HTTP 400', async () => {
    const cases: Array<[Exclude<DevicePollResult['status'], 'ready'>, string]> = [
      ['pending', 'authorization_pending'],
      ['slow_down', 'slow_down'],
      ['expired', 'expired_token'],
      ['refused', 'access_denied'],
    ];
    for (const [status, code] of cases) {
      const { env } = gateEnv({ devicePoll: () => ({ status }) });
      const res = await worker.fetch(new Request(`${BASE}/token`, form({
        grant_type: DEVICE_GRANT, device_code: 'dc1', client_id: 'd',
      })), env);
      expect(res.status, status).toBe(400);
      expect(await res.json(), status).toEqual({ error: code });
    }
  });

  test('ready poll returns access_token/refresh_token/expires_in/scope', async () => {
    const { env, calls } = gateEnv({
      devicePoll: () => ({
        status: 'ready', accessToken: 'jla_abc', refreshToken: 'jlr_def', expiresIn: 3600, scope: 'full-house',
      }),
    });
    const res = await worker.fetch(new Request(`${BASE}/token`, form({
      grant_type: DEVICE_GRANT, device_code: 'dc1', client_id: 'd',
    })), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      access_token: 'jla_abc', token_type: 'Bearer', expires_in: 3600, refresh_token: 'jlr_def', scope: 'full-house',
    });
    expect(calls.devicePoll).toEqual([['dc1', 'd']]);
  });

  test('missing client_id or device_code on the device grant → 400 invalid_request', async () => {
    const { env } = gateEnv();
    const noClient = await worker.fetch(new Request(`${BASE}/token`, form({ grant_type: DEVICE_GRANT, device_code: 'dc1' })), env);
    expect(noClient.status).toBe(400);
    expect((await noClient.json() as { error: string }).error).toBe('invalid_request');

    const noDevice = await worker.fetch(new Request(`${BASE}/token`, form({ grant_type: DEVICE_GRANT, client_id: 'd' })), env);
    expect(noDevice.status).toBe(400);
    expect((await noDevice.json() as { error: string }).error).toBe('invalid_request');
  });

  test('governor unreachable → 503', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(new Request(`${BASE}/token`, form({
      grant_type: DEVICE_GRANT, device_code: 'dc1', client_id: 'd',
    })), env);
    expect(res.status).toBe(503);
  });
});

describe('POST /token — refresh grant', () => {
  test('ok mints a fresh pair', async () => {
    const { env, calls } = gateEnv({
      mintFromRefresh: () => ({
        status: 'ok', accessToken: 'jla_new', refreshToken: 'jlr_new', expiresIn: 3600, scope: 'full-house',
      }),
    });
    const res = await worker.fetch(new Request(`${BASE}/token`, form({ grant_type: 'refresh_token', refresh_token: 'jlr_old' })), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      access_token: 'jla_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'jlr_new', scope: 'full-house',
    });
    expect(calls.mintFromRefresh).toEqual(['jlr_old']);
  });

  test('unknown refresh token → invalid_grant', async () => {
    const { env } = gateEnv({ mintFromRefresh: () => ({ status: 'invalid' }) });
    const res = await worker.fetch(new Request(`${BASE}/token`, form({ grant_type: 'refresh_token', refresh_token: 'jlr_nope' })), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
  });

  test('killed lease (rotation replay) → invalid_grant with rotation-replay description', async () => {
    const { env } = gateEnv({ mintFromRefresh: () => ({ status: 'killed' }) });
    const res = await worker.fetch(new Request(`${BASE}/token`, form({ grant_type: 'refresh_token', refresh_token: 'jlr_stolen' })), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant', error_description: 'lease killed: rotation replay' });
  });

  test('missing refresh_token → 400 invalid_request', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/token`, form({ grant_type: 'refresh_token' })), env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_request');
  });
});

describe('POST /token — grant_type dispatch', () => {
  test('unknown grant_type → 400 unsupported_grant_type', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/token`, form({ grant_type: 'password', username: 'x' })), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_grant_type' });
  });

  test('JSON body → 400 invalid_request', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'jlr_x' }),
    }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  test('requires no Authorization header — a bearer present is simply ignored', async () => {
    const { env } = gateEnv({ mintFromRefresh: () => ({ status: 'invalid' }) });
    const req = new Request(`${BASE}/token`, {
      ...form({ grant_type: 'refresh_token', refresh_token: 'jlr_x' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer garbage' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
  });
});
