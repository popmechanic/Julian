// sync/test/lease-introspect.test.ts — julian-sync accepts lease tokens by
// asking the gate (POST /introspect), never verifying them locally.
//
// Testing pattern (matches sync/test/export.test.ts and broker/test/routing.test.ts):
// wrangler [vars] are resolved by workerd, so mutating the `cloudflare:test`
// `env` facade does not propagate through `SELF`. Paths that never need
// GATE_URL/INTROSPECT_SECRET (the query-string rejection) are proven through
// `SELF`; paths that do are proven by invoking the worker's default handler
// directly with the mutated env passed explicitly as the argument.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { env, fetchMock, runInDurableObject, SELF } from 'cloudflare:test';
import worker from '../src/index';
import { introspectLease } from '../src/auth';
import type { Env } from '../src/auth';
import type { JulianSyncDO } from '../src/do';

const GATE = 'https://gate.test';

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('introspectLease', () => {
  test('sends the secret header and the token form-encoded', async () => {
    fetchMock.get(GATE)
      .intercept({
        method: 'POST',
        path: '/introspect',
        headers: { 'x-introspect-secret': 'test-secret' },
        body: 'token=jla_check1',
      })
      .reply(200, JSON.stringify({ active: true, lease_id: 'l1', door_name: 'door:x', scope: 'full-house' }),
        { headers: { 'content-type': 'application/json' } });

    const result = await introspectLease('jla_check1', GATE, 'test-secret');
    expect(result).toEqual({ active: true, leaseId: 'l1', doorName: 'door:x', scope: 'full-house' });
  });

  test('60s cache hit skips a second fetch for the same token', async () => {
    // Only one interceptor is registered — if the cache didn't hold, the
    // second call would have no matching mock and throw.
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(200, JSON.stringify({ active: true, lease_id: 'l2', door_name: 'door:y', scope: 'full-house' }),
        { headers: { 'content-type': 'application/json' } });

    const first = await introspectLease('jla_cachehit', GATE, 'test-secret');
    const second = await introspectLease('jla_cachehit', GATE, 'test-secret');
    expect(second).toEqual(first);
    expect(second).toEqual({ active: true, leaseId: 'l2', doorName: 'door:y', scope: 'full-house' });
  });

  test('non-200 response → inactive', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(401, '');

    expect(await introspectLease('jla_badsecret', GATE, 'wrong-secret')).toEqual({ active: false });
  });

  test('active:false response → inactive, no lease fields', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(200, JSON.stringify({ active: false }), { headers: { 'content-type': 'application/json' } });

    expect(await introspectLease('jla_unknown1', GATE, 'test-secret')).toEqual({ active: false });
  });

  test('gate unreachable (network error) propagates — caller decides fail-closed handling', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .replyWithError(new Error('connect timeout'));

    await expect(introspectLease('jla_unreachable1', GATE, 'test-secret')).rejects.toThrow();
  });
});

describe('router: lease-token bearer handling', () => {
  test('jla_ token in the query string is rejected — headers only', async () => {
    const res = await SELF.fetch('https://sync.test/store/ctx?token=jla_inquery');
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('lease tokens ride in headers only');
  });

  test('jla_ header token with active introspection forwards to the DO stub', async () => {
    const testEnv = env as unknown as Env;
    testEnv.GATE_URL = GATE;
    testEnv.INTROSPECT_SECRET = 'test-secret';

    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(200, JSON.stringify({ active: true, lease_id: 'l3', door_name: 'door:z', scope: 'full-house' }),
        { headers: { 'content-type': 'application/json' } });

    let stubFetchCalled = false;
    const fakeStub = {
      fetch: async (_req: Request) => { stubFetchCalled = true; return new Response(null, { status: 200 }); },
    };
    const fakeNamespace = {
      idFromName: (name: string) => name,
      get: (_id: string) => fakeStub,
    };
    const testEnvWithFakeDO = Object.assign(
      Object.create(null), testEnv, { JULIAN_SYNC: fakeNamespace },
    ) as unknown as Env;

    const res = await worker.fetch(
      new Request('https://sync.test/store/ctx', {
        headers: { Authorization: 'Bearer jla_header1', Upgrade: 'websocket' },
      }),
      testEnvWithFakeDO,
    );
    expect(stubFetchCalled).toBe(true);
    expect(res.status).toBe(200);
  });

  test('jla_ header token with inactive introspection → 401', async () => {
    const testEnv = env as unknown as Env;
    testEnv.GATE_URL = GATE;
    testEnv.INTROSPECT_SECRET = 'test-secret';

    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(200, JSON.stringify({ active: false }), { headers: { 'content-type': 'application/json' } });

    const res = await worker.fetch(
      new Request('https://sync.test/store/ctx', {
        headers: { Authorization: 'Bearer jla_revoked1', Upgrade: 'websocket' },
      }),
      testEnv,
    );
    expect(res.status).toBe(401);
  });

  test('jla_ header token, gate unreachable → 503 (fails closed, never forwarded)', async () => {
    const testEnv = env as unknown as Env;
    testEnv.GATE_URL = GATE;
    testEnv.INTROSPECT_SECRET = 'test-secret';

    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .replyWithError(new Error('connect timeout'));

    const res = await worker.fetch(
      new Request('https://sync.test/store/ctx', {
        headers: { Authorization: 'Bearer jla_unreachable2', Upgrade: 'websocket' },
      }),
      testEnv,
    );
    expect(res.status).toBe(503);
  });
});

// webSocketMessage's base implementation (`super.webSocketMessage`) asks the
// Durable Object runtime for the socket's tags via `ctx.getTags(ws)` — a
// native binding that rejects anything but a genuine accepted WebSocket
// (a duck-typed plain object throws "parameter 1 is not of type
// 'WebSocket'"). So these tests accept a real WebSocketPair through the DO's
// own `ctx.acceptWebSocket`, exactly as `fetch()` does in production, rather
// than faking the socket.
function acceptedSocket(instance: JulianSyncDO): { client: WebSocket; server: WebSocket } {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  (instance as unknown as { ctx: DurableObjectState }).ctx.acceptWebSocket(server, [`t-${crypto.randomUUID()}`]);
  client.accept();
  return { client, server };
}

function waitForClose(client: WebSocket, timeoutMs = 200): Promise<{ code: number; reason: string } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    client.addEventListener('close', (evt) => {
      clearTimeout(timer);
      const closeEvt = evt as unknown as { code: number; reason: string };
      resolve({ code: closeEvt.code, reason: closeEvt.reason });
    });
  });
}

describe('DO webSocketMessage: traffic-driven re-auth', () => {
  function stub() {
    return env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(`test/reauth-${crypto.randomUUID().slice(0, 8)}`));
  }

  test('fresh attachment (< 5 min) skips re-introspection entirely', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_fresh1', verifiedAt: Date.now() });
      (instance as unknown as { env: Env }).env.GATE_URL = GATE;
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      // No fetchMock interceptor registered — a re-introspect attempt would
      // reject and get caught internally, closing 4002. Asserting "not
      // closed" therefore also proves no introspection was attempted.
      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });

  test('stale attachment (> 5 min) + inactive introspection → closes 4001 "lease revoked"', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(200, JSON.stringify({ active: false }), { headers: { 'content-type': 'application/json' } });

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_stale1', verifiedAt: Date.now() - 400_000 });
      (instance as unknown as { env: Env }).env.GATE_URL = GATE;
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test('stale attachment + gate unreachable → closes 4002 "introspection unavailable"', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .replyWithError(new Error('connect timeout'));

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_stale2', verifiedAt: Date.now() - 400_000 });
      (instance as unknown as { env: Env }).env.GATE_URL = GATE;
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4002, reason: 'introspection unavailable' });
    });
  });

  test('stale attachment + active introspection refreshes verifiedAt and does not close', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(200, JSON.stringify({ active: true, lease_id: 'l4', door_name: 'door:w', scope: 'full-house' }),
        { headers: { 'content-type': 'application/json' } });

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      const staleAt = Date.now() - 400_000;
      server.serializeAttachment({ leaseToken: 'jla_stale3', verifiedAt: staleAt });
      (instance as unknown as { env: Env }).env.GATE_URL = GATE;
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();

      const refreshed = server.deserializeAttachment() as { leaseToken: string; verifiedAt: number };
      expect(refreshed.leaseToken).toBe('jla_stale3');
      expect(refreshed.verifiedAt).toBeGreaterThan(staleAt);
    });
  });

  test('no attachment (legacy JWT socket) skips re-auth entirely, no introspection', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      // No serializeAttachment call — a legacy-JWT socket never gets one.

      // No fetchMock interceptor registered — proves no introspection happens.
      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });
});
