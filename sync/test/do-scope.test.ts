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
//
// Sockets are tagged production-shaped: WsServerDurableObject tags an
// accepted socket [clientId, pathId] at fetch()-time (getPathId() reads
// tags[1]); the DO's ownership re-check reads that pathId's first segment
// as the owning principal. A socket with no second tag has no path
// identity — the ownership re-check must fail closed rather than let an
// absent owner accidentally equal an absent principal.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env, GateFetcher } from '../src/auth';
import type { JulianSyncDO } from '../src/do';

const DEFAULT_PATH_ID = 'julian/chat';

interface RefusalReport {
  url: string;
  headers: Record<string, string>;
  body: { lease_id: string; door_name: string; service: string; verb: string; detail: string };
}

/** A fake GATE binding: scripts /introspect and records every /refusals POST. */
function fakeGate(introspectionBody: unknown): GateFetcher & { refusals: RefusalReport[] } {
  const refusals: RefusalReport[] = [];
  return {
    refusals,
    fetch: async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (new URL(url).pathname === '/refusals') {
        refusals.push({
          url,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ recorded: true }), { status: 200 });
      }
      return new Response(JSON.stringify(introspectionBody), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    },
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

// pathId `null` accepts a socket with only the clientId tag — no path
// identity, matching a socket that predates production tagging or a bug
// upstream of this DO.
function acceptedSocket(instance: JulianSyncDO, pathId: string | null = DEFAULT_PATH_ID): { client: WebSocket; server: WebSocket } {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  const tags = pathId === null ? [`t-${crypto.randomUUID()}`] : [`t-${crypto.randomUUID()}`, pathId];
  (instance as unknown as { ctx: DurableObjectState }).ctx.acceptWebSocket(server, tags);
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
      installGate(instance, fakeGate({ active: true, lease_id: 'l1', door_name: 'door:reader', scope: 'reading-room', principal: 'julian' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: 'a sync socket requires full-house' });
    });
  });

  test('closes a socket whose lease is no longer full-house — stream-read mid-socket is 4003, and reports the refusal', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_streamread1', verifiedAt: Date.now() - 400_000 });
      const gate = fakeGate({ active: true, lease_id: 'l2', door_name: 'door:reader2', scope: 'stream-read', principal: 'julian' });
      installGate(instance, gate);

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: 'a sync socket requires full-house' });

      expect(gate.refusals).toHaveLength(1);
      expect(new URL(gate.refusals[0].url).pathname).toBe('/refusals');
      expect(gate.refusals[0].headers['x-introspect-secret']).toBe('test-secret');
      expect(gate.refusals[0].body).toMatchObject({ lease_id: 'l2', door_name: 'door:reader2', service: 'stream', verb: 'socket' });
      expect(gate.refusals[0].body.detail.length).toBeGreaterThan(0);
    });
  });

  test('a full-house lease with the owning principal on a julian/chat-tagged socket stays OPEN across the re-auth window', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, 'julian/chat');
      server.serializeAttachment({ leaseToken: 'jla_fullhouse1', verifiedAt: Date.now() - 400_000 });
      installGate(instance, fakeGate({ active: true, lease_id: 'l3', door_name: 'door:homeowner', scope: 'full-house', principal: 'julian' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });

  test('a full-house lease whose principal no longer owns the store closes 4003 and reports the refusal', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, 'julian/chat');
      server.serializeAttachment({ leaseToken: 'jla_ownerdrop1', verifiedAt: Date.now() - 400_000 });
      const gate = fakeGate({ active: true, lease_id: 'l4', door_name: 'door:reader4', scope: 'full-house', principal: 'guest-ada' });
      installGate(instance, gate);

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: 'lease does not own this store' });

      expect(gate.refusals).toHaveLength(1);
      expect(new URL(gate.refusals[0].url).pathname).toBe('/refusals');
      expect(gate.refusals[0].headers['x-introspect-secret']).toBe('test-secret');
      expect(gate.refusals[0].body).toMatchObject({ lease_id: 'l4', door_name: 'door:reader4', service: 'stream', verb: 'socket' });
      expect(gate.refusals[0].body.detail.length).toBeGreaterThan(0);
    });
  });

  test('a socket with no path identity (single tag) closes 4003, fail-closed', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, null);
      server.serializeAttachment({ leaseToken: 'jla_nopathid1', verifiedAt: Date.now() - 400_000 });
      const gate = fakeGate({ active: true, lease_id: 'l5', door_name: 'door:nopath', scope: 'full-house', principal: 'julian' });
      installGate(instance, gate);

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: 'store identity unavailable' });

      expect(gate.refusals).toHaveLength(1);
      expect(gate.refusals[0].body).toMatchObject({ lease_id: 'l5', door_name: 'door:nopath', service: 'stream', verb: 'socket' });
      expect(gate.refusals[0].body.detail.length).toBeGreaterThan(0);
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
