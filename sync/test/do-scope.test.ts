// sync/test/do-scope.test.ts — defense-in-depth: the DO's traffic-driven
// re-auth independently closes any socket whose lease scope is not
// stream-capable, rather than trusting the router's upgrade-time check as
// the only guard (gate 2A review: "the DO's blanket 'trust the router' is
// unsafe once multiple scopes share the register").
//
// Testing pattern matches sync/test/lease-introspect.test.ts's "DO
// webSocketMessage: traffic-driven re-auth" describe block: a real
// WebSocketPair accepted through the DO's own ctx.acceptWebSocket (a
// duck-typed plain object fails super.webSocketMessage's ctx.getTags native
// binding), fetchMock for the gate's /introspect, and a stale
// (> REAUTH_INTERVAL_MS) verifiedAt to force the re-introspection path.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/auth';
import type { JulianSyncDO } from '../src/do';

const GATE = 'https://gate.test';

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

function stub() {
  return env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(`test/do-scope-${crypto.randomUUID().slice(0, 8)}`));
}

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

describe('JulianSyncDO webSocketMessage: scope re-check on traffic-driven re-auth', () => {
  test('closes a socket whose lease scope is no longer stream-capable (reading-room)', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(200, JSON.stringify({ active: true, lease_id: 'l1', door_name: 'door:reader', scope: 'reading-room' }),
        { headers: { 'content-type': 'application/json' } });

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_scopedrop1', verifiedAt: Date.now() - 400_000 });
      (instance as unknown as { env: Env }).env.GATE_URL = GATE;
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: 'lease scope may not read the stream' });
    });
  });

  test('stream-read scope refreshes verifiedAt and does not close', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(200, JSON.stringify({ active: true, lease_id: 'l2', door_name: 'door:reader2', scope: 'stream-read' }),
        { headers: { 'content-type': 'application/json' } });

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      const staleAt = Date.now() - 400_000;
      server.serializeAttachment({ leaseToken: 'jla_streamread1', verifiedAt: staleAt });
      (instance as unknown as { env: Env }).env.GATE_URL = GATE;
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();

      const refreshed = server.deserializeAttachment() as { leaseToken: string; verifiedAt: number };
      expect(refreshed.verifiedAt).toBeGreaterThan(staleAt);
    });
  });

  test('full-house scope refreshes verifiedAt and does not close', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(200, JSON.stringify({ active: true, lease_id: 'l3', door_name: 'door:homeowner', scope: 'full-house' }),
        { headers: { 'content-type': 'application/json' } });

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_fullhouse1', verifiedAt: Date.now() - 400_000 });
      (instance as unknown as { env: Env }).env.GATE_URL = GATE;
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });

  test('the revoked (4001) check still takes priority over the scope check', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .reply(200, JSON.stringify({ active: false }), { headers: { 'content-type': 'application/json' } });

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_revoked_scope', verifiedAt: Date.now() - 400_000 });
      (instance as unknown as { env: Env }).env.GATE_URL = GATE;
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test('an unreachable gate still closes 4002, never 4003, on a scope-only failure', async () => {
    fetchMock.get(GATE)
      .intercept({ method: 'POST', path: '/introspect' })
      .replyWithError(new Error('connect timeout'));

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_unreachable_scope', verifiedAt: Date.now() - 400_000 });
      (instance as unknown as { env: Env }).env.GATE_URL = GATE;
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4002, reason: 'introspection unavailable' });
    });
  });

  test('fresh attachment (< 5 min) skips re-introspection and scope re-check entirely', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      // A reading-room-scoped lease that is still fresh must not be closed —
      // no fetchMock interceptor is registered, so any introspection attempt
      // would reject and get caught, closing 4002; "not closed" also proves
      // no re-introspection (and thus no scope re-check) was attempted.
      server.serializeAttachment({ leaseToken: 'jla_fresh_scope', verifiedAt: Date.now() });
      (instance as unknown as { env: Env }).env.GATE_URL = GATE;
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });
});
