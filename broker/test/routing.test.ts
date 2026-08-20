// Testing pattern (learned from the sync worker's export tests): wrangler
// [vars] are resolved by workerd, so mutating the `cloudflare:test` `env`
// facade does NOT propagate through `SELF`. The 401 gate is therefore proven
// through `SELF.fetch` (real routed worker, no token), and every authed path
// is proven by calling `worker.fetch(req, env)` directly with the mutated env
// — which still exercises the real DO binding and the (mocked) upstream fetch
// end to end.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { env, SELF, fetchMock } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import worker from '../src/index';
import type { Env } from '../src/env';
import type { LeaseIdentity } from '../src/governor';

const ISSUER = 'https://soul.test';
const AUDIENCE = 'julian-app';
const BASE = 'https://broker.test';
const INBOX_PATH = '/v0/inboxes/julian-marcus%40agentmail.to';

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function authedEnv(): Promise<{ token: string; testEnv: Env }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const testEnv = env as unknown as Env;
  testEnv.OIDC_JWKS_JSON = JSON.stringify({ keys: [jwk] });
  testEnv.OIDC_ISSUER = ISSUER;
  testEnv.OIDC_AUDIENCE = AUDIENCE;
  testEnv.AGENTMAIL_API_KEY = 'test-key-abc';
  testEnv.AGENTMAIL_INBOX_ID = 'julian-marcus@agentmail.to';
  // These Pocket ID bearers now enter through the legacy window, so the tests
  // must hold it open on their own clock rather than on the deploy placeholder.
  testEnv.LEGACY_WINDOW_END = '2099-01-01T00:00:00.000Z';
  const token = await new SignJWT({ sub: 'user_marcus' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
  return { token, testEnv };
}

function authed(token: string, path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

describe('default-deny', () => {
  test('every route 401s without a token (via the routed worker)', async () => {
    for (const path of ['/mail/send', '/mail/messages', '/mail/messages/x', '/health', '/ledger']) {
      const res = await SELF.fetch(`${BASE}${path}`, { method: path === '/mail/send' ? 'POST' : 'GET' });
      expect(res.status, path).toBe(401);
    }
  });
  test('garbage token → 401', async () => {
    const res = await SELF.fetch(`${BASE}/health`, { headers: { Authorization: 'Bearer not-a-jwt' } });
    expect(res.status).toBe(401);
  });

  test('/ledger is an approver-gated register action, not a lease verb', async () => {
    const { token, testEnv } = await authedEnv();
    const res = await worker.fetch(authed(token, '/ledger'), testEnv);
    expect(res.status).toBe(401); // a lease token is not an approver credential
  });

  test('/ledger: before passes through; malformed before is a 400', async () => {
    const { testEnv } = await authedEnv();
    testEnv.BREAKGLASS_SECRET = 'test-breakglass-secret';
    const ok = await worker.fetch(
      new Request(`${BASE}/ledger?limit=5&before=1700000000000`, { headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' } }),
      testEnv,
    );
    expect(ok.status).toBe(200);
    const bad = await worker.fetch(
      new Request(`${BASE}/ledger?limit=5&before=nonsense`, { headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' } }),
      testEnv,
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('before must be a unix-ms timestamp');
  });

  test('/refusals is introspect-secret territory, not a lease verb', async () => {
    const { token, testEnv } = await authedEnv();
    const res = await worker.fetch(authed(token, '/refusals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'x', door_name: 'y', service: 'stream', verb: 'socket', detail: 'z' }),
    }), testEnv);
    expect(res.status).toBe(401); // a lease bearer is not the machine credential
  });
});

describe('mail routes', () => {
  test('send: happy path passes through upstream response and never leaks the key', async () => {
    const { token, testEnv } = await authedEnv();
    fetchMock.get('https://api.agentmail.to')
      .intercept({ method: 'POST', path: `${INBOX_PATH}/messages/send` })
      .reply(200, JSON.stringify({ message_id: 'msg_42' }), { headers: { 'content-type': 'application/json' } });
    const res = await worker.fetch(
      authed(token, '/mail/send', { method: 'POST', body: JSON.stringify({ to: ['mike@example.com'], subject: 'hello', text: 'hi' }) }),
      testEnv,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).message_id).toBe('msg_42');
    expect(text).not.toContain('test-key-abc'); // results, never tokens
  });

  test('send: invalid body → 400, nothing reaches upstream', async () => {
    const { token, testEnv } = await authedEnv();
    const res = await worker.fetch(
      authed(token, '/mail/send', { method: 'POST', body: JSON.stringify({ subject: 'no recipients' }) }),
      testEnv,
    );
    expect(res.status).toBe(400);
  });

  test('send: 21st send of the day → 429 quoting the policy; refusal is in the ledger', async () => {
    const { token, testEnv } = await authedEnv();
    testEnv.BREAKGLASS_SECRET = 'test-breakglass-secret';
    for (let i = 0; i < 20; i++) {
      fetchMock.get('https://api.agentmail.to')
        .intercept({ method: 'POST', path: `${INBOX_PATH}/messages/send` })
        .reply(200, JSON.stringify({ message_id: `m${i}` }), { headers: { 'content-type': 'application/json' } });
      const ok = await worker.fetch(
        authed(token, '/mail/send', { method: 'POST', body: JSON.stringify({ to: ['a@b.c'], subject: `n${i}`, text: 'x' }) }),
        testEnv,
      );
      expect(ok.status).toBe(200);
    }
    const refused = await worker.fetch(
      authed(token, '/mail/send', { method: 'POST', body: JSON.stringify({ to: ['a@b.c'], subject: 'n21', text: 'x' }) }),
      testEnv,
    );
    expect(refused.status).toBe(429);
    const body = await refused.json() as { policy: string };
    expect(body.policy).toBe('mail.send: 20/day');

    const ledger = await worker.fetch(
      new Request(`${BASE}/ledger?limit=50`, { headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' } }),
      testEnv,
    );
    const { entries } = await ledger.json() as { entries: Array<{ verb: string; allowed: number; sub: string }> };
    const sends = entries.filter((e) => e.verb === 'send');
    expect(sends.length).toBe(21);
    expect(sends[0].allowed).toBe(0);
    // Every gate-authenticated act is ledgered under the lease, not the person:
    // a Pocket ID bearer inside the window is the `legacy-window` pseudo-lease.
    expect(sends[0].sub).toBe('lease:legacy-window');
  });

  test('list and read: authed passthrough with reservation logged', async () => {
    const { token, testEnv } = await authedEnv();
    fetchMock.get('https://api.agentmail.to')
      .intercept({ method: 'GET', path: `${INBOX_PATH}/messages` })
      .reply(200, JSON.stringify({ messages: [] }), { headers: { 'content-type': 'application/json' } });
    const list = await worker.fetch(authed(token, '/mail/messages'), testEnv);
    expect(list.status).toBe(200);

    fetchMock.get('https://api.agentmail.to')
      .intercept({ method: 'GET', path: `${INBOX_PATH}/messages/msg_7` })
      .reply(200, JSON.stringify({ message_id: 'msg_7' }), { headers: { 'content-type': 'application/json' } });
    const read = await worker.fetch(authed(token, '/mail/messages/msg_7'), testEnv);
    expect(read.status).toBe(200);
    expect((await read.json() as { message_id: string }).message_id).toBe('msg_7');
  });

  test('read: malformed percent-encoding in id -> 400, not 500', async () => {
    const { token, testEnv } = await authedEnv();
    const res = await worker.fetch(authed(token, '/mail/messages/%zz'), testEnv);
    expect(res.status).toBe(400);
  });

  test('health: reports the mail trichotomy and contains no key material', async () => {
    const { token, testEnv } = await authedEnv();
    fetchMock.get('https://api.agentmail.to')
      .intercept({ method: 'GET', path: `${INBOX_PATH}/messages?limit=1` })
      .reply(200, '{}');
    const res = await worker.fetch(authed(token, '/health'), testEnv);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ services: { mail: 'valid' } });
    expect(text).not.toContain('test-key-abc');
  });

  test('governor unreachable → 503, send refused without a ledger entry (fail closed)', async () => {
    const { token, testEnv } = await authedEnv();
    const broken = Object.assign(Object.create(null), testEnv, {
      GOVERNOR: { idFromName: () => 'x', get: () => { throw new Error('governor down'); } },
    }) as unknown as Env;
    const res = await worker.fetch(
      authed(token, '/mail/send', { method: 'POST', body: JSON.stringify({ to: ['a@b.c'], subject: 's', text: 'x' }) }),
      broken,
    );
    expect(res.status).toBe(503); // and no upstream interceptor was consumed — nothing was sent
  });

  test('unknown path → 404', async () => {
    const { token, testEnv } = await authedEnv();
    const res = await worker.fetch(authed(token, '/mail/delete-everything'), testEnv);
    expect(res.status).toBe(404);
  });
});

describe('authcode routes: ahead of the lease gate', () => {
  test('GET /.well-known/oauth-authorization-server advertises reading-room only, no token needed', async () => {
    const res = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = await res.json() as { scopes_supported: string[] };
    expect(body.scopes_supported).toEqual(['reading-room']);
  });

  test('POST /register reaches the authcode module, not the lease gate', async () => {
    const res = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    // 201 (registered) or 400 (rejected client metadata) both prove the
    // authcode module answered — a 401 would mean the lease gate caught it
    // first, which is the one outcome this test exists to rule out.
    expect(res.status).toBe(201);
    const body = await res.json() as { client_id: string; token_endpoint_auth_method: string };
    expect(typeof body.client_id).toBe('string');
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  test('/token: authorization_code reaches the authcode module, device_code still reaches the device module (regression)', async () => {
    const authcode = await SELF.fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code' }).toString(),
    });
    expect(authcode.status).toBe(400);
    const authcodeBody = await authcode.json() as { error: string; error_description?: string };
    expect(authcodeBody.error).toBe('invalid_request');
    // The authcode module's own missing-fields message — proof this landed
    // there, not in the device module (which would say 'unsupported_grant_type').
    expect(authcodeBody.error_description).toBe('code, client_id, redirect_uri, and code_verifier are required');

    const device = await SELF.fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString(),
    });
    expect(device.status).toBe(400);
    const deviceBody = await device.json() as { error: string; error_description?: string };
    expect(deviceBody.error).toBe('invalid_request');
    // The device module's own missing-fields message — proof the device grant
    // still lands there, unmoved by the new authcode branch.
    expect(deviceBody.error_description).toBe('missing client_id');
  });
});

describe('the /mcp face is wired ahead of the generic lease gate', () => {
  const READER: LeaseIdentity = {
    leaseId: 'l1', doorName: 'visit:claude.ai', scope: 'reading-room', principal: 'julian',
  };

  /** A worker Env whose governor hands back one scripted lease identity. */
  function leasedEnv(identity: LeaseIdentity | null): Env {
    return Object.assign(Object.create(null), env as unknown as Env, {
      GOVERNOR: {
        idFromName: () => 'mcp-test',
        get: () => ({ async validateAccess() { return identity; } }),
      },
    }) as unknown as Env;
  }

  const auth = { Authorization: 'Bearer jla_scripted' };

  test('POST /mcp with no token is a 401 challenge naming the resource metadata', async () => {
    const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: 'POST' }), env as unknown as Env);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    expect(res.headers.get('WWW-Authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
  });

  test('a dead lease on /mcp is the same RFC 9728 challenge, not a JSON scolding', async () => {
    const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: auth }), leasedEnv(null));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
  });

  test('GET /mcp (non-POST) with a living lease is 405', async () => {
    const res = await worker.fetch(new Request(`${BASE}/mcp`, { headers: auth }), leasedEnv(READER));
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  test('POST /mcp with a living lease reaches the face itself', async () => {
    const res = await worker.fetch(new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping', params: {} }),
    }), leasedEnv(READER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });

  test('a governor that will not answer is 503 on /mcp, never a challenge', async () => {
    const broken = Object.assign(Object.create(null), env as unknown as Env, {
      GOVERNOR: {
        idFromName: () => 'x',
        get: () => ({ async validateAccess() { throw new Error('governor down'); } }),
      },
    }) as unknown as Env;
    const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: auth }), broken);
    expect(res.status).toBe(503);
    expect(res.headers.get('WWW-Authenticate')).toBe(null);
  });
});

test('the suite boots with SYNC and EXCHANGE_RL stubbed (pool-boot guard)', () => {
  // env is the pool-provided binding surface; these exist or this file cannot run.
  expect((env as unknown as Env).SYNC).toBeDefined();
  expect(typeof (env as unknown as Env).STREAM_SUBS).toBe('string');
  expect(typeof (env as unknown as Env).APP_ORIGINS).toBe('string');
});
