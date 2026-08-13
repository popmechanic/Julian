// sync/test/do-scope.test.ts — the DO's traffic-driven re-auth, B3 §12.
//
// Two properties live here:
//
//  1. Defense in depth on scope + ownership: the DO independently closes any
//     socket whose lease is no longer socket-capable, rather than trusting the
//     router's upgrade-time check as the only guard (gate 2A review: "the DO's
//     blanket 'trust the router' is unsafe once multiple scopes share the
//     register"). The scope set and the refusal sentence both come from the
//     shared vocabulary — the DO owns no private copy.
//
//  2. The verdict matrix. Re-auth is now BY HANDLE (the attachment holds no
//     bearer to present), so the gate's answer is the only signal and each
//     answer maps to exactly one close code:
//       throw / indefinite            -> 4002 introspection unavailable
//       active:false                  -> 4001 lease revoked        (terminal)
//       active:false reason:token-expired -> 4004 re-exchange      (recoverable)
//       active, scope/ownership lost  -> 4003
//       active, everything holds      -> stays open, verifiedAt re-stamped
//
//     The 4004 arm has TWO producers, and the tests below pin both. The gate's
//     `reason:'token-expired'` is authoritative whenever it is present. When it
//     is absent — a gate whose by-handle arm does not yet emit the sub-reason —
//     an `exchange` attachment still holds its own access token's `exp`, and an
//     inactive answer arriving after that moment is an aged token rather than a
//     dead lease. No other flow infers it: only the gate may say so for them.
//
// Testing pattern matches sync/test/lease-introspect.test.ts: a real
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
//
// NOTE ON LEASE IDS: `introspectByHandle` caches definitive answers for 60s
// keyed by `handle:<lease_id>:<token_id>` (or `legacy:<sub>:<exp>`), and the
// cache is module-level. Every test below therefore uses its own lease id /
// subject, or a warm answer from a neighbouring test would decide it.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { SOCKET_REQUIRED_MSG } from 'julian-shared/scopes';
import { CONSUME_TICKET_PATH, SYNC_AUTH_HEADER } from 'julian-shared/gate-contract';
import worker from '../src/index';
import type { Env, GateFetcher } from '../src/auth';
import type { JulianSyncDO, SocketAttachment } from '../src/do';

const DEFAULT_PATH_ID = 'julian/chat';

interface RefusalReport {
  url: string;
  headers: Record<string, string>;
  body: { lease_id: string; door_name: string; service: string; verb: string; detail: string };
}

/**
 * A fake GATE binding: scripts /introspect, records the exact form each
 * introspection posted (so a test can prove the DO asked BY HANDLE and never
 * presented a bearer), and records every /refusals POST.
 */
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
        refusals.push({
          url,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ recorded: true }), { status: 200 });
      }
      introspects.push(new URLSearchParams(String(init?.body ?? '')));
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

/** A stale handle attachment — no bearer anywhere in it, by construction. */
function staleAttachment(over: Partial<SocketAttachment> = {}): SocketAttachment {
  return {
    leaseId: 'L-default', tokenId: 't-default', subject: 'lease:L-default',
    flow: 'device', verifiedAt: Date.now() - 400_000, indefiniteSweeps: 0,
    ...over,
  };
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

describe('JulianSyncDO webSocketMessage: re-auth is by handle, never by bearer', () => {
  test('a stale lease socket re-auths with lease_id + token_id — no token field at all', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-form-1', tokenId: 't-form-1' }));
      const gate = fakeGate({ active: true, lease_id: 'L-form-1', door_name: 'door:a', scope: 'stream', principal: 'julian' });
      installGate(instance, gate);

      await instance.webSocketMessage(server, 'ping');

      expect(gate.introspects).toHaveLength(1);
      expect([...gate.introspects[0].entries()].sort()).toEqual([
        ['lease_id', 'L-form-1'], ['token_id', 't-form-1'],
      ]);
      expect(gate.introspects[0].get('token')).toBeNull();
    });
  });

  test('a legacy-flow socket re-auths with sub + exp + kind=legacy', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({
        leaseId: 'legacy-window-sync', tokenId: undefined,
        subject: 'sub-legacy-1', exp: 1893456000, flow: 'legacy',
      }));
      const gate = fakeGate({
        active: true, lease_id: 'legacy-window-sync', door_name: 'legacy-window-sync',
        scope: 'stream', principal: 'julian', subject: 'sub-legacy-1', flow: 'legacy',
      });
      installGate(instance, gate);

      await instance.webSocketMessage(server, 'ping');

      expect([...gate.introspects[0].entries()].sort()).toEqual([
        ['exp', '1893456000'], ['kind', 'legacy'], ['sub', 'sub-legacy-1'],
      ]);
      expect(await waitForClose(client)).toBeNull();
    });
  });

  test('a legacy-flow socket whose sub was dropped from the map is closed 4001', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({
        leaseId: 'legacy-window-sync', tokenId: undefined,
        subject: 'sub-legacy-dropped', exp: 1893456000, flow: 'legacy',
      }));
      installGate(instance, fakeGate({ active: false }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test('a legacy-flow attachment missing its handle fields is 4002, never a false revocation', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      // No subject/exp: the DO cannot form the question, so it has no verdict
      // to report. Unanswerable is indefinite — it must not read as revoked.
      server.serializeAttachment(staleAttachment({
        leaseId: 'legacy-window-sync', tokenId: undefined, subject: undefined, exp: undefined, flow: 'legacy',
      }));
      installGate(instance, fakeGate({ active: true, scope: 'stream', principal: 'julian' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4002, reason: 'introspection unavailable' });
    });
  });
});

describe('JulianSyncDO webSocketMessage: 4001 vs 4004 — a dead lease is not an aged token', () => {
  test('active:false with no reason closes 4001 "lease revoked"', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-dead-1', tokenId: 't-dead-1' }));
      installGate(instance, fakeGate({ active: false }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test('active:false with reason:"token-expired" closes 4004 and tells the browser to re-exchange', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({
        leaseId: 'L-expired-1', tokenId: 't-expired-1', flow: 'exchange',
      }));
      installGate(instance, fakeGate({ active: false, reason: 'token-expired' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client))
        .toEqual({ code: 4004, reason: 'access token expired — re-exchange' });
    });
  });

  test('an exchange socket past its own attachment exp closes 4004 even when the answer carries no reason', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      // Exactly the live failure: a browser session whose 3600 s access token
      // aged out. The lease is alive; the token is not. A gate that answers a
      // bare `{active:false}` must not be read as "revoked" — the attachment
      // already knows the token's own expiry, and that is enough to be sure.
      server.serializeAttachment(staleAttachment({
        leaseId: 'L-agedout-1', tokenId: 't-agedout-1', flow: 'exchange',
        exp: Math.floor(Date.now() / 1000) - 60,
      }));
      installGate(instance, fakeGate({ active: false }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client))
        .toEqual({ code: 4004, reason: 'access token expired — re-exchange' });
    });
  });

  test('an exchange socket whose token is still young reads a bare active:false as the revocation it is', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({
        leaseId: 'L-young-1', tokenId: 't-young-1', flow: 'exchange',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }));
      installGate(instance, fakeGate({ active: false }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test('a device-flow socket never infers 4004 from its own exp — re-exchange is not its recovery', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({
        leaseId: 'L-devexp-1', tokenId: 't-devexp-1', flow: 'device',
        exp: Math.floor(Date.now() / 1000) - 60,
      }));
      installGate(instance, fakeGate({ active: false }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test("the gate's reason outranks the attachment's own clock, on any flow", async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({
        leaseId: 'L-reasonwins-1', tokenId: 't-reasonwins-1', flow: 'device',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }));
      installGate(instance, fakeGate({ active: false, reason: 'token-expired' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client))
        .toEqual({ code: 4004, reason: 'access token expired — re-exchange' });
    });
  });

  test('an unreachable gate closes 4002, never 4001 — a governor blip is not a revocation', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-unreach-1', tokenId: 't-unreach-1' }));
      installGate(instance, unreachableGate());

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4002, reason: 'introspection unavailable' });
    });
  });

  test('a living lease survives the interval and re-stamps verifiedAt, zeroing indefiniteSweeps', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, 'julian/chat');
      const staleAt = Date.now() - 400_000;
      server.serializeAttachment(staleAttachment({
        leaseId: 'L-alive-1', tokenId: 't-alive-1', flow: 'exchange',
        verifiedAt: staleAt, indefiniteSweeps: 2,
      }));
      installGate(instance, fakeGate({
        active: true, lease_id: 'L-alive-1', door_name: 'browser:s1', scope: 'stream', principal: 'julian',
      }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();

      const refreshed = server.deserializeAttachment() as SocketAttachment;
      expect(refreshed.leaseId).toBe('L-alive-1');
      expect(refreshed.tokenId).toBe('t-alive-1');
      expect(refreshed.flow).toBe('exchange');
      expect(refreshed.verifiedAt).toBeGreaterThan(staleAt);
      expect(refreshed.indefiniteSweeps).toBe(0);
    });
  });

  test('fresh attachment (< 5 min) skips re-introspection entirely', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      // The injected gate always rejects, so any introspection attempt would
      // be caught and close 4002; "not closed" therefore also proves no
      // re-introspection (and thus no scope re-check) was attempted.
      server.serializeAttachment(staleAttachment({ leaseId: 'L-fresh-1', verifiedAt: Date.now() }));
      installGate(instance, { fetch: async () => { throw new Error('should not be called'); } });

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });
});

describe('JulianSyncDO webSocketMessage: scope + ownership re-check on traffic-driven re-auth', () => {
  test('closes a socket whose lease scope is not socket-capable (reading-room)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-rr-1', tokenId: 't-rr-1' }));
      installGate(instance, fakeGate({ active: true, lease_id: 'L-rr-1', door_name: 'door:reader', scope: 'reading-room', principal: 'julian' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: SOCKET_REQUIRED_MSG });
    });
  });

  test('stream-read mid-socket is 4003 — it reads the stream but never holds a socket — and reports the refusal', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-sr-1', tokenId: 't-sr-1' }));
      const gate = fakeGate({ active: true, lease_id: 'L-sr-1', door_name: 'door:reader2', scope: 'stream-read', principal: 'julian' });
      installGate(instance, gate);

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: SOCKET_REQUIRED_MSG });

      expect(gate.refusals).toHaveLength(1);
      expect(new URL(gate.refusals[0].url).pathname).toBe('/refusals');
      expect(gate.refusals[0].headers['x-introspect-secret']).toBe('test-secret');
      expect(gate.refusals[0].body).toMatchObject({ lease_id: 'L-sr-1', door_name: 'door:reader2', service: 'stream', verb: 'socket' });
      expect(gate.refusals[0].body.detail.length).toBeGreaterThan(0);
    });
  });

  test('a full-house lease with the owning principal on a julian/chat-tagged socket stays OPEN across the re-auth window', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, 'julian/chat');
      server.serializeAttachment(staleAttachment({ leaseId: 'L-fh-1', tokenId: 't-fh-1' }));
      installGate(instance, fakeGate({ active: true, lease_id: 'L-fh-1', door_name: 'door:homeowner', scope: 'full-house', principal: 'julian' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });

  test('a `stream` lease — the browser session scope — also stays OPEN', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, 'julian/chat');
      server.serializeAttachment(staleAttachment({ leaseId: 'L-st-1', tokenId: 't-st-1', flow: 'exchange' }));
      installGate(instance, fakeGate({ active: true, lease_id: 'L-st-1', door_name: 'browser:s2', scope: 'stream', principal: 'julian' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toBeNull();
    });
  });

  test('a full-house lease whose principal no longer owns the store closes 4003 and reports the refusal', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, 'julian/chat');
      server.serializeAttachment(staleAttachment({ leaseId: 'L-own-1', tokenId: 't-own-1' }));
      const gate = fakeGate({ active: true, lease_id: 'L-own-1', door_name: 'door:reader4', scope: 'full-house', principal: 'guest-ada' });
      installGate(instance, gate);

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: 'lease does not own this store' });

      expect(gate.refusals).toHaveLength(1);
      expect(new URL(gate.refusals[0].url).pathname).toBe('/refusals');
      expect(gate.refusals[0].headers['x-introspect-secret']).toBe('test-secret');
      expect(gate.refusals[0].body).toMatchObject({ lease_id: 'L-own-1', door_name: 'door:reader4', service: 'stream', verb: 'socket' });
      expect(gate.refusals[0].body.detail.length).toBeGreaterThan(0);
    });
  });

  test('a socket with no path identity (single tag) closes 4003, fail-closed', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance, null);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-nopath-1', tokenId: 't-nopath-1' }));
      const gate = fakeGate({ active: true, lease_id: 'L-nopath-1', door_name: 'door:nopath', scope: 'full-house', principal: 'julian' });
      installGate(instance, gate);

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4003, reason: 'store identity unavailable' });

      expect(gate.refusals).toHaveLength(1);
      expect(gate.refusals[0].body).toMatchObject({ lease_id: 'L-nopath-1', door_name: 'door:nopath', service: 'stream', verb: 'socket' });
      expect(gate.refusals[0].body.detail.length).toBeGreaterThan(0);
    });
  });

  test('the revoked (4001) check still takes priority over the scope check', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-revscope-1', tokenId: 't-revscope-1' }));
      installGate(instance, fakeGate({ active: false }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test('an unreachable gate still closes 4002, never 4003, on a scope-only failure', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server } = acceptedSocket(instance);
      server.serializeAttachment(staleAttachment({ leaseId: 'L-unreachscope-1', tokenId: 't-unreachscope-1' }));
      installGate(instance, unreachableGate());

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4002, reason: 'introspection unavailable' });
    });
  });
});

// ---------------------------------------------------------------------------
// The seam, unfabricated.
//
// Every 4004 test above hand-writes the attachment it then judges. That is a
// fine way to pin `inactiveClose`, and a useless way to prove the fallback is
// reachable: an attachment a test builds can carry an `exp` the production
// path never delivers — which is exactly what was true of the browser's own
// flow. A ticket-opened socket is minted by the router from the gate's
// /consume-ticket answer, and if `exp` is dropped anywhere along that road the
// exchange arm of `inactiveClose` is dead code and every aged browser session
// is told, terminally, that it was revoked.
//
// So these two drive the whole road: the real router authors the handoff, the
// real DO turns it into the attachment, and only the attachment's *clock*
// (verifiedAt) is touched afterwards — never its credential.
// ---------------------------------------------------------------------------

const ctxOf = (instance: JulianSyncDO): DurableObjectState =>
  (instance as unknown as { ctx: DurableObjectState }).ctx;

/**
 * Runs the real sync router over a `?ticket=` upgrade against a fake gate whose
 * /consume-ticket answers `consumeBody`, and returns the `X-Sync-Auth` header
 * the router handed its Durable Object. Nothing about the handoff is written
 * by this test — it is read off the wire the router actually wrote.
 */
async function routerHandoffForTicket(consumeBody: unknown): Promise<string | null> {
  const forwarded: Request[] = [];
  const routerEnv = Object.assign(Object.create(null), env, {
    JULIAN_SYNC: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (req: Request) => { forwarded.push(req); return new Response(null, { status: 200 }); },
      }),
    },
    GATE: {
      fetch: async (input: string | Request) => {
        const path = new URL(typeof input === 'string' ? input : input.url).pathname;
        const body = path === CONSUME_TICKET_PATH ? consumeBody : { recorded: true };
        return new Response(JSON.stringify(body), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      },
    },
    INTROSPECT_SECRET: 'test-secret',
  }) as unknown as Env;
  const ctx = {
    waitUntil: () => {}, passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  const res = await worker.fetch(
    new Request(`https://sync.test/${DEFAULT_PATH_ID}?ticket=jst_seam`, { headers: { Upgrade: 'websocket' } }),
    routerEnv, ctx);
  expect(res.status).toBe(200);
  expect(forwarded).toHaveLength(1);
  return forwarded[0].headers.get(SYNC_AUTH_HEADER);
}

/** Opens a real socket on the DO with a handoff the router authored. */
async function openWithHandoff(
  instance: JulianSyncDO, handoff: string,
): Promise<{ client: WebSocket; server: WebSocket; attachment: SocketAttachment }> {
  const clientId = `k-${crypto.randomUUID()}`;
  const res = await instance.fetch(new Request(`https://sync.test/${DEFAULT_PATH_ID}`, {
    headers: { Upgrade: 'websocket', 'sec-websocket-key': clientId, [SYNC_AUTH_HEADER]: handoff },
  }));
  expect(res.status).toBe(101);
  const [server] = ctxOf(instance).getWebSockets(clientId);
  const client = (res as unknown as { webSocket: WebSocket }).webSocket;
  client.accept();
  return { client, server, attachment: server.deserializeAttachment() as SocketAttachment };
}

const ticketAnswer = (over: Record<string, unknown> = {}) => ({
  ok: true, lease_id: 'L-seam', token_id: 'T-seam', subject: 'sub-marcus',
  scope: 'stream', flow: 'exchange', principal: 'julian', ...over,
});

describe('router → DO: the exchange socket carries its access token’s exp all the way', () => {
  test('a ticket-opened socket past its own exp closes 4004 on the path production exercises', async () => {
    const aged = Math.floor(Date.now() / 1000) - 60;
    const handoff = await routerHandoffForTicket(
      ticketAnswer({ lease_id: 'L-seam-aged-1', token_id: 'T-seam-aged-1', exp: aged }));
    expect(handoff).not.toBeNull();

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server, attachment } = await openWithHandoff(instance, handoff as string);
      // The credential half of the attachment came from the gate through the
      // router; this is the assertion the fabricated tests could not make.
      expect(attachment.exp).toBe(aged);
      expect(attachment.flow).toBe('exchange');

      // Only the clock is moved — enough to reach the re-auth, nothing else.
      server.serializeAttachment({ ...attachment, verifiedAt: Date.now() - 400_000 });
      installGate(instance, fakeGate({ active: false }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client))
        .toEqual({ code: 4004, reason: 'access token expired — re-exchange' });
    });
  });

  test('a gate that sends no exp still opens the socket; the local fallback simply stays quiet', async () => {
    // Deploy order must never matter: sync ships before or after the gate
    // learns to send `exp`, and an absent one is not an error — it only means
    // the sweep and the gate's own `reason` remain the sole 4004 producers.
    const handoff = await routerHandoffForTicket(
      ticketAnswer({ lease_id: 'L-seam-noexp-1', token_id: 'T-seam-noexp-1' }));
    expect(JSON.parse(handoff as string)).not.toHaveProperty('exp');

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server, attachment } = await openWithHandoff(instance, handoff as string);
      expect(attachment.exp).toBeUndefined();

      server.serializeAttachment({ ...attachment, verifiedAt: Date.now() - 400_000 });
      installGate(instance, fakeGate({ active: false }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client)).toEqual({ code: 4001, reason: 'lease revoked' });
    });
  });

  test('the gate’s own reason still reaches a ticket-opened socket as 4004', async () => {
    const handoff = await routerHandoffForTicket(
      ticketAnswer({ lease_id: 'L-seam-reason-1', token_id: 'T-seam-reason-1' }));

    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { client, server, attachment } = await openWithHandoff(instance, handoff as string);
      server.serializeAttachment({ ...attachment, verifiedAt: Date.now() - 400_000 });
      installGate(instance, fakeGate({ active: false, reason: 'token-expired' }));

      await instance.webSocketMessage(server, 'ping');
      expect(await waitForClose(client))
        .toEqual({ code: 4004, reason: 'access token expired — re-exchange' });
    });
  });
});
