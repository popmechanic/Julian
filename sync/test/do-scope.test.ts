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
// binding), a fake `GateFetcher` injected as the DO's GATE service binding —
// introspection never rides a public URL (issue #28) — and a stale
// (> REAUTH_INTERVAL_MS) verifiedAt to force the re-introspection path.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env, GateFetcher } from '../src/auth';
import type { JulianSyncDO } from '../src/do';

/** A fake GATE binding returning one scripted introspection body. */
function fakeGate(body: unknown): GateFetcher {
  return {
    fetch: async () => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  };
}

/** A fake GATE binding that never answers — the gate-unreachable case. */
function unreachableGate(): GateFetcher {
  return { fetch: async () => { throw new Error('connect timeout'); } };
}

function installGate(instance: JulianSyncDO, gate: GateFetcher): void {
  const e = (instance as unknown as { env: Env }).env;
  e.GATE = gate;
  e.INTROSPECT_SECRET = 'test-secret';
}

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

describe('JulianSyncDO webSocketMessage: scope + ownership re-check on traffic-driven re-auth', () => {
  test('closes a socket whose lease scope is not full-house (reading-room)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_scopedrop1', verifiedAt: Date.now() - 400_000 });
      installGate(instance, fakeGate({ active: true, lease_id: 'l1', door_name: 'door:reader', scope: 'reading-room' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: 'a sync socket requires full-house' });
    });
  });

  test('closes a socket whose lease is no longer full-house — stream-read mid-socket is 4003', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_streamread1', verifiedAt: Date.now() - 400_000 });
      installGate(instance, fakeGate({ active: true, lease_id: 'l2', door_name: 'door:reader2', scope: 'stream-read' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: 'a sync socket requires full-house' });
    });
  });

  test('closes a socket whose principal no longer owns the store', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_ownerdrop1', verifiedAt: Date.now() - 400_000 });
      installGate(instance, fakeGate({ active: true, lease_id: 'l4', door_name: 'door:reader4', scope: 'full-house', principal: 'guest-ada' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: 'lease does not own this store' });
    });
  });

  test('full-house scope refreshes verifiedAt and does not close', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_fullhouse1', verifiedAt: Date.now() - 400_000 });
      installGate(instance, fakeGate({ active: true, lease_id: 'l3', door_name: 'door:homeowner', scope: 'full-house' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });

  test('the revoked (4001) check still takes priority over the scope check', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_revoked_scope', verifiedAt: Date.now() - 400_000 });
      installGate(instance, fakeGate({ active: false }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test('an unreachable gate still closes 4002, never 4003, on a scope-only failure', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_unreachable_scope', verifiedAt: Date.now() - 400_000 });
      installGate(instance, unreachableGate());

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4002, reason: 'introspection unavailable' });
    });
  });

  test('fresh attachment (< 5 min) skips re-introspection and scope re-check entirely', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      // A reading-room-scoped lease that is still fresh must not be closed —
      // the injected gate always rejects, so any introspection attempt would
      // be caught and close 4002; "not closed" also proves no
      // re-introspection (and thus no scope re-check) was attempted.
      server.serializeAttachment({ leaseToken: 'jla_fresh_scope', verifiedAt: Date.now() });
      installGate(instance, { fetch: async () => { throw new Error('should not be called'); } });

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });
});
