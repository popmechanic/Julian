// sync/test/router-tickets.test.ts — B3 §12: the sync router has exactly one
// authority (the gate), exactly one slot for a socket ticket (`?ticket=`), and
// exactly one internal handoff header (`X-Sync-Auth`) that it always writes
// itself and never inherits.
//
// Testing pattern (matches router-scope.test.ts / lease-introspect.test.ts):
// wrangler [vars]/[[services]] are resolved by workerd, so mutating the
// `cloudflare:test` `env` facade does not propagate through `SELF` — every
// gate-dependent path is proven by invoking the worker's default handler
// directly with a per-test env carrying a fake `GATE` fetcher and a fake
// Durable Object namespace that records what the router forwarded.
import { describe, expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import worker, { stripInternalHandoff } from '../src/index';
import { consumeTicket, introspectByHandle } from '../src/auth';
import type { Env, GateFetcher } from '../src/auth';
import {
  ALLOWED_PATH,
  CONSUME_TICKET_PATH,
  INTROSPECT_PATH,
  REFUSALS_PATH,
  SYNC_AUTH_HEADER,
  SYNC_READ_SECRET_HEADER,
} from 'julian-shared/gate-contract';
import { SOCKET_REQUIRED_MSG } from 'julian-shared/scopes';

const SOCKET_URL = 'https://sync.test/julian/chat';
const EXPORT_URL = 'https://sync.test/julian/chat/export';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Answer = (form: URLSearchParams) => Response;

interface FakeGate extends GateFetcher {
  introspects: URLSearchParams[];
  consumes: URLSearchParams[];
  refusals: Record<string, string>[];
  allowed: Record<string, string>[];
}

/**
 * A fake GATE service binding. Every gate path the router touches is recorded
 * separately so a test can assert *which* pen was written and how many times
 * the single-use consume actually reached the gate.
 */
function fakeGate(handlers: { introspect?: Answer; consume?: Answer } = {}): FakeGate {
  const gate: FakeGate = {
    introspects: [],
    consumes: [],
    refusals: [],
    allowed: [],
    fetch: async (input: string | Request, init?: RequestInit) => {
      const path = new URL(typeof input === 'string' ? input : input.url).pathname;
      const raw = String(init?.body ?? '');
      if (path === REFUSALS_PATH) {
        gate.refusals.push(JSON.parse(raw));
        return json({ recorded: true });
      }
      if (path === ALLOWED_PATH) {
        gate.allowed.push(JSON.parse(raw));
        return json({ recorded: true });
      }
      const form = new URLSearchParams(raw);
      if (path === CONSUME_TICKET_PATH) {
        gate.consumes.push(form);
        return (handlers.consume ?? (() => json({ ok: false, error: 'unknown' })))(form);
      }
      if (path === INTROSPECT_PATH) {
        gate.introspects.push(form);
        return (handlers.introspect ?? (() => json({ active: false })))(form);
      }
      return new Response(`fake gate: unexpected path ${path}`, { status: 500 });
    },
  };
  return gate;
}

/** Per-test env: the fake gate, a recording DO stub, and a waitUntil collector. */
function harness(gate: GateFetcher) {
  const received: Request[] = [];
  const pending: Promise<unknown>[] = [];
  const stub = {
    fetch: async (req: Request) => {
      received.push(req);
      return new Response(null, { status: 200 });
    },
  };
  const namespace = { idFromName: (name: string) => name, get: (_id: string) => stub };
  const testEnv = Object.assign(Object.create(null), env, {
    JULIAN_SYNC: namespace,
    GATE: gate,
    INTROSPECT_SECRET: 'test-secret',
  }) as unknown as Env;
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { testEnv, ctx, received, settle: () => Promise.all(pending) };
}

function upgrade(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { Upgrade: 'websocket', ...headers } });
}

const activeLease = (over: Record<string, unknown> = {}) => () =>
  json({
    active: true,
    lease_id: 'L-active',
    door_name: 'door:a',
    scope: 'full-house',
    principal: 'julian',
    subject: 'julian',
    flow: 'device',
    token_id: 'T-active',
    ...over,
  });

const consumedTicket = (over: Record<string, unknown> = {}) => () =>
  json({
    ok: true,
    lease_id: 'L-ticket',
    token_id: 'T-ticket',
    subject: 'sub-marcus',
    scope: 'stream',
    flow: 'exchange',
    principal: 'julian',
    ...over,
  });

// ---------------------------------------------------------------------------
// The §12 slot matrix — one test per cell. A prefix is only ever honored in
// the one slot that belongs to it; every other pairing is a typed 401.
// ---------------------------------------------------------------------------

describe('§12 slot matrix: one prefix, one slot', () => {
  test('cell 1 — jla_ in Authorization on a socket path is admitted per scope', async () => {
    const gate = fakeGate({ introspect: activeLease({ lease_id: 'M1' }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(SOCKET_URL, { Authorization: 'Bearer jla_cell1' }), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    expect(h.received).toHaveLength(1);
    expect(gate.introspects).toHaveLength(1);
    expect(gate.introspects[0].get('token')).toBe('jla_cell1');
  });

  test('cell 2 — jla_ in ?token= is refused before the gate is asked', async () => {
    const gate = fakeGate({ introspect: activeLease() });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?token=jla_cell2`), h.testEnv, h.ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('lease tokens ride in headers only');
    expect(gate.introspects).toHaveLength(0);
    expect(h.received).toHaveLength(0);
  });

  test('cell 3 — jla_ in ?ticket= is refused (a lease is not a ticket)', async () => {
    const gate = fakeGate({ consume: consumedTicket() });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jla_cell3`), h.testEnv, h.ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('lease tokens ride in headers only');
    expect(gate.consumes).toHaveLength(0);
    expect(h.received).toHaveLength(0);
  });

  test('cell 4 — jst_ in ?ticket= on a socket upgrade is consumed and admitted', async () => {
    const gate = fakeGate({ consume: consumedTicket() });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_cell4`), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    expect(gate.consumes).toHaveLength(1);
    expect(gate.consumes[0].get('ticket')).toBe('jst_cell4');
    expect(h.received).toHaveLength(1);
  });

  test('cell 5 — jst_ in ?token= is refused', async () => {
    const gate = fakeGate({ introspect: activeLease() });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?token=jst_cell5`), h.testEnv, h.ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('a socket ticket rides in ?ticket= only');
    expect(gate.introspects).toHaveLength(0);
    expect(gate.consumes).toHaveLength(0);
  });

  test('cell 6 — jst_ in Authorization is refused (no header→URL downgrade)', async () => {
    const gate = fakeGate({ introspect: activeLease() });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(SOCKET_URL, { Authorization: 'Bearer jst_cell6' }), h.testEnv, h.ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('a socket ticket rides in ?ticket= only');
    expect(gate.introspects).toHaveLength(0);
    expect(gate.consumes).toHaveLength(0);
  });

  test('cell 7 — jst_ in ?ticket= on /export is refused; a ticket opens a socket only', async () => {
    const gate = fakeGate({ consume: consumedTicket() });
    const h = harness(gate);
    const res = await worker.fetch(new Request(`${EXPORT_URL}?ticket=jst_cell7`), h.testEnv, h.ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('a ticket opens a socket, nothing else');
    expect(gate.consumes).toHaveLength(0);
    expect(h.received).toHaveLength(0);
  });

  test('cell 8 — a JWT in Authorization goes to the gate JWT arm', async () => {
    const gate = fakeGate({
      introspect: activeLease({
        lease_id: 'legacy-window-sync', door_name: 'legacy-window-sync',
        scope: 'stream', flow: 'legacy', subject: 'user_marcus', token_id: undefined, exp: 1893456000,
      }),
    });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(SOCKET_URL, { Authorization: 'Bearer eyJhbGciOi.cell8.sig' }), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    expect(gate.introspects).toHaveLength(1);
    expect(gate.introspects[0].get('token')).toBe('eyJhbGciOi.cell8.sig');
    expect(h.received).toHaveLength(1);
  });

  test('cell 9 — a JWT in ?token= goes to the same gate JWT arm', async () => {
    const gate = fakeGate({
      introspect: activeLease({
        lease_id: 'legacy-window-sync', door_name: 'legacy-window-sync',
        scope: 'stream', flow: 'legacy', subject: 'user_marcus', token_id: undefined,
      }),
    });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?token=eyJhbGciOi.cell9.sig`), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    expect(gate.introspects).toHaveLength(1);
    expect(gate.introspects[0].get('token')).toBe('eyJhbGciOi.cell9.sig');
  });

  test('no credential at all is Unauthorized — a cookie is never a credential here', async () => {
    const gate = fakeGate({ introspect: activeLease() });
    const h = harness(gate);
    const res = await worker.fetch(
      upgrade(SOCKET_URL, { Cookie: 'session=pocket-id-cookie' }), h.testEnv, h.ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Unauthorized');
    expect(gate.introspects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The ticket handoff itself.
// ---------------------------------------------------------------------------

describe('router: the ticket handoff', () => {
  test('single-use survives the router: the same ticket twice in one isolate 401s the second time', async () => {
    let spent = false;
    const gate = fakeGate({
      consume: () => {
        if (spent) return json({ ok: false, error: 'reused' });
        spent = true;
        return json({
          ok: true, lease_id: 'L-single', token_id: 'T-single', subject: 'sub-marcus',
          scope: 'stream', flow: 'exchange', principal: 'julian',
        });
      },
    });
    const h = harness(gate);

    const first = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_single`), h.testEnv, h.ctx);
    expect(first.status).toBe(200);

    const second = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_single`), h.testEnv, h.ctx);
    expect(second.status).toBe(401);
    expect(await second.text()).toBe('ticket already used — mint another; this reuse is on the ledger');

    // Two round trips: no cache may ever sit in front of a single-use consume.
    expect(gate.consumes).toHaveLength(2);
    expect(h.received).toHaveLength(1);
  });

  test('an expired ticket refuses with its own copy', async () => {
    const gate = fakeGate({ consume: () => json({ ok: false, error: 'expired' }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_expired`), h.testEnv, h.ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('ticket expired — mint another');
  });

  test('an unknown ticket refuses with its own copy', async () => {
    const gate = fakeGate({ consume: () => json({ ok: false, error: 'unknown' }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_unknown`), h.testEnv, h.ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('not a living ticket');
  });

  test('a non-jst_ value in ?ticket= is refused without a gate call', async () => {
    const gate = fakeGate({ consume: consumedTicket() });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=eyJhbGciOi.notaticket.sig`), h.testEnv, h.ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('?ticket= carries a socket ticket (jst_…) only — mint one and retry');
    expect(gate.consumes).toHaveLength(0);
  });

  test('a ticket on a non-Upgrade request is 426 and is never spent', async () => {
    const gate = fakeGate({ consume: consumedTicket() });
    const h = harness(gate);
    const res = await worker.fetch(new Request(`${SOCKET_URL}?ticket=jst_noupgrade`), h.testEnv, h.ctx);
    expect(res.status).toBe(426);
    expect(gate.consumes).toHaveLength(0);
  });

  test('the gate falling over during consume is indefinite — 503, never 401', async () => {
    const gate = fakeGate({ consume: () => new Response('gate down', { status: 503 }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_gatedown`), h.testEnv, h.ctx);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('introspection unavailable');
    expect(h.received).toHaveLength(0);
  });

  test('a ticket whose scope cannot hold a socket is refused and ledgered', async () => {
    const gate = fakeGate({ consume: consumedTicket({ scope: 'reading-room', lease_id: 'L-rr' }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_readingroom`), h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(SOCKET_REQUIRED_MSG);
    await h.settle();
    expect(gate.refusals).toHaveLength(1);
    expect(gate.refusals[0]).toMatchObject({ lease_id: 'L-rr', service: 'stream', verb: 'socket' });
    expect(gate.allowed).toHaveLength(0);
  });

  test("a ticket whose principal does not own the store is refused and ledgered", async () => {
    const gate = fakeGate({ consume: consumedTicket({ principal: 'guest-ada', lease_id: 'L-foreign' }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_foreign`), h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('this lease does not own this store');
    await h.settle();
    expect(gate.refusals).toHaveLength(1);
    expect(gate.refusals[0]).toMatchObject({ lease_id: 'L-foreign', service: 'stream', verb: 'socket' });
  });

  test("the `stream` scope holds a socket (the exchange lease's whole point)", async () => {
    const gate = fakeGate({ consume: consumedTicket({ scope: 'stream' }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_streamscope`), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    expect(h.received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The internal handoff header: written by the router, never inherited.
// ---------------------------------------------------------------------------

describe('router: X-Sync-Auth is minted, never inherited', () => {
  // The load-bearing test of the strip itself. It has to be a forwarding path
  // where the router does NOT author a payload of its own, because on a path
  // that authors one, `Headers.set` would replace a forged value anyway and
  // the assertion could not tell "stripped" from "overwritten". /export is
  // that path, and the witness header proves the assertion is not vacuous:
  // the caller's headers demonstrably reach the DO, and X-Sync-Auth alone
  // does not. Delete the strip and the delete inside the DO door, and this
  // test goes red.
  test('a forged X-Sync-Auth is deleted on a path that authors no payload', async () => {
    const gate = fakeGate({
      introspect: activeLease({ lease_id: 'L-strip', scope: 'stream-read' }),
    });
    const h = harness(gate);
    const res = await worker.fetch(
      new Request(EXPORT_URL, {
        headers: {
          Authorization: 'Bearer jla_strip',
          'X-Witness': 'headers-do-reach-the-do',
          [SYNC_AUTH_HEADER]: '{"leaseId":"forged","principal":"julian","scope":"full-house"}',
        },
      }),
      h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    expect(h.received).toHaveLength(1);
    // Non-vacuity witness: this header made the trip, so the null below is a
    // statement about X-Sync-Auth and not about an empty request.
    expect(h.received[0].headers.get('X-Witness')).toBe('headers-do-reach-the-do');
    expect(h.received[0].headers.get(SYNC_AUTH_HEADER)).toBeNull();
  });

  test('stripInternalHandoff removes the handoff header and nothing else', async () => {
    const stripped = stripInternalHandoff(new Request('https://sync.test/julian/chat', {
      method: 'POST',
      headers: {
        [SYNC_AUTH_HEADER]: '{"leaseId":"forged"}',
        Authorization: 'Bearer jla_keepme',
        'X-Witness': 'kept',
      },
      body: 'hello',
    }));
    expect(stripped.headers.get(SYNC_AUTH_HEADER)).toBeNull();
    expect(stripped.headers.get('Authorization')).toBe('Bearer jla_keepme');
    expect(stripped.headers.get('X-Witness')).toBe('kept');
    expect(stripped.method).toBe('POST');
    expect(stripped.url).toBe('https://sync.test/julian/chat');
    expect(await stripped.text()).toBe('hello');
  });

  // This one proves *authorship*, not stripping: on a socket open the router
  // always writes the payload, so it would pass with or without the strip.
  // Named for what it actually shows.
  test('the payload the DO receives on a socket open is the router’s, not the caller’s', async () => {
    const gate = fakeGate({
      introspect: activeLease({ lease_id: 'L-forge', token_id: 'T-forge', subject: 'julian', exp: 1893456000 }),
    });
    const h = harness(gate);
    const forged = JSON.stringify({
      leaseId: 'forged', subject: 'attacker', scope: 'full-house', flow: 'exchange', principal: 'julian',
    });
    const res = await worker.fetch(
      upgrade(SOCKET_URL, { Authorization: 'Bearer jla_forge1', [SYNC_AUTH_HEADER]: forged }),
      h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    const seen = h.received[0].headers.get(SYNC_AUTH_HEADER);
    expect(seen).not.toBe(forged);
    expect(JSON.parse(seen as string)).toEqual({
      leaseId: 'L-forge', tokenId: 'T-forge', subject: 'julian',
      scope: 'full-house', flow: 'device', principal: 'julian', exp: 1893456000,
    });
  });

  test('a ticket-opened socket carries the consumed ticket’s identity', async () => {
    const gate = fakeGate({ consume: consumedTicket({ lease_id: 'L-hand', token_id: 'T-hand' }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_handoff`), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(h.received[0].headers.get(SYNC_AUTH_HEADER) as string)).toEqual({
      leaseId: 'L-hand', tokenId: 'T-hand', subject: 'sub-marcus',
      scope: 'stream', flow: 'exchange', principal: 'julian',
    });
  });

  // The 4004 fallback in the DO reads `exp` off the attachment — the expiry of
  // the very access token that minted the ticket. The router is the only thing
  // that can put it there, and a browser whose token quietly ages out is the
  // whole reason 4004 exists: without this the DO's exchange arm never fires
  // and every aged session is told, terminally, that it was revoked.
  test('an exchange ticket’s exp reaches the DO — the 4004 fallback has a seam to stand on', async () => {
    const exp = 1893456000;
    const gate = fakeGate({ consume: consumedTicket({ lease_id: 'L-texp', token_id: 'T-texp', exp }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_withexp`), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(h.received[0].headers.get(SYNC_AUTH_HEADER) as string)).toEqual({
      leaseId: 'L-texp', tokenId: 'T-texp', subject: 'sub-marcus',
      scope: 'stream', flow: 'exchange', principal: 'julian', exp,
    });
  });

  // Tolerance, so deploy order never matters: a gate that has not yet learned
  // to send `exp` still opens sockets, and the handoff simply omits the key
  // rather than carrying a null the DO would have to defend against.
  test('a consume answer without exp omits the key entirely', async () => {
    const gate = fakeGate({ consume: consumedTicket({ lease_id: 'L-noexp', token_id: 'T-noexp' }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(`${SOCKET_URL}?ticket=jst_noexp`), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(h.received[0].headers.get(SYNC_AUTH_HEADER) as string))
      .not.toHaveProperty('exp');
  });

  test('the upgrade headers survive the rebuild', async () => {
    const gate = fakeGate({ consume: consumedTicket() });
    const h = harness(gate);
    await worker.fetch(
      new Request(`${SOCKET_URL}?ticket=jst_headers`, {
        headers: {
          Upgrade: 'websocket', Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
        },
      }),
      h.testEnv, h.ctx);
    const fwd = h.received[0];
    expect(fwd.headers.get('Upgrade')).toBe('websocket');
    expect(fwd.headers.get('Sec-WebSocket-Key')).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(fwd.headers.get('Sec-WebSocket-Version')).toBe('13');
  });
});

// ---------------------------------------------------------------------------
// The positive pen.
// ---------------------------------------------------------------------------

describe('router: the allowed pen', () => {
  test('a healthy lease open writes one allowed row naming the token', async () => {
    const gate = fakeGate({ introspect: activeLease({ lease_id: 'L-pen', door_name: 'door:pen', token_id: 'T-pen' }) });
    const h = harness(gate);
    const res = await worker.fetch(upgrade(SOCKET_URL, { Authorization: 'Bearer jla_pen1' }), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    await h.settle();
    expect(gate.allowed).toEqual([{
      lease_id: 'L-pen', door_name: 'door:pen', service: 'stream', verb: 'socket',
      detail: 'open token_id=T-pen',
    }]);
    expect(gate.refusals).toHaveLength(0);
  });

  test('a JWT-arm open names the absent token id honestly', async () => {
    const gate = fakeGate({
      introspect: activeLease({
        lease_id: 'legacy-window-sync', door_name: 'legacy-window-sync',
        scope: 'stream', flow: 'legacy', token_id: undefined,
      }),
    });
    const h = harness(gate);
    await worker.fetch(upgrade(SOCKET_URL, { Authorization: 'Bearer eyJhbGciOi.pen2.sig' }), h.testEnv, h.ctx);
    await h.settle();
    expect(gate.allowed).toEqual([{
      lease_id: 'legacy-window-sync', door_name: 'legacy-window-sync', service: 'stream',
      verb: 'socket', detail: 'open token_id=jwt',
    }]);
  });

  test('the export path spends no positive pen (only an open does)', async () => {
    const gate = fakeGate({ introspect: activeLease({ lease_id: 'L-pen3', scope: 'stream-read' }) });
    const h = harness(gate);
    const res = await worker.fetch(
      new Request(EXPORT_URL, { headers: { Authorization: 'Bearer jla_pen3' } }), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    await h.settle();
    expect(gate.allowed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reserved paths.
// ---------------------------------------------------------------------------

describe('router: /internal/* is reserved', () => {
  // The prefix is now the read road's, and it answers on its own secret
  // (403, bodiless) rather than on the parser's 404. What this test still
  // owns is the §12 property: a lease bearer buys nothing under /internal/,
  // and the gate is never even asked. The full read-road contract —
  // secret-first ordering, storePathFor addressing, the DO verbs — lives in
  // internal-read.test.ts.
  //
  // BOTH tests deliberately name a TWO-segment path. `/internal/read/recent`
  // is three segments and `parsePath` rejects it on its own, so a test driven
  // at that shape passes with the reservation deleted and proves nothing.
  // `/internal/read` is a path `parsePath` would happily accept as the store
  // `internal`, context `read` — so only the reservation stands between a
  // bearer and the store router, and deleting it turns both answers below
  // into something else.
  test('a two-segment internal path refuses ahead of any authentication', async () => {
    const gate = fakeGate({ introspect: activeLease() });
    const h = harness(gate);
    const res = await worker.fetch(
      new Request('https://sync.test/internal/read', {
        method: 'POST', headers: { Authorization: 'Bearer jla_internal1' }, body: '{}',
      }),
      h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    // Load-bearing: without the reservation this request reaches the bearer
    // classification and the gate IS asked.
    expect(gate.introspects).toHaveLength(0);
    expect(h.received).toHaveLength(0);
  });

  test('past the read secret, a two-segment internal path is a 404, never a store', async () => {
    const gate = fakeGate({ introspect: activeLease() });
    const h = harness(gate);
    const secretEnv = Object.assign(Object.create(null), h.testEnv, {
      SYNC_READ_SECRET: 'test-read-secret',
    }) as Env;
    const res = await worker.fetch(
      new Request('https://sync.test/internal/read', {
        method: 'POST',
        headers: { [SYNC_READ_SECRET_HEADER]: 'test-read-secret' },
        body: '{"principal":"julian"}',
      }),
      secretEnv, h.ctx);
    expect(res.status).toBe(404);
    expect(gate.introspects).toHaveLength(0);
    expect(h.received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The auth-module contracts the DO and the read routes build on.
// ---------------------------------------------------------------------------

describe('auth: consumeTicket is a dedicated, uncached call', () => {
  test('posts /consume-ticket with the shared secret and returns the verdict', async () => {
    const gate = fakeGate({
      consume: () => json({
        ok: true, lease_id: 'L-cu', token_id: 'T-cu', subject: 's', scope: 'stream',
        flow: 'exchange', principal: 'julian',
      }),
    });
    const calls: RequestInit[] = [];
    const recording: GateFetcher = {
      fetch: async (input, init) => { calls.push(init ?? {}); return gate.fetch(input, init); },
    };
    expect(await consumeTicket('jst_unit1', recording, 'test-secret')).toEqual({
      ok: true, leaseId: 'L-cu', tokenId: 'T-cu', subject: 's', scope: 'stream',
      flow: 'exchange', principal: 'julian',
    });
    expect(new Headers(calls[0].headers).get('X-Introspect-Secret')).toBe('test-secret');
    expect(calls[0].method).toBe('POST');
    expect(String(calls[0].body)).toBe('ticket=jst_unit1');
  });

  test('two consumes of the same ticket both reach the gate — no cache in front of single-use', async () => {
    const gate = fakeGate({ consume: () => json({ ok: true, lease_id: 'L-cu2', scope: 'stream', principal: 'julian' }) });
    await consumeTicket('jst_unit2', gate, 'test-secret');
    await consumeTicket('jst_unit2', gate, 'test-secret');
    expect(gate.consumes).toHaveLength(2);
  });

  test('a non-200 is indefinite and throws — it never reads as {ok:false}', async () => {
    const gate = fakeGate({ consume: () => new Response('nope', { status: 500 }) });
    await expect(consumeTicket('jst_unit3', gate, 'test-secret'))
      .rejects.toThrow('consume-ticket: gate responded 500');
  });

  test('a network failure propagates', async () => {
    const gate: GateFetcher = { fetch: async () => { throw new Error('connect timeout'); } };
    await expect(consumeTicket('jst_unit4', gate, 'test-secret')).rejects.toThrow('connect timeout');
  });

  test('a definitive {ok:false} carries the error class through', async () => {
    const gate = fakeGate({ consume: () => json({ ok: false, error: 'reused' }) });
    expect(await consumeTicket('jst_unit5', gate, 'test-secret')).toEqual({ ok: false, error: 'reused' });
  });

  test('an active answer carries exp through the wire→domain mapping', async () => {
    const gate = fakeGate({
      consume: () => json({
        ok: true, lease_id: 'L-cuexp', token_id: 'T-cuexp', subject: 's', scope: 'stream',
        flow: 'exchange', principal: 'julian', exp: 1893456000,
      }),
    });
    expect(await consumeTicket('jst_unitexp', gate, 'test-secret')).toEqual({
      ok: true, leaseId: 'L-cuexp', tokenId: 'T-cuexp', subject: 's', scope: 'stream',
      flow: 'exchange', principal: 'julian', exp: 1893456000,
    });
  });
});

describe('auth: introspectByHandle', () => {
  test('by lease/token handle: one gate call, then 60s of cache', async () => {
    const gate = fakeGate({
      introspect: () => json({
        active: true, lease_id: 'H1', door_name: 'door:h', scope: 'stream',
        principal: 'julian', subject: 's1', flow: 'exchange', token_id: 'HT1', exp: 1893456000,
      }),
    });
    const first = await introspectByHandle({ lease_id: 'H1', token_id: 'HT1' }, gate, 'test-secret');
    expect(first).toEqual({
      active: true, leaseId: 'H1', doorName: 'door:h', scope: 'stream', principal: 'julian',
      subject: 's1', flow: 'exchange', tokenId: 'HT1', exp: 1893456000,
    });
    expect(await introspectByHandle({ lease_id: 'H1', token_id: 'HT1' }, gate, 'test-secret')).toEqual(first);
    expect(gate.introspects).toHaveLength(1);
    expect(gate.introspects[0].get('lease_id')).toBe('H1');
    expect(gate.introspects[0].get('token_id')).toBe('HT1');
  });

  test('bypassCache forces a fresh call (the sweep never trusts a warm answer)', async () => {
    const gate = fakeGate({ introspect: () => json({ active: true, lease_id: 'H2', scope: 'stream', principal: 'julian' }) });
    await introspectByHandle({ lease_id: 'H2', token_id: 'HT2' }, gate, 'test-secret');
    await introspectByHandle({ lease_id: 'H2', token_id: 'HT2' }, gate, 'test-secret', { bypassCache: true });
    expect(gate.introspects).toHaveLength(2);
  });

  test('legacy by-handle keys on sub+exp, not on lease/token', async () => {
    const gate = fakeGate({ introspect: () => json({ active: true, lease_id: 'legacy-window-sync', door_name: 'legacy-window-sync', scope: 'stream', principal: 'julian', subject: 'user_marcus', flow: 'legacy' }) });
    await introspectByHandle({ sub: 'user_marcus', exp: '1893456000', kind: 'legacy' }, gate, 'test-secret');
    await introspectByHandle({ sub: 'user_marcus', exp: '1893456000', kind: 'legacy' }, gate, 'test-secret');
    expect(gate.introspects).toHaveLength(1);
    // A different exp is a different handle, so it must not hit that cache entry.
    await introspectByHandle({ sub: 'user_marcus', exp: '1893456001', kind: 'legacy' }, gate, 'test-secret');
    expect(gate.introspects).toHaveLength(2);
  });

  test('a definitive active:false is cached; a non-200 throws and is not', async () => {
    const denying = fakeGate({ introspect: () => json({ active: false }) });
    expect(await introspectByHandle({ lease_id: 'H3', token_id: 'HT3' }, denying, 'test-secret')).toEqual({ active: false });
    await introspectByHandle({ lease_id: 'H3', token_id: 'HT3' }, denying, 'test-secret');
    expect(denying.introspects).toHaveLength(1);

    const down = fakeGate({ introspect: () => new Response('down', { status: 503 }) });
    await expect(introspectByHandle({ lease_id: 'H4', token_id: 'HT4' }, down, 'test-secret'))
      .rejects.toThrow('introspect: gate responded 503');
    const recovered = fakeGate({ introspect: () => json({ active: true, lease_id: 'H4', scope: 'stream', principal: 'julian' }) });
    expect((await introspectByHandle({ lease_id: 'H4', token_id: 'HT4' }, recovered, 'test-secret')).active).toBe(true);
    expect(recovered.introspects).toHaveLength(1);
  });
});
