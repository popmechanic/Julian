// Testing pattern (learned from the sync worker's export tests): wrangler
// [vars] are resolved by workerd, so mutating the `cloudflare:test` `env`
// facade does NOT propagate through `SELF`. The 401 gate is therefore proven
// through `SELF.fetch` (real routed worker, no token), and every authed path
// is proven by calling `worker.fetch(req, env)` directly with the mutated env
// — which still exercises the real DO binding and the (mocked) upstream fetch
// end to end.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { env, runInDurableObject, SELF, fetchMock } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import worker from '../src/index';
import type { Env } from '../src/env';
import type { GovernorDO, LeaseIdentity } from '../src/governor';

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

  // #38 redirect: the completeness critic found the empty-string/whitespace
  // case sails past `Number(x)` (Number('')===0), which reads as a valid
  // cursor and silently returns an always-empty page — the loss direction
  // the global constraint forbids. Only a bare non-negative integer string
  // is accepted now.
  test('/ledger: before="" / whitespace / negative → 400, never a silently-empty page', async () => {
    const { testEnv } = await authedEnv();
    testEnv.BREAKGLASS_SECRET = 'test-breakglass-secret';
    for (const bad of ['', '%20', '-5']) {
      const res = await worker.fetch(
        new Request(`${BASE}/ledger?limit=5&before=${bad}`, { headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' } }),
        testEnv,
      );
      expect(res.status, `before=${bad}`).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('before must be a unix-ms timestamp');
    }
  });

  test('/ledger: beforeId without before → 400', async () => {
    const { testEnv } = await authedEnv();
    testEnv.BREAKGLASS_SECRET = 'test-breakglass-secret';
    const res = await worker.fetch(
      new Request(`${BASE}/ledger?limit=5&beforeId=3`, { headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' } }),
      testEnv,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('beforeId requires before');
  });

  // The adversarial reviewer proved the beforeId malformed-value guard was
  // untested: deleting it left the suite green, and with it gone
  // `?before=<ts>&beforeId=abc` would degrade silently to the ts-only
  // branch — dropping the tied-timestamp group, the loss direction the
  // global constraint forbids (#38 redirect). `before` is always present
  // and valid here so only the beforeId guard is under test.
  test('/ledger: beforeId="" / whitespace / negative / non-numeric → 400, never silently ignored', async () => {
    const { testEnv } = await authedEnv();
    testEnv.BREAKGLASS_SECRET = 'test-breakglass-secret';
    for (const bad of ['', '%20', '-5', 'abc']) {
      const res = await worker.fetch(
        new Request(`${BASE}/ledger?limit=5&before=1700000000000&beforeId=${bad}`, {
          headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' },
        }),
        testEnv,
      );
      expect(res.status, `beforeId=${bad}`).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('beforeId must be a non-negative integer');
    }
  });

  test('/ledger: compound cursor (before+beforeId) actually filters, proven by BODY content (#38 redirect)', async () => {
    const { token, testEnv } = await authedEnv();
    testEnv.BREAKGLASS_SECRET = 'test-breakglass-secret';
    // Seed three distinguishable rows through the real authed path — not a
    // direct DO poke — so this proves the wire, not just the DO method.
    for (const subject of ['first', 'second', 'third']) {
      fetchMock.get('https://api.agentmail.to')
        .intercept({ method: 'POST', path: `${INBOX_PATH}/messages/send` })
        .reply(200, JSON.stringify({ message_id: subject }), { headers: { 'content-type': 'application/json' } });
      const sent = await worker.fetch(
        authed(token, '/mail/send', { method: 'POST', body: JSON.stringify({ to: ['a@b.c'], subject, text: 'x' }) }),
        testEnv,
      );
      expect(sent.status).toBe(200);
    }

    const full = await worker.fetch(
      new Request(`${BASE}/ledger?limit=50`, { headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' } }),
      testEnv,
    );
    const { entries } = (await full.json()) as { entries: Array<{ id: number; ts: number; detail: string }> };
    const newest = entries.find((e) => e.detail.includes('subject=third'));
    if (!newest) throw new Error('seed row missing from /ledger');

    const cursored = await worker.fetch(
      new Request(`${BASE}/ledger?limit=50&before=${newest.ts}&beforeId=${newest.id}`, {
        headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' },
      }),
      testEnv,
    );
    expect(cursored.status).toBe(200);
    const { entries: cursoredEntries } = (await cursored.json()) as { entries: Array<{ detail: string }> };
    // Reviewer-proven regression guard: assert the exclusion by BODY
    // content, not just status — a status-only assertion survives deleting
    // the passthrough entirely.
    expect(cursoredEntries.some((e) => e.detail.includes('subject=third'))).toBe(false);
    expect(cursoredEntries.some((e) => e.detail.includes('subject=second'))).toBe(true);
    expect(cursoredEntries.some((e) => e.detail.includes('subject=first'))).toBe(true);
  });

  // Distinct-millisecond sends (the test above) can't tell "beforeId is
  // wired through" from "before alone happened to work" — a plain ts-only
  // cursor already excludes rows at a strictly-later ts. Seed three rows
  // sharing one exact ts directly in the same named DO the worker routes to
  // (`idFromName('governor')`, per src/index.ts) so the compound cursor's
  // (ts, rowid) resolution is the only thing that can be filtering here.
  test('/ledger: beforeId is actually threaded through, not silently dropped (#38 redirect)', async () => {
    const { testEnv } = await authedEnv();
    testEnv.BREAKGLASS_SECRET = 'test-breakglass-secret';
    const gov = env.GOVERNOR.get(env.GOVERNOR.idFromName('governor'));
    await runInDurableObject(gov, async (g: GovernorDO) => {
      const tiedTs = Date.now();
      const sql = (g as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      for (const detail of ['tied-a', 'tied-b', 'tied-c']) {
        sql.exec(
          'INSERT INTO ledger (ts, sub, service, verb, detail, allowed) VALUES (?, ?, ?, ?, ?, ?)',
          tiedTs, 's', 'stream', 'export', detail, 1,
        );
      }
    });

    const full = await worker.fetch(
      new Request(`${BASE}/ledger?limit=50`, { headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' } }),
      testEnv,
    );
    const { entries } = (await full.json()) as { entries: Array<{ id: number; ts: number; detail: string }> };
    const tied = entries.filter((e) => e.detail.startsWith('tied-'));
    expect(tied.length).toBe(3); // newest-first: tied-c, tied-b, tied-a
    const middle = tied[1]; // tied-b

    const tsOnly = await worker.fetch(
      new Request(`${BASE}/ledger?limit=50&before=${middle.ts}`, { headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' } }),
      testEnv,
    );
    const { entries: tsOnlyEntries } = (await tsOnly.json()) as { entries: Array<{ detail: string }> };
    // ts-only excludes the whole tied group — it cannot land between them.
    expect(tsOnlyEntries.some((e) => e.detail.startsWith('tied-'))).toBe(false);

    const compound = await worker.fetch(
      new Request(`${BASE}/ledger?limit=50&before=${middle.ts}&beforeId=${middle.id}`, {
        headers: { 'X-Breakglass-Secret': 'test-breakglass-secret' },
      }),
      testEnv,
    );
    const { entries: compoundEntries } = (await compound.json()) as { entries: Array<{ detail: string }> };
    // The compound cursor lands exactly between tied-b and tied-a: tied-a
    // survives (strictly-lower rowid at the same ts), tied-b and tied-c do
    // not. If beforeId were dropped, this would collapse to the ts-only
    // result above and tied-a would be excluded too.
    expect(compoundEntries.some((e) => e.detail === 'tied-a')).toBe(true);
    expect(compoundEntries.some((e) => e.detail === 'tied-b')).toBe(false);
    expect(compoundEntries.some((e) => e.detail === 'tied-c')).toBe(false);
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
