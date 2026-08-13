// sync/test/internal-read.test.ts — the guarded road into the store.
//
// `/internal/read/{recent|session|search}` is the broker's only way to read
// stream history. It authenticates on a secret of its own (never a lease,
// never a JWT), and that secret is the *whole* enforcement: the service
// binding is only the road, and this suite deliberately proves the guard
// standing on its own, with no structural claim behind it.
//
// Testing pattern matches router-tickets.test.ts / router-scope.test.ts:
// wrangler [vars]/[[services]] are resolved by workerd, so mutating the
// `cloudflare:test` `env` facade does not propagate through `SELF` — the
// router is invoked directly with a per-test env carrying a fake gate and a
// fake Durable Object namespace that records what was forwarded, and to which
// store name.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import worker from '../src/index';
import type { Env, GateFetcher } from '../src/auth';
import type { JulianSyncDO } from '../src/do';
import {
  INTERNAL_READ_PREFIX,
  INTROSPECT_PATH,
  SYNC_AUTH_HEADER,
  SYNC_READ_SECRET_HEADER,
  type InternalReadResponse,
} from 'julian-shared/gate-contract';

const READ_SECRET = 'test-read-secret';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface FakeGate extends GateFetcher {
  calls: string[];
}

/** A gate that records every path it is asked about — the read road must ask it nothing. */
function fakeGate(): FakeGate {
  const gate: FakeGate = {
    calls: [],
    fetch: async (input: string | Request) => {
      const path = new URL(typeof input === 'string' ? input : input.url).pathname;
      gate.calls.push(path);
      if (path === INTROSPECT_PATH) return json({ active: false });
      return json({ recorded: true });
    },
  };
  return gate;
}

/** Per-test env: fake gate, a recording DO namespace, and a configurable read secret. */
function harness(readSecret: string | undefined = READ_SECRET) {
  const gate = fakeGate();
  const names: string[] = [];
  const received: Request[] = [];
  const stub = {
    fetch: async (req: Request) => {
      received.push(req);
      return json({ ok: true, rows: [], truncated: false });
    },
  };
  const namespace = {
    idFromName: (name: string) => {
      names.push(name);
      return name;
    },
    get: (_id: string) => stub,
  };
  const testEnv = Object.assign(Object.create(null), env, {
    JULIAN_SYNC: namespace,
    GATE: gate,
    INTROSPECT_SECRET: 'test-secret',
    SYNC_READ_SECRET: readSecret,
  }) as unknown as Env;
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { testEnv, ctx, gate, names, received };
}

function readRequest(
  kind: string,
  body: unknown,
  headers: Record<string, string> = { [SYNC_READ_SECRET_HEADER]: READ_SECRET },
  method = 'POST',
): Request {
  return new Request(`https://sync.test${INTERNAL_READ_PREFIX}${kind}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(method === 'GET' || method === 'HEAD'
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

// ---------------------------------------------------------------------------
// The secret is the first statement, and the whole enforcement.
// ---------------------------------------------------------------------------

describe('router: /internal/read/* authenticates on the read secret, first', () => {
  test('a correct secret forwards to the principal store with the read path', async () => {
    const h = harness();
    const res = await worker.fetch(readRequest('recent', { principal: 'julian', limit: 5 }), h.testEnv, h.ctx);

    expect(res.status).toBe(200);
    expect(h.names).toEqual(['julian/chat']);
    expect(h.received).toHaveLength(1);
    expect(new URL(h.received[0].url).pathname).toBe('/read/recent');
    expect(h.received[0].method).toBe('POST');
    expect(await h.received[0].json()).toEqual({ principal: 'julian', limit: 5 });
    // The read road never asks the gate about anything.
    expect(h.gate.calls).toEqual([]);
  });

  test('the DO answer is passed through unchanged', async () => {
    const h = harness();
    const res = await worker.fetch(readRequest('search', { principal: 'julian', query: 'x' }), h.testEnv, h.ctx);
    expect(await res.json() as InternalReadResponse).toEqual({ ok: true, rows: [], truncated: false });
  });

  test('the internal handoff header is never inherited onto the forwarded read', async () => {
    const h = harness();
    await worker.fetch(
      readRequest('recent', { principal: 'julian' }, {
        [SYNC_READ_SECRET_HEADER]: READ_SECRET,
        [SYNC_AUTH_HEADER]: JSON.stringify({ leaseId: 'FORGED', flow: 'device' }),
      }),
      h.testEnv, h.ctx);
    expect(h.received).toHaveLength(1);
    expect(h.received[0].headers.get(SYNC_AUTH_HEADER)).toBeNull();
  });

  test('a wrong secret is a bodiless 403 and forwards nothing', async () => {
    const h = harness();
    const res = await worker.fetch(
      readRequest('recent', { principal: 'julian' }, { [SYNC_READ_SECRET_HEADER]: 'wrong-read-secret' }),
      h.testEnv, h.ctx);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe('');
    expect(h.received).toEqual([]);
    expect(h.names).toEqual([]);
    expect(h.gate.calls).toEqual([]);
  });

  test('a missing secret header is a bodiless 403', async () => {
    const h = harness();
    const res = await worker.fetch(readRequest('recent', { principal: 'julian' }, {}), h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('');
    expect(h.received).toEqual([]);
  });

  test('a secret of the right length but wrong bytes is refused (no prefix shortcut)', async () => {
    const h = harness();
    const nearMiss = `${READ_SECRET.slice(0, -1)}X`;
    expect(nearMiss).toHaveLength(READ_SECRET.length);
    const res = await worker.fetch(
      readRequest('recent', { principal: 'julian' }, { [SYNC_READ_SECRET_HEADER]: nearMiss }),
      h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    expect(h.received).toEqual([]);
  });

  test('an unset SYNC_READ_SECRET refuses everyone, including an empty header', async () => {
    for (const secret of [undefined, '']) {
      const h = harness(secret);
      const res = await worker.fetch(
        readRequest('recent', { principal: 'julian' }, { [SYNC_READ_SECRET_HEADER]: '' }),
        h.testEnv, h.ctx);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('');
      expect(h.received).toEqual([]);
    }
  });

  test('the secret check runs before method and body are looked at', async () => {
    // A bad secret on a request that is ALSO wrong-method and malformed-body
    // still answers 403 — not 405, not 400. That ordering is the property:
    // an unauthenticated caller learns nothing about the shape of the road.
    const h = harness();
    const res = await worker.fetch(
      new Request(`https://sync.test${INTERNAL_READ_PREFIX}recent`, {
        method: 'GET', headers: { [SYNC_READ_SECRET_HEADER]: 'nope' },
      }),
      h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('');
    expect(h.received).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The prefix is matched ahead of parsePath — which would 404 it, pre-auth.
// ---------------------------------------------------------------------------

describe('router: /internal/* is reached ahead of parsePath', () => {
  test('a secretless probe is 403, never 404 — the guard, not the parser, answers', async () => {
    const h = harness();
    const res = await worker.fetch(
      new Request(`https://sync.test${INTERNAL_READ_PREFIX}recent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }),
      h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(404);
    expect(h.received).toEqual([]);
  });

  test('a lease bearer buys nothing here: still 403, and the gate is never asked', async () => {
    const h = harness();
    const res = await worker.fetch(
      new Request(`https://sync.test${INTERNAL_READ_PREFIX}recent`, {
        method: 'POST',
        headers: { Authorization: 'Bearer jla_internal1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ principal: 'julian' }),
      }),
      h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    expect(h.gate.calls).toEqual([]);
    expect(h.received).toEqual([]);
  });

  test('every path under /internal/ is guarded, not only the read verbs', async () => {
    const h = harness();
    for (const path of ['/internal', '/internal/', '/internal/anything', '/internal/read', '/internal/read/']) {
      const res = await worker.fetch(
        new Request(`https://sync.test${path}`, { method: 'POST', body: '{}' }), h.testEnv, h.ctx);
      expect(res.status, path).toBe(403);
      expect(await res.text(), path).toBe('');
    }
    expect(h.received).toEqual([]);
  });

  test('an authenticated caller still cannot reach a store path through /internal/', async () => {
    // `/internal/` is reserved and storePathFor refuses the `internal`
    // principal (shared/schema.ts), so no store can collide with this prefix.
    const h = harness();
    const res = await worker.fetch(
      new Request('https://sync.test/internal/chat', {
        method: 'POST', headers: { [SYNC_READ_SECRET_HEADER]: READ_SECRET }, body: '{}',
      }),
      h.testEnv, h.ctx);
    expect(res.status).toBe(404);
    expect(h.received).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Addressing: storePathFor is the only way a principal becomes a store.
// ---------------------------------------------------------------------------

describe('router: the principal addresses the store, or nothing does', () => {
  test.each([
    ['internal', 'the reserved internal principal'],
    ['Not-Valid', 'an out-of-charset principal'],
    ['', 'an empty principal'],
    ['julian/chat', 'a principal smuggling a path separator'],
    ['../julian', 'a principal smuggling traversal'],
  ])('principal %j (%s) is refused 403 and forwards nothing', async (principal) => {
    const h = harness();
    const res = await worker.fetch(readRequest('recent', { principal }), h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    expect(h.received).toEqual([]);
    expect(h.names).toEqual([]);
  });

  test('a missing principal field is refused 403', async () => {
    const h = harness();
    const res = await worker.fetch(readRequest('recent', { limit: 3 }), h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    expect(h.received).toEqual([]);
  });

  test('a principal refusal says what died and what to do', async () => {
    const h = harness();
    const res = await worker.fetch(readRequest('recent', { principal: 'internal' }), h.testEnv, h.ctx);
    expect(await res.text()).toBe(
      'no store is addressable for principal `internal` — name a principal that owns a stream',
    );
  });
});

// ---------------------------------------------------------------------------
// Shape of the road itself, once the secret has been accepted.
// ---------------------------------------------------------------------------

describe('router: read-road shape', () => {
  test.each(['recent', 'session', 'search'])('%s is a read verb', async (kind) => {
    const h = harness();
    const res = await worker.fetch(readRequest(kind, { principal: 'julian' }), h.testEnv, h.ctx);
    expect(res.status).toBe(200);
    expect(new URL(h.received[0].url).pathname).toBe(`/read/${kind}`);
  });

  test('an unknown read verb is 404 and forwards nothing', async () => {
    const h = harness();
    const res = await worker.fetch(readRequest('everything', { principal: 'julian' }), h.testEnv, h.ctx);
    expect(res.status).toBe(404);
    expect(h.received).toEqual([]);
  });

  test('a non-POST read is 405 and forwards nothing', async () => {
    const h = harness();
    const res = await worker.fetch(
      new Request(`https://sync.test${INTERNAL_READ_PREFIX}recent`, {
        method: 'GET', headers: { [SYNC_READ_SECRET_HEADER]: READ_SECRET },
      }),
      h.testEnv, h.ctx);
    expect(res.status).toBe(405);
    expect(h.received).toEqual([]);
  });

  test('a malformed body is 400 and forwards nothing', async () => {
    const h = harness();
    const res = await worker.fetch(readRequest('recent', 'not json at all'), h.testEnv, h.ctx);
    expect(res.status).toBe(400);
    expect(h.received).toEqual([]);
  });

  test('a JSON body that is not an object is 403 (no principal to address)', async () => {
    const h = harness();
    const res = await worker.fetch(readRequest('recent', ['julian']), h.testEnv, h.ctx);
    expect(res.status).toBe(403);
    expect(h.received).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The DO end of the road: /read/{kind} over the live store.
// ---------------------------------------------------------------------------

function doStub() {
  return env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(`test/read-${crypto.randomUUID().slice(0, 8)}`));
}

interface Seeded {
  sessionId: string; role: string; speakerName: string; text: string; ts: number; kind?: string;
}

function seed(instance: JulianSyncDO, id: string, row: Seeded): void {
  instance.store.setRow('messages', id, {
    sessionId: row.sessionId, role: row.role, speakerName: row.speakerName,
    text: row.text, ts: row.ts, kind: row.kind ?? 'chat',
  });
}

function doRead(instance: JulianSyncDO, kind: string, body: unknown): Promise<Response> {
  return instance.fetch(new Request(`https://do/read/${kind}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

describe('DO: /read/{recent|session|search} over the store', () => {
  test('search returns matching rows newest-first, in the wire shape', async () => {
    await runInDurableObject(doStub(), async (instance: JulianSyncDO) => {
      seed(instance, 'm1', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'the aurora', ts: 10 });
      seed(instance, 'm2', { sessionId: 's1', role: 'assistant', speakerName: 'Julian', text: 'no match here', ts: 20 });
      seed(instance, 'm3', { sessionId: 's2', role: 'user', speakerName: 'Marcus', text: 'AURORA again', ts: 30 });

      const res = await doRead(instance, 'search', { principal: 'julian', query: 'aurora' });
      expect(res.status).toBe(200);
      const body = await res.json() as InternalReadResponse;
      expect(body).toEqual({
        ok: true,
        truncated: false,
        rows: [
          { id: 'm3', sessionId: 's2', role: 'user', speakerName: 'Marcus', text: 'AURORA again', ts: 30, kind: 'chat' },
          { id: 'm1', sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'the aurora', ts: 10, kind: 'chat' },
        ],
      });
    });
  });

  test('recent honors the limit and returns ascending', async () => {
    await runInDurableObject(doStub(), async (instance: JulianSyncDO) => {
      for (let i = 0; i < 6; i++) {
        seed(instance, `m${i}`, { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: `msg${i}`, ts: i });
      }
      const body = await (await doRead(instance, 'recent', { principal: 'julian', limit: 2 })).json() as InternalReadResponse;
      expect(body.ok).toBe(true);
      expect(body.ok && body.rows.map((r) => r.text)).toEqual(['msg4', 'msg5']);
      expect(body.ok && body.truncated).toBe(false);
    });
  });

  test('session filters by sessionId and by the from/to range', async () => {
    await runInDurableObject(doStub(), async (instance: JulianSyncDO) => {
      seed(instance, 'a1', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'early', ts: 10 });
      seed(instance, 'a2', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'middle', ts: 20 });
      seed(instance, 'a3', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'late', ts: 30 });
      seed(instance, 'b1', { sessionId: 's2', role: 'user', speakerName: 'Marcus', text: 'other', ts: 20 });

      const body = await (await doRead(instance, 'session', {
        principal: 'julian', sessionId: 's1', from: 15, to: 25,
      })).json() as InternalReadResponse;
      expect(body).toEqual({
        ok: true,
        truncated: false,
        rows: [
          { id: 'a2', sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'middle', ts: 20, kind: 'chat' },
        ],
      });
    });
  });

  test('an empty store reads as an empty, untruncated result — never an error', async () => {
    await runInDurableObject(doStub(), async (instance: JulianSyncDO) => {
      const body = await (await doRead(instance, 'recent', { principal: 'julian' })).json() as InternalReadResponse;
      expect(body).toEqual({ ok: true, rows: [], truncated: false });
    });
  });

  test('an unknown read verb at the DO is 404', async () => {
    await runInDurableObject(doStub(), async (instance: JulianSyncDO) => {
      const res = await doRead(instance, 'everything', { principal: 'julian' });
      expect(res.status).toBe(404);
    });
  });

  test('a GET on a read path is 405 (the road is POST-only end to end)', async () => {
    await runInDurableObject(doStub(), async (instance: JulianSyncDO) => {
      const res = await instance.fetch(new Request('https://do/read/recent'));
      expect(res.status).toBe(405);
    });
  });
});
