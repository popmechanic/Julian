// Task 15: the /mcp face's stream verbs — package + private-live-record reads
// over the SYNC binding. Driven the same way test/mcp.test.ts drives the rest
// of the face: `handleMcp` directly, a built Env, and a scripted governor —
// but here the Env also carries a scripted SYNC fetcher, injected per test,
// so a test can script the exact wire response (and record the exact wire
// request) without a real sync worker anywhere in the loop.
import { describe, expect, test } from 'vitest';
import { handleMcp, TOOLS } from '../src/mcp';
import { scopeAllows, STREAM_READ_CAP_PER_DAY, leaseCapFor } from '../src/lease-auth';
import { SYNC_READ_SECRET_HEADER } from 'julian-shared/gate-contract';
import type { InternalReadRequest, StreamRow } from 'julian-shared/gate-contract';
import type { Env } from '../src/env';
import type { GovernorDO, LeaseIdentity, LeaseReserveResult } from '../src/governor';

const SYNC_SECRET = 'test-sync-read-secret';

// --- Env, with a per-test scripted SYNC fetcher --------------------------

interface SyncCall { url: string; headers: Record<string, string>; body: InternalReadRequest }

function syncStub(
  impl: (call: SyncCall) => Response | Promise<Response>,
): { fetcher: Env['SYNC']; calls: SyncCall[] } {
  const calls: SyncCall[] = [];
  const fetcher: Env['SYNC'] = {
    async fetch(input: string | Request, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input.url;
      const headers = { ...(init?.headers as Record<string, string> | undefined ?? {}) };
      const body = JSON.parse(String(init?.body ?? '{}')) as InternalReadRequest;
      const call = { url, headers, body };
      calls.push(call);
      return impl(call);
    },
  };
  return { fetcher, calls };
}

function env(fetcher: Env['SYNC']): Env {
  return { SYNC: fetcher, SYNC_READ_SECRET: SYNC_SECRET } as unknown as Env;
}

function okReply(rows: StreamRow[], truncated = false): Response {
  return new Response(JSON.stringify({ ok: true, rows, truncated }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

// --- Governor stubs --------------------------------------------------------

type ReserveCall = [string, string, string, string, string, number | null, number | null];

/** Records every reservation and always allows — the pen, not the policy. */
function gov(calls: ReserveCall[] = []): DurableObjectStub<GovernorDO> {
  return {
    async reserveLease(...args: ReserveCall): Promise<LeaseReserveResult> {
      calls.push(args);
      return { ok: true, count: 1, cap: null };
    },
  } as unknown as DurableObjectStub<GovernorDO>;
}

/**
 * Enforces its own small per-lease cap (independent of whatever leaseCap the
 * caller passes in) so the third call in a test can refuse without needing
 * 500 real reads — the "driven clock" stands in for the real 500/day cap,
 * which is asserted directly (below) via `leaseCapFor`.
 */
function leaseCappedGov(cap: number): { stub: DurableObjectStub<GovernorDO>; calls: ReserveCall[] } {
  const used = new Map<string, number>();
  const calls: ReserveCall[] = [];
  const stub = {
    async reserveLease(...args: ReserveCall): Promise<LeaseReserveResult> {
      calls.push(args);
      const [leaseId] = args;
      const n = used.get(leaseId) ?? 0;
      if (n >= cap) return { ok: false, refusedBy: 'lease', count: n, cap };
      used.set(leaseId, n + 1);
      return { ok: true, count: n + 1, cap: null };
    },
  } as unknown as DurableObjectStub<GovernorDO>;
  return { stub, calls };
}

// --- RPC plumbing (mirrors test/mcp.test.ts) -------------------------------

function rpc(method: string, params: unknown = {}, id: number | null = 1) {
  return new Request('https://gate.test/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

async function send(
  req: Request, identity: LeaseIdentity, e: Env, g: DurableObjectStub<GovernorDO>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handleMcp(req, e, identity, g);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function result(body: Record<string, unknown>): Record<string, unknown> {
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result as Record<string, unknown>;
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callTool(
  name: string, args: Record<string, unknown>,
  identity: LeaseIdentity, e: Env, g: DurableObjectStub<GovernorDO>,
): Promise<ToolCallResult> {
  const { body } = await send(rpc('tools/call', { name, arguments: args }), identity, e, g);
  return result(body) as unknown as ToolCallResult;
}

// --- Fixtures ---------------------------------------------------------------

const STREAM_READER: LeaseIdentity = {
  leaseId: 'l-stream', doorName: 'visit:somewhere', scope: 'stream-read', principal: 'julian',
};
const READING_ROOM: LeaseIdentity = {
  leaseId: 'l-reading', doorName: 'visit:elsewhere', scope: 'reading-room', principal: 'julian',
};
const OTHER_PRINCIPAL: LeaseIdentity = {
  leaseId: 'l-other', doorName: 'visit:another-house', scope: 'stream-read', principal: 'notjulian',
};

const ROW: StreamRow = {
  id: 'm1', sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'hello there', ts: 1000, kind: 'chat',
};

describe('visibility', () => {
  test('a stream-read lease lists the three stream tools; a reading-room lease does not', async () => {
    const { fetcher } = syncStub(() => okReply([]));
    const streamList = await send(rpc('tools/list'), STREAM_READER, env(fetcher), gov());
    const streamNames = (result(streamList.body) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(streamNames).toEqual(expect.arrayContaining(['stream_recent', 'stream_session', 'stream_search']));

    const readingList = await send(rpc('tools/list'), READING_ROOM, env(fetcher), gov());
    const readingNames = (result(readingList.body) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(readingNames).not.toEqual(expect.arrayContaining(['stream_recent', 'stream_session', 'stream_search']));
  });

  test('the three tools are appended to TOOLS with service stream and the matching verb', () => {
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, `${t.service}.${t.verb}`]));
    expect(byName.stream_recent).toBe('stream.recent');
    expect(byName.stream_session).toBe('stream.session');
    expect(byName.stream_search).toBe('stream.search');
  });
});

describe('the wire request', () => {
  test('stream_recent forwards {principal, limit} with the secret header, matching InternalReadRequest exactly', async () => {
    const { fetcher, calls } = syncStub(() => okReply([ROW]));
    const r = await callTool('stream_recent', { limit: 5 }, STREAM_READER, env(fetcher), gov());
    expect(r.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].headers[SYNC_READ_SECRET_HEADER]).toBe(SYNC_SECRET);
    const expected: InternalReadRequest = { principal: 'julian', limit: 5 };
    expect(calls[0].body).toEqual(expected);
  });

  test('a seeded non-julian principal lease reads its own store path', async () => {
    const { fetcher, calls } = syncStub(() => okReply([]));
    await callTool('stream_recent', {}, OTHER_PRINCIPAL, env(fetcher), gov());
    expect(calls[0].body.principal).toBe('notjulian');
  });

  test('limit is clamped to 200 even when the caller asks for 10000', async () => {
    const { fetcher, calls } = syncStub(() => okReply([]));
    await callTool('stream_recent', { limit: 10_000 }, STREAM_READER, env(fetcher), gov());
    expect(calls[0].body.limit).toBe(200);
  });

  test('stream_session forwards sessionId and the range fields', async () => {
    const { fetcher, calls } = syncStub(() => okReply([]));
    await callTool('stream_session', { sessionId: 's1', range: { from: 10, to: 20 } }, STREAM_READER, env(fetcher), gov());
    const expected: InternalReadRequest = { principal: 'julian', sessionId: 's1', from: 10, to: 20 };
    expect(calls[0].body).toEqual(expected);
  });

  test('stream_search forwards query and limit', async () => {
    const { fetcher, calls } = syncStub(() => okReply([]));
    await callTool('stream_search', { query: 'hello', limit: 3 }, STREAM_READER, env(fetcher), gov());
    const expected: InternalReadRequest = { principal: 'julian', query: 'hello', limit: 3 };
    expect(calls[0].body).toEqual(expected);
  });
});

describe('the result', () => {
  test('rows come back in both content halves', async () => {
    const { fetcher } = syncStub(() => okReply([ROW], false));
    const r = await callTool('stream_recent', {}, STREAM_READER, env(fetcher), gov());
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('[1000] Marcus: hello there');
    expect(r.structuredContent).toEqual({ rows: [ROW], truncated: false });
  });

  test('truncated rows say so in the text half too', async () => {
    const { fetcher } = syncStub(() => okReply([ROW], true));
    const r = await callTool('stream_recent', {}, STREAM_READER, env(fetcher), gov());
    expect(r.content[0].text).toContain('truncated');
    expect(r.structuredContent).toEqual({ rows: [ROW], truncated: true });
  });

  test('a 500 from the binding is the stream-unavailable refusal, isError true, never empty rows', async () => {
    const { fetcher } = syncStub(() => new Response('nope', { status: 500 }));
    const r = await callTool('stream_recent', {}, STREAM_READER, env(fetcher), gov());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(
      'stream unavailable — the stream could not be read; this is a refusal, not an empty result',
    );
    expect(r.structuredContent).toBeUndefined();
  });

  test('a throw from the binding is the same refusal, not an exception', async () => {
    const fetcher: Env['SYNC'] = { async fetch() { throw new Error('network is down'); } };
    const r = await callTool('stream_recent', {}, STREAM_READER, env(fetcher), gov());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('stream unavailable');
  });

  test('an unparsable body from the binding is the same refusal', async () => {
    const fetcher: Env['SYNC'] = {
      async fetch() { return new Response('{not json', { status: 200 }); },
    };
    const r = await callTool('stream_recent', {}, STREAM_READER, env(fetcher), gov());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('stream unavailable');
  });
});

describe('the ledger', () => {
  test('the reservation runs before the binding call, and its detail carries the hmac\'d args, never the raw query text', async () => {
    const calls: ReserveCall[] = [];
    const { fetcher } = syncStub(() => okReply([]));
    await callTool('stream_search', { query: 'supersecretsauce' }, STREAM_READER, env(fetcher), gov(calls));
    expect(calls).toHaveLength(1);
    const [leaseId, , service, verb, detail] = calls[0];
    expect(leaseId).toBe('l-stream');
    expect(service).toBe('stream');
    expect(verb).toBe('search');
    expect(detail).toMatch(/args=[0-9a-f]{12}/);
    expect(detail).toContain('principal=julian');
    expect(detail).not.toContain('supersecretsauce');
  });

  test('one row per act: a failed binding call still reserves exactly once, nothing more', async () => {
    const calls: ReserveCall[] = [];
    const { fetcher } = syncStub(() => new Response('nope', { status: 500 }));
    await callTool('stream_recent', {}, STREAM_READER, env(fetcher), gov(calls));
    expect(calls).toHaveLength(1);
  });
});

describe('the per-lease cap', () => {
  test('leaseCapFor grants 500/day to a real (non-legacy) lease, for every stream verb', () => {
    expect(leaseCapFor(STREAM_READER, 'stream', 'recent')).toBe(STREAM_READ_CAP_PER_DAY);
    expect(leaseCapFor(STREAM_READER, 'stream', 'session')).toBe(STREAM_READ_CAP_PER_DAY);
    expect(leaseCapFor(STREAM_READER, 'stream', 'search')).toBe(STREAM_READ_CAP_PER_DAY);
  });

  test('the legacy pseudo-lease is exempt, exactly as mail.send is', () => {
    const legacy: LeaseIdentity = { leaseId: 'legacy-window', doorName: 'legacy-window', scope: 'full-house', principal: 'julian' };
    expect(leaseCapFor(legacy, 'stream', 'recent')).toBeNull();
  });

  test('the third read refuses, 429-shaped through refusalText, once the lease cap is spent', async () => {
    const { stub, calls } = leaseCappedGov(2);
    const { fetcher } = syncStub(() => okReply([]));
    const e = env(fetcher);

    const first = await callTool('stream_recent', {}, STREAM_READER, e, stub);
    const second = await callTool('stream_recent', {}, STREAM_READER, e, stub);
    const third = await callTool('stream_recent', {}, STREAM_READER, e, stub);

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(third.isError).toBe(true);
    expect(third.content[0].text).toContain('cap');

    // The real per-lease cap still flows through to the governor on every
    // call, even though this stub enforces its own smaller cap for speed.
    for (const call of calls) expect(call[6]).toBe(STREAM_READ_CAP_PER_DAY);
  });
});

describe('scope', () => {
  test('reading-room may not spend stream.recent/session/search', () => {
    expect(scopeAllows('reading-room', 'stream', 'recent')).toBe(false);
    expect(scopeAllows('reading-room', 'stream', 'session')).toBe(false);
    expect(scopeAllows('reading-room', 'stream', 'search')).toBe(false);
  });

  test('a reading-room lease calling stream_recent gets -32602 unknown tool, and nothing is reserved', async () => {
    const calls: ReserveCall[] = [];
    const { fetcher } = syncStub(() => okReply([]));
    const { body } = await send(
      rpc('tools/call', { name: 'stream_recent', arguments: {} }), READING_ROOM, env(fetcher), gov(calls),
    );
    expect((body.error as { code: number }).code).toBe(-32602);
    expect(calls).toEqual([]);
  });
});
