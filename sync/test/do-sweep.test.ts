// sync/test/do-sweep.test.ts — the DO's alarm sweep, B3 §12 (SEC NEW-5, OPS
// N-7, COLD M-10). The traffic-driven re-auth in do-scope.test.ts only fires
// when a socket sends a message; the sweep is the wall-clock backstop that
// bounds a silent receiver at the same interval, cache bypassed, whether or
// not it ever speaks.
//
// Testing pattern matches do-scope.test.ts: a real WebSocketPair accepted
// through the DO's own ctx.acceptWebSocket, a fake GateFetcher injected as
// the GATE service binding, and `alarm()` driven directly rather than via a
// real Durable Object alarm invocation.
//
// NOTE ON LEASE IDS: introspectByHandle caches definitive answers for 60s,
// module-level, keyed by handle. Every test below uses its own lease id (or
// deliberately reuses one, to prove the sweep bypasses that very cache).
import { describe, expect, test, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';
import { SOCKET_REQUIRED_MSG } from 'julian-shared/scopes';
import type { Env, GateFetcher } from '../src/auth';
import type { JulianSyncDO, SocketAttachment } from '../src/do';

const DEFAULT_PATH_ID = 'julian/chat';

// Traffic that drives the DO's message-path re-auth. It must be a WELL-FORMED
// sync-protocol frame: since tinybase 9.3.0 the DO's payload decoder closes
// the socket (1007, tinybase:14) on any malformed payload, so a free-text
// stand-in would close the socket for a reason unrelated to the re-auth
// verdict under test. This is an empty-toClientId (broadcast) GetContentHashes
// request — [requestId, message=1, body=''] — the smallest frame the
// validator accepts.
const TRAFFIC = '\n' + JSON.stringify([null, 1, '']);
const SWEEP_INTERVAL_MS = 300_000;

interface RefusalReport {
  body: { lease_id: string; door_name: string; service: string; verb: string; detail: string };
}

function fakeGate(introspectionBody: unknown): GateFetcher & {
  refusals: RefusalReport[];
  introspects: URLSearchParams[];
} {
  const refusals: RefusalReport[] = [];
  const introspects: URLSearchParams[] = [];
  return {
    refusals,
    introspects,
    fetch: async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (new URL(url).pathname === '/refusals') {
        refusals.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ recorded: true }), { status: 200 });
      }
      introspects.push(new URLSearchParams(String(init?.body ?? '')));
      return new Response(JSON.stringify(introspectionBody), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

function unreachableGate(): GateFetcher {
  return { fetch: async () => { throw new Error('connect timeout'); } };
}

function installGate(instance: JulianSyncDO, gate: GateFetcher): void {
  const e = (instance as unknown as { env: Env }).env;
  e.GATE = gate;
  e.INTROSPECT_SECRET = 'test-secret';
}

function stub() {
  return env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(`test/do-sweep-${crypto.randomUUID().slice(0, 8)}`));
}

function staleAttachment(over: Partial<SocketAttachment> = {}): SocketAttachment {
  return {
    leaseId: 'L-default', tokenId: 't-default', subject: 'lease:L-default',
    flow: 'device', verifiedAt: Date.now() - 400_000, indefiniteSweeps: 0,
    ...over,
  };
}

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

function ctxOf(instance: JulianSyncDO): DurableObjectState {
  return (instance as unknown as { ctx: DurableObjectState }).ctx;
}

describe('JulianSyncDO alarm(): a revoked silent socket is closed even though it never sent traffic', () => {
  test('a dead lease with no messages sent is closed 4001 at the sweep', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-dead-1', tokenId: 't-sweep-dead-1' }));
      installGate(instance, fakeGate({ active: false }));

      // No webSocketMessage call at all — the socket has been silent since
      // it attached. Only the sweep can catch this.
      await instance.alarm();

      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test('a revoked lease whose answer carries reason:token-expired closes 4004 at the sweep too', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-expired-1', tokenId: 't-sweep-expired-1', flow: 'exchange' }));
      installGate(instance, fakeGate({ active: false, reason: 'token-expired' }));

      await instance.alarm();

      expect(await waitForClose(client)).toEqual({ code: 4004, reason: 'access token expired — re-exchange' });
    });
  });
});

describe('JulianSyncDO alarm(): indefinite tolerance — 3 consecutive strikes, not 1', () => {
  test('one indefinite sweep leaves the socket attached with indefiniteSweeps === 1', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-indef-1', tokenId: 't-sweep-indef-1' }));
      installGate(instance, unreachableGate());

      await instance.alarm();

      expect(await waitForClose(client)).toBeNull();
      const refreshed = server.deserializeAttachment() as SocketAttachment;
      expect(refreshed.indefiniteSweeps).toBe(1);
    });
  });

  test('the third consecutive indefinite sweep closes 4002 with the sweep-specific message', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({
        leaseId: 'L-sweep-indef-2', tokenId: 't-sweep-indef-2', indefiniteSweeps: 2,
      }));
      installGate(instance, unreachableGate());

      await instance.alarm();

      expect(await waitForClose(client)).toEqual({
        code: 4002, reason: 'introspection unavailable across 3 sweeps',
      });
    });
  });

  test('a healthy sweep resets the strike counter back to 0', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, 'julian/chat');
      server.serializeAttachment(staleAttachment({
        leaseId: 'L-sweep-reset-1', tokenId: 't-sweep-reset-1', flow: 'exchange', indefiniteSweeps: 2,
      }));
      installGate(instance, fakeGate({
        active: true, lease_id: 'L-sweep-reset-1', door_name: 'browser:sweep1', scope: 'stream', principal: 'julian',
      }));

      await instance.alarm();

      expect(await waitForClose(client)).toBeNull();
      const refreshed = server.deserializeAttachment() as SocketAttachment;
      expect(refreshed.indefiniteSweeps).toBe(0);
      expect(refreshed.verifiedAt).toBeGreaterThan(0);
    });
  });
});

describe('JulianSyncDO alarm(): dedupe — one introspection per distinct (leaseId, tokenId) per sweep', () => {
  test('two sockets sharing one lease/token produce exactly one introspection call', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { server: s1 } = acceptedSocket(instance, 'julian/chat');
      const { server: s2 } = acceptedSocket(instance, 'julian/chat');
      s1.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-dedupe-1', tokenId: 't-sweep-dedupe-1' }));
      s2.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-dedupe-1', tokenId: 't-sweep-dedupe-1' }));
      const gate = fakeGate({
        active: true, lease_id: 'L-sweep-dedupe-1', door_name: 'door:dedupe', scope: 'full-house', principal: 'julian',
      });
      installGate(instance, gate);

      await instance.alarm();

      expect(gate.introspects).toHaveLength(1);
      expect((s1.deserializeAttachment() as SocketAttachment).indefiniteSweeps).toBe(0);
      expect((s2.deserializeAttachment() as SocketAttachment).indefiniteSweeps).toBe(0);
    });
  });

  test('a distinct lease/token pair earns its own introspection call', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { server: s1 } = acceptedSocket(instance, 'julian/chat');
      const { server: s2 } = acceptedSocket(instance, 'julian/chat');
      s1.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-distinct-a', tokenId: 't-a' }));
      s2.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-distinct-b', tokenId: 't-b' }));
      const gate = fakeGate({
        active: true, lease_id: 'L-sweep-distinct-a', door_name: 'door:distinct', scope: 'full-house', principal: 'julian',
      });
      installGate(instance, gate);

      await instance.alarm();

      expect(gate.introspects).toHaveLength(2);
    });
  });
});

describe('JulianSyncDO alarm(): the sweep bypasses the 60s introspection cache', () => {
  test('a stale-warm cached "active" answer does not shield a lease that has since died', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const leaseId = 'L-sweep-bypass-1';
      const tokenId = 't-sweep-bypass-1';

      // Warm the module-level cache with a definitive "alive" answer via
      // the ordinary (cached) message-driven path.
      const { server: warmer } = acceptedSocket(instance, 'julian/chat');
      warmer.serializeAttachment(staleAttachment({ leaseId, tokenId, flow: 'exchange' }));
      installGate(instance, fakeGate({
        active: true, lease_id: leaseId, door_name: 'browser:warm', scope: 'stream', principal: 'julian',
      }));
      await instance.webSocketMessage(warmer, TRAFFIC);

      // Now the lease has died, but the cache (if honored) would still say
      // "alive" for another ~60s. A fresh socket on the same handle attaches
      // and the sweep runs — it must ask again rather than trust the cache.
      const { client, server } = acceptedSocket(instance, 'julian/chat');
      server.serializeAttachment(staleAttachment({ leaseId, tokenId, flow: 'exchange' }));
      installGate(instance, fakeGate({ active: false }));

      await instance.alarm();

      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });
});

describe('JulianSyncDO alarm(): scope + ownership re-check, same as the message-driven path', () => {
  test('a socket whose lease is no longer socket-capable is closed 4003 by the sweep', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, 'julian/chat');
      server.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-scope-1', tokenId: 't-sweep-scope-1' }));
      const gate = fakeGate({
        active: true, lease_id: 'L-sweep-scope-1', door_name: 'door:sweepscope', scope: 'reading-room', principal: 'julian',
      });
      installGate(instance, gate);

      await instance.alarm();

      expect(await waitForClose(client)).toEqual({ code: 4003, reason: SOCKET_REQUIRED_MSG });
      expect(gate.refusals).toHaveLength(1);
      expect(gate.refusals[0].body).toMatchObject({ lease_id: 'L-sweep-scope-1', door_name: 'door:sweepscope', service: 'stream', verb: 'socket' });
    });
  });

  test('a full-house lease that still owns the store survives the sweep', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, 'julian/chat');
      server.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-ok-1', tokenId: 't-sweep-ok-1' }));
      installGate(instance, fakeGate({
        active: true, lease_id: 'L-sweep-ok-1', door_name: 'door:sweepok', scope: 'full-house', principal: 'julian',
      }));

      await instance.alarm();

      expect(await waitForClose(client)).toBeNull();
    });
  });
});

describe('JulianSyncDO alarm(): pathId is snapshotted once, before any close', () => {
  test('getPathId is called exactly once even when the sweep closes multiple sockets', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { server: s1 } = acceptedSocket(instance, 'julian/chat');
      const { server: s2 } = acceptedSocket(instance, 'julian/chat');
      s1.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-order-a', tokenId: 't-order-a' }));
      s2.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-order-b', tokenId: 't-order-b' }));
      // Both close 4001 — closing sockets mid-sweep is exactly the scenario
      // that could empty/reorder ctx.getWebSockets() and make a second
      // getPathId() call read a different (or absent) survivor.
      installGate(instance, fakeGate({ active: false }));

      const spy = vi.spyOn(WsServerDurableObject.prototype, 'getPathId');
      try {
        await instance.alarm();
      } finally {
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
      }
    });
  });
});

describe('JulianSyncDO webSocketClose: TinyBase bookkeeping runs first, then the alarm lifecycle', () => {
  test('webSocketClose calls the base implementation (TinyBase client bookkeeping)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { server } = acceptedSocket(instance);
      const spy = vi.spyOn(WsServerDurableObject.prototype, 'webSocketClose');
      try {
        await instance.webSocketClose(server, 1000, 'done', true);
        expect(spy).toHaveBeenCalledWith(server, 1000, 'done', true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  test('deletes the alarm once the last socket closes', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { server } = acceptedSocket(instance);
      await ctxOf(instance).storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);

      await instance.webSocketClose(server, 1000, 'done', true);

      expect(await ctxOf(instance).storage.getAlarm()).toBeNull();
    });
  });

  test('leaves the alarm armed while other sockets remain attached', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { server: s1 } = acceptedSocket(instance);
      acceptedSocket(instance); // a second, still-attached socket
      const armedAt = Date.now() + SWEEP_INTERVAL_MS;
      await ctxOf(instance).storage.setAlarm(armedAt);

      await instance.webSocketClose(s1, 1000, 'done', true);

      expect(await ctxOf(instance).storage.getAlarm()).toBe(armedAt);
    });
  });
});

describe('JulianSyncDO alarm(): re-arms while sockets remain, stays silent once none do', () => {
  test('a healthy sweep with a surviving socket re-arms the alarm ~SWEEP_INTERVAL_MS out', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      acceptedSocket(instance, 'julian/chat');
      const { server } = acceptedSocket(instance, 'julian/chat');
      server.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-rearm-1', tokenId: 't-sweep-rearm-1' }));
      installGate(instance, fakeGate({
        active: true, lease_id: 'L-sweep-rearm-1', door_name: 'door:rearm', scope: 'full-house', principal: 'julian',
      }));
      const setAlarmSpy = vi.spyOn(ctxOf(instance).storage, 'setAlarm');

      const before = Date.now();
      await instance.alarm();
      const after = Date.now();

      expect(setAlarmSpy).toHaveBeenCalled();
      const armedAt = setAlarmSpy.mock.calls.at(-1)?.[0] as number;
      expect(armedAt).toBeGreaterThanOrEqual(before + SWEEP_INTERVAL_MS);
      expect(armedAt).toBeLessThanOrEqual(after + SWEEP_INTERVAL_MS);
    });
  });

  // A `ws.close(...)` call does not synchronously drop the socket from
  // `ctx.getWebSockets()` — the runtime processes the close handshake and
  // only then fires `webSocketClose` (below). So alarm() closing the sole
  // remaining socket still sees it counted in the very same tick and, per
  // its stated lifecycle ("re-arms while sockets remain"), re-arms; it is
  // `webSocketClose` — the OTHER half of the stated lifecycle ("cancelled
  // at last close") — that is responsible for tearing the alarm back down
  // once the runtime finishes closing it. This test proves the two halves
  // compose to the right end state instead of racing to a stuck alarm.
  test('a sweep that closes the last socket leaves cleanup to webSocketClose, not to itself', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-sweep-norearm-1', tokenId: 't-sweep-norearm-1' }));
      installGate(instance, fakeGate({ active: false }));

      await instance.alarm();
      // The runtime's own close handshake eventually invokes this, exactly
      // as it would for a client-initiated close — simulate that follow-up
      // directly rather than depending on hibernation-API close timing.
      await instance.webSocketClose(server, 4001, 'lease revoked', true);

      expect(await ctxOf(instance).storage.getAlarm()).toBeNull();
    });
  });
});

describe('JulianSyncDO fetch(): arms the sweep on first successful attach, idempotently', () => {
  test('a successful upgrade arms the alarm when none was pending', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { SYNC_AUTH_HEADER } = await import('julian-shared/gate-contract');
      const clientId = `k-${crypto.randomUUID()}`;
      const before = Date.now();
      const res = await instance.fetch(new Request('https://sync.test/julian/chat', {
        headers: {
          Upgrade: 'websocket', 'sec-websocket-key': clientId,
          [SYNC_AUTH_HEADER]: JSON.stringify({
            leaseId: 'L-fetch-arm-1', tokenId: 't-fetch-arm-1', flow: 'device', scope: 'full-house', principal: 'julian',
          }),
        },
      }));
      expect(res.status).toBe(101);

      const armedAt = await ctxOf(instance).storage.getAlarm();
      expect(armedAt).not.toBeNull();
      expect(armedAt as number).toBeGreaterThanOrEqual(before + SWEEP_INTERVAL_MS - 1000);
    });
  });

  test('a second attach never pushes an already-pending alarm further out', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { SYNC_AUTH_HEADER } = await import('julian-shared/gate-contract');
      const payload = JSON.stringify({
        leaseId: 'L-fetch-arm-2', tokenId: 't-fetch-arm-2', flow: 'device', scope: 'full-house', principal: 'julian',
      });
      await instance.fetch(new Request('https://sync.test/julian/chat', {
        headers: { Upgrade: 'websocket', 'sec-websocket-key': `k-${crypto.randomUUID()}`, [SYNC_AUTH_HEADER]: payload },
      }));
      const firstArm = await ctxOf(instance).storage.getAlarm();

      await instance.fetch(new Request('https://sync.test/julian/chat', {
        headers: { Upgrade: 'websocket', 'sec-websocket-key': `k-${crypto.randomUUID()}`, [SYNC_AUTH_HEADER]: payload },
      }));
      const secondArm = await ctxOf(instance).storage.getAlarm();

      expect(secondArm).toBe(firstArm);
    });
  });
});
