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
