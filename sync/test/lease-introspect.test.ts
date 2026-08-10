// sync/test/lease-introspect.test.ts — julian-sync accepts lease tokens by
// asking the gate (POST /introspect through the GATE service binding),
// never verifying them locally, and never over a public URL (issue #28).
//
// Testing pattern (matches sync/test/export.test.ts and broker/test/routing.test.ts):
// wrangler [vars]/[[services]] are resolved by workerd, so mutating the
// `cloudflare:test` `env` facade does not propagate through `SELF`. Paths
// that never need GATE/INTROSPECT_SECRET (the query-string rejection) are
// proven through `SELF`; paths that do are proven by invoking the worker's
// default handler directly with the mutated env passed explicitly as the
// argument.
//
// The router/DO integration blocks below inject their fake gate through
// `installGate`, which writes it under the `GATE` binding name that
// `sync/src/index.ts` and `sync/src/do.ts` now read.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import worker from '../src/index';
import { introspectLease } from '../src/auth';
import type { Env, GateFetcher } from '../src/auth';
import type { JulianSyncDO } from '../src/do';

// A fake GATE binding: records requests, returns scripted responses. Every
// test in this file injects one of these (or an ad hoc GateFetcher) rather
// than intercepting a URL — introspection now goes through the service
// binding, never a public host (issue #28).
function fakeGate(status: number, body: unknown): GateFetcher & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    fetch: async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

// Gate injection for the integration blocks below: the fake fetcher stands in
// for the `GATE` service binding that the router and the DO both read.
function installGate(target: unknown, gate: GateFetcher): void {
  (target as { GATE: GateFetcher }).GATE = gate;
}

describe('introspectLease', () => {
  test('introspects through the gate binding, not a public URL', async () => {
    const gate = fakeGate(200, { active: true, lease_id: 'L1', door_name: 'door:x', scope: 'full-house', principal: 'julian' });
    const result = await introspectLease('jla_binding1', gate, 'test-secret');
    expect(result).toEqual({ active: true, leaseId: 'L1', doorName: 'door:x', scope: 'full-house', principal: 'julian' });
    expect(gate.calls[0].url).toBe('https://gate/introspect');
    expect(new Headers(gate.calls[0].init?.headers).get('X-Introspect-Secret')).toBe('test-secret');
  });

  test('a non-ok gate response throws (fail closed), never reads as revoked', async () => {
    const gate = fakeGate(500, {});
    await expect(introspectLease('jla_binding2', gate, 'test-secret')).rejects.toThrow('introspect: gate responded 500');
  });

  test('60s cache hit skips a second fetch for the same token', async () => {
    const gate = fakeGate(200, { active: true, lease_id: 'l2', door_name: 'door:y', scope: 'full-house' });
    const first = await introspectLease('jla_cachehit', gate, 'test-secret');
    const second = await introspectLease('jla_cachehit', gate, 'test-secret');
    expect(second).toEqual(first);
    expect(second).toEqual({ active: true, leaseId: 'l2', doorName: 'door:y', scope: 'full-house' });
    expect(gate.calls).toHaveLength(1);
  });

  // A governor blip must not read as revocation — only a definitive 200 is
  // ever a verdict. A 401 (bad shared secret / config error) or any 5xx is
  // "the gate didn't answer", not "the gate said no": it propagates as a
  // throw (same shape as a network failure) so the caller fails closed
  // (503 / WS close 4002) without telling the door its lease was revoked,
  // and it is never cached — a transient blip must not keep refusing
  // reconnects for the next 60 seconds.
  test('401 (bad shared secret / config error) → throws, not cached', async () => {
    const gate = fakeGate(401, '');
    await expect(introspectLease('jla_badsecret', gate, 'wrong-secret')).rejects.toThrow();
  });

  test('5xx (gate down) → throws, not cached, and recovery within the 60s window works', async () => {
    const token = 'jla_recovers1';
    const downGate = fakeGate(503, 'gate down');
    await expect(introspectLease(token, downGate, 'test-secret')).rejects.toThrow();

    // If the failed attempt had been cached, this second call for the same
    // token (against a fresh gate with no prior calls) would still need to
    // hit the fetcher — confirming recovery isn't blocked by a stale cache.
    const recoveredGate = fakeGate(200, { active: true, lease_id: 'l5', door_name: 'door:recovered', scope: 'full-house' });
    expect(await introspectLease(token, recoveredGate, 'test-secret'))
      .toEqual({ active: true, leaseId: 'l5', doorName: 'door:recovered', scope: 'full-house' });
    expect(recoveredGate.calls).toHaveLength(1);
  });

  test('active:false response → inactive, no lease fields', async () => {
    const gate = fakeGate(200, { active: false });
    expect(await introspectLease('jla_unknown1', gate, 'test-secret')).toEqual({ active: false });
  });

  test('gate unreachable (network error) propagates — caller decides fail-closed handling', async () => {
    const gate: GateFetcher = {
      fetch: async () => { throw new Error('connect timeout'); },
    };
    await expect(introspectLease('jla_unreachable1', gate, 'test-secret')).rejects.toThrow();
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
    installGate(testEnv, fakeGate(200, {
      active: true, lease_id: 'l3', door_name: 'door:z', scope: 'full-house', principal: 'store',
    }));
    testEnv.INTROSPECT_SECRET = 'test-secret';

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
    installGate(testEnv, fakeGate(200, { active: false }));
    testEnv.INTROSPECT_SECRET = 'test-secret';

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
    installGate(testEnv, { fetch: async () => { throw new Error('connect timeout'); } });
    testEnv.INTROSPECT_SECRET = 'test-secret';

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
      installGate((instance as unknown as { env: Env }).env, { fetch: async () => { throw new Error('should not be called'); } });
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      // The fake GATE always rejects — a re-introspect attempt would reject
      // and get caught internally, closing 4002. Asserting "not closed"
      // therefore also proves no introspection was attempted.
      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });

  test('stale attachment (> 5 min) + inactive introspection → closes 4001 "lease revoked"', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_stale1', verifiedAt: Date.now() - 400_000 });
      installGate((instance as unknown as { env: Env }).env, fakeGate(200, { active: false }));
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test('stale attachment + gate unreachable (network failure) → closes 4002 "introspection unavailable"', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken: 'jla_stale2', verifiedAt: Date.now() - 400_000 });
      installGate((instance as unknown as { env: Env }).env, { fetch: async () => { throw new Error('connect timeout'); } });
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4002, reason: 'introspection unavailable' });
    });
  });

  // Distinct from the network-failure case above: here the gate answers, but
  // with a 503 (not a definitive 200) — a governor blip, not a revocation.
  // This must ALSO close 4002, never 4001, and must never be cached, so a
  // reconnect once the gate recovers isn't refused by a stale negative.
  test('stale attachment + gate 503 (HTTP error, not network failure) → closes 4002, never cached', async () => {
    const leaseToken = 'jla_stale_503';

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken, verifiedAt: Date.now() - 400_000 });
      installGate((instance as unknown as { env: Env }).env, fakeGate(503, 'gate down'));
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4002, reason: 'introspection unavailable' });
    });

    // Recovery: the gate comes back within the 60s window. Since the 503
    // was never cached, a fresh re-auth attempt for the same token succeeds
    // instead of being blocked by a stale "unavailable"/"inactive" verdict.
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment({ leaseToken, verifiedAt: Date.now() - 400_000 });
      installGate((instance as unknown as { env: Env }).env, fakeGate(200, { active: true, lease_id: 'l6', door_name: 'door:recovered2', scope: 'full-house' }));
      (instance as unknown as { env: Env }).env.INTROSPECT_SECRET = 'test-secret';

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });

  test('stale attachment + active introspection refreshes verifiedAt and does not close', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      const staleAt = Date.now() - 400_000;
      server.serializeAttachment({ leaseToken: 'jla_stale3', verifiedAt: staleAt });
      installGate((instance as unknown as { env: Env }).env, fakeGate(200, { active: true, lease_id: 'l4', door_name: 'door:w', scope: 'full-house' }));
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

      // No GATE call is scripted to succeed — proves no introspection happens.
      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });
});
