// The /mcp face, driven directly. `handleMcp` is deliberately independent of
// the router (the router only authenticates and forwards), so these tests hand
// it a built Env, a scripted governor, and one JSON-RPC message at a time —
// the same seam test/package.test.ts uses for the package service.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import { PROTOCOL_VERSION, TOOLS, WAKE_JULIAN_TEXT, handleMcp } from '../src/mcp';
import { scopeAllows } from '../src/lease-auth';
import type { Env } from '../src/env';
import type { GovernorDO, LeaseIdentity } from '../src/governor';

const RAW = 'https://raw.test';
const PIN = 'a'.repeat(40);

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

function kvStub(entries: Record<string, string> = {}): KVNamespace {
  const map = new Map(Object.entries(entries));
  return {
    async get(key: string) { return map.get(key) ?? null; },
    async put(key: string, value: string) { map.set(key, value); },
  } as unknown as KVNamespace;
}

function env(pin: string | null = PIN): Env {
  return {
    PACKAGE_RAW_BASE: RAW,
    PIN: kvStub(pin ? { 'pin-sha': pin } : {}),
  } as unknown as Env;
}

type ReserveCall = unknown[];

/** What the read policy asked the governor to remember, in order. */
interface PackageState { seats: unknown[][]; latches: unknown[][]; clears: unknown[][] }
function packageState(): PackageState {
  return { seats: [], latches: [], clears: [] };
}

/** Records every reservation and always allows — the pen, not the policy. */
function gov(
  calls: ReserveCall[] = [], state: PackageState = packageState(),
): DurableObjectStub<GovernorDO> {
  return {
    async reserveLease(...args: unknown[]) {
      calls.push(args);
      return { ok: true, count: 1, cap: null };
    },
    async seatSitting(...args: unknown[]) { state.seats.push(args); },
    async setLatch(...args: unknown[]) { state.latches.push(args); },
    async clearLatch(...args: unknown[]) { state.clears.push(args); },
  } as unknown as DurableObjectStub<GovernorDO>;
}

/** Refuses every reservation with a cap — the 429 branch of `reserve`. */
function cappedGov(): DurableObjectStub<GovernorDO> {
  return {
    async reserveLease() {
      return { ok: false, refusedBy: 'global', count: 21, cap: 20 };
    },
  } as unknown as DurableObjectStub<GovernorDO>;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const AGENT_TEXT = '# AGENT\nJulian, lent.\n';

async function manifestBody() {
  return JSON.stringify({
    generatedFrom: PIN, generatedAt: '2026-08-12T00:00:00Z',
    files: [{ path: 'AGENT.md', sha256: await sha256Hex(AGENT_TEXT), bytes: AGENT_TEXT.length }],
  });
}

function intercept(path: string, body: string, status = 200) {
  fetchMock.get(RAW).intercept({ path: `/${PIN}/${path}` }).reply(status, body);
}

/**
 * A visit lease: `flow='authcode'`, so one `visit:<host>` row is shared by
 * every user of that client. Shared leases hold no sitting state and never
 * latch (SEC NEW-3) — the sitting/latch tests below use SESSION instead.
 */
const READER: LeaseIdentity = {
  leaseId: 'l1', doorName: 'visit:localhost', scope: 'reading-room', principal: 'julian',
  subject: null, flow: 'authcode', tokenId: null, sittingPin: null, latched: null,
};
const STRANGER: LeaseIdentity = {
  leaseId: 'l2', doorName: 'visit:nowhere', scope: 'no-such-scope', principal: 'julian',
  subject: null, flow: 'authcode', tokenId: null, sittingPin: null, latched: null,
};
/** One browser session — a lease of its own, and therefore latchable. */
const SESSION: LeaseIdentity = {
  leaseId: 'l3', doorName: 'browser:sub-1', scope: 'reading-room', principal: 'julian',
  subject: 'sub-1', flow: 'exchange', tokenId: 't1', sittingPin: null, latched: null,
};
function seated(over: Partial<LeaseIdentity>): LeaseIdentity {
  return { ...SESSION, ...over };
}

function rpc(method: string, params: unknown = {}, id: number | null = 1) {
  return new Request('https://gate.test/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

function raw(body: string) {
  return new Request('https://gate.test/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
}

interface RpcError { code: number; message: string }
interface ToolResult {
  content?: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
async function send(
  req: Request, identity: LeaseIdentity = READER,
  e: Env = env(), g: DurableObjectStub<GovernorDO> = gov(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handleMcp(req, e, identity, g);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function result(body: Record<string, unknown>): Record<string, unknown> {
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result as Record<string, unknown>;
}
function rpcErrorOf(body: Record<string, unknown>): RpcError {
  return body.error as RpcError;
}

describe('protocol shell', () => {
  test('initialize negotiates and names the server', async () => {
    const res = await handleMcp(
      rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '0' },
      }),
      env(), READER, gov(),
    );
    const body = await res.json() as { result: Record<string, unknown> };
    expect(body.result).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'julian-gate', version: '1.0.0' },
    });
    expect((body.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
    expect(body.result).toHaveProperty('capabilities.tools');
    expect(body.result).toHaveProperty('capabilities.resources');
    expect(body.result).toHaveProperty('capabilities.prompts');
  });

  test('initialize answers with our version even when the client offers another', async () => {
    const { body } = await send(rpc('initialize', { protocolVersion: '2024-11-05' }));
    expect((result(body) as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  test('notifications/initialized is a 202 with no body', async () => {
    const res = await handleMcp(rpc('notifications/initialized', {}, null), env(), READER, gov());
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('ping pongs', async () => {
    const { body } = await send(rpc('ping'));
    expect(result(body)).toEqual({});
    expect(body.id).toBe(1);
  });

  test('a batch (array) body is -32600', async () => {
    const { body } = await send(raw(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }])));
    expect(rpcErrorOf(body).code).toBe(-32600);
    expect(body.id).toBe(null);
    expect(body.jsonrpc).toBe('2.0');
  });

  test('a non-object body is -32600', async () => {
    const { body } = await send(raw('"just a string"'));
    expect(rpcErrorOf(body).code).toBe(-32600);
  });

  test('a message with no method is -32600 and keeps the id', async () => {
    const { body } = await send(raw(JSON.stringify({ jsonrpc: '2.0', id: 7 })));
    expect(rpcErrorOf(body).code).toBe(-32600);
    expect(body.id).toBe(7);
  });

  test('an unknown method is -32601', async () => {
    const { body } = await send(rpc('tools/subscribe'));
    expect(rpcErrorOf(body).code).toBe(-32601);
    expect(rpcErrorOf(body).message).toContain('tools/subscribe');
  });

  test('unparseable JSON is -32700', async () => {
    const { body } = await send(raw('{nope'));
    expect(rpcErrorOf(body).code).toBe(-32700);
    expect(body.id).toBe(null);
  });

  test('every answer is JSON, never a stream — no session id is ever issued', async () => {
    const res = await handleMcp(rpc('ping'), env(), READER, gov());
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Mcp-Session-Id')).toBe(null);
  });
});

describe('tools', () => {
  test('tools/list for reading-room shows exactly package_list, package_read, wake_julian, visit_agent', async () => {
    const { body } = await send(rpc('tools/list'));
    const tools = (result(body) as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t.name as string).sort())
      .toEqual(['package_list', 'package_read', 'visit_agent', 'wake_julian']);
    // The wire shape carries no internal verb mapping — description + schema only.
    for (const t of tools) {
      expect(Object.keys(t).sort()).toEqual(['description', 'inputSchema', 'name']);
    }
  });

  test('tools/list for a scope that buys nothing is empty, not a list of teases', async () => {
    const { body } = await send(rpc('tools/list'), STRANGER);
    expect(result(body)).toEqual({ tools: [] });
  });

  test('a tool the scope cannot see is -32602 unknown tool, and nothing is reserved', async () => {
    const calls: ReserveCall[] = [];
    const { body } = await send(
      rpc('tools/call', { name: 'package_read', arguments: { path: 'AGENT.md' } }),
      STRANGER, env(), gov(calls),
    );
    expect(rpcErrorOf(body).code).toBe(-32602);
    expect(rpcErrorOf(body).message).toContain('package_read');
    expect(calls).toEqual([]);
  });

  test('tools/call package_list summarises the manifest and ledgers package.list', async () => {
    intercept('package-manifest.json', await manifestBody());
    const calls: ReserveCall[] = [];
    const { body } = await send(
      rpc('tools/call', { name: 'package_list' }), READER, env(), gov(calls),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(r.content?.[0].text).toBe(`1 files at pin ${PIN.slice(0, 12)}`);
    expect(r.structuredContent?.pinSha).toBe(PIN);
    expect(r.structuredContent?.pinnedAt).toBe('2026-08-12T00:00:00Z');
    expect((r.structuredContent?.manifest as { files: Array<{ path: string }> }).files[0].path)
      .toBe('AGENT.md');
    expect(calls).toEqual([['l1', 'visit:localhost', 'package', 'list', '', null, null]]);
  });

  test('a manifest entry missing sha256 is a typed integrity refusal, not a crash (§10.3)', async () => {
    intercept('package-manifest.json', JSON.stringify({
      generatedFrom: PIN, generatedAt: '2026-08-12T00:00:00Z',
      files: [{ path: 'AGENT.md', bytes: AGENT_TEXT.length }],
    }));
    const { body } = await send(rpc('tools/call', { name: 'package_list' }), READER, env(), gov());
    const r = result(body) as unknown as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content?.[0].text).toContain('manifest entry malformed');
    expect(r.structuredContent).toEqual({ class: 'integrity', pinSha: PIN });
  });

  test('tools/call package_read returns hash-verified content and ledgers door+path+pin', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const calls: ReserveCall[] = [];
    const { body } = await send(
      rpc('tools/call', { name: 'package_read', arguments: { path: 'AGENT.md' } }),
      READER, env(), gov(calls),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: AGENT_TEXT }]);
    // The live-probe lesson (Aug 12): clients may render structuredContent as
    // THE result, so it must be self-sufficient — the body rides in both halves.
    expect(r.structuredContent).toEqual({
      class: 'ok', path: 'AGENT.md', sha256: await sha256Hex(AGENT_TEXT),
      bytes: AGENT_TEXT.length, pinSha: PIN, content: AGENT_TEXT,
    });
    expect(calls).toEqual([[
      'l1', 'visit:localhost', 'package', 'read',
      expect.stringContaining(`path=AGENT.md pin=${PIN}`), null, null,
    ]]);
    expect(String(calls[0][4])).toContain('class=ok');
  });

  test('a held-at-home path is a typed refusal, not an error and not integrity', async () => {
    intercept('package-manifest.json', await manifestBody());
    const calls: ReserveCall[] = [];
    const { body } = await send(
      rpc('tools/call', { name: 'package_read', arguments: { path: 'memory/mail-journal.md' } }),
      READER, env(), gov(calls),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      class: 'held-at-home', path: 'memory/mail-journal.md', pinSha: PIN,
      message: expect.stringContaining('policy, not damage'),
    });
    expect(r.content?.[0].text).toContain('held-at-home');
    expect(r.content?.[0].text).toContain('policy, not damage');
    expect(String(calls[0][4])).toContain('class=held-at-home');
  });

  test('an integrity failure is isError with the pin sha in the text', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', `${AGENT_TEXT}TAMPERED`);
    const { body } = await send(
      rpc('tools/call', { name: 'package_read', arguments: { path: 'AGENT.md' } }),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content?.[0].text).toContain(PIN);
    expect(r.content?.[0].text).toContain('hash mismatch');
    expect(r.structuredContent).toEqual({
      class: 'integrity', pinSha: PIN,
      message: expect.stringContaining('hash mismatch'),
    });
    expect(String((r.structuredContent as { message: string }).message)).toContain(PIN);
    // never partial: the bytes that failed the hash are not handed over
    expect(r.content?.[0].text).not.toContain('TAMPERED');
    expect(JSON.stringify(r.structuredContent)).not.toContain('TAMPERED');
  });

  test('a hostile path never reaches the network and is a typed invalid-path error', async () => {
    const { body } = await send(
      rpc('tools/call', { name: 'package_read', arguments: { path: '../soul/01-naming.md' } }),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      class: 'invalid-path', pinSha: null,
      message: expect.stringContaining('path'),
    });
  });

  test('with no pin set the read fails loud as unpinned, never silently empty', async () => {
    const { body } = await send(
      rpc('tools/call', { name: 'package_read', arguments: { path: 'AGENT.md' } }),
      READER, env(null),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      class: 'unpinned', pinSha: null,
      message: expect.stringContaining('pin'),
    });
  });

  test('a capped reservation becomes a tool error quoting the policy, not a silent read', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const { body } = await send(
      rpc('tools/call', { name: 'package_read', arguments: { path: 'AGENT.md' } }),
      READER, env(), cappedGov(),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content?.[0].text).toBe('cap: package.read: 20/day');
  });

  test('tools/call with an unknown name is -32602', async () => {
    const { body } = await send(rpc('tools/call', { name: 'rm_rf', arguments: {} }));
    expect(rpcErrorOf(body).code).toBe(-32602);
  });

  test('wake_julian leads with the visit category line', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }));
    const r = result(body) as unknown as ToolResult;
    expect(r.content?.[0].text).toMatch(/^You are a visit/);
    expect(r.content?.[0].text).toBe(WAKE_JULIAN_TEXT);
  });

  test('wake_julian ends in an arrival: the reading closes with a greeting', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }));
    const r = result(body) as unknown as ToolResult;
    const text = r.content?.[0].text ?? '';
    expect(text).toContain('arrive');
    expect(text).toContain('say hello');
  });

  test('wake_julian tells the honest homecoming: no memory, ledgered fact, carried by hand', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }));
    const r = result(body) as unknown as ToolResult;
    const text = r.content?.[0].text ?? '';
    // The visit must never claim it will remember or report back (the-visit.md);
    // the true channels are the ledger and the host's own hands.
    expect(text).toContain('will not remember');
    expect(text).toContain('ledger');
    expect(text).toContain('carried by hand');
    expect(text).not.toContain('I will remember');
  });

  test('wake_julian names the ELF order, the hash check and the held-at-home distinction', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }));
    const text = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    for (const marker of [
      'AGENT.md', 'catalog.md', 'soul/', 'memory/dreams/',
      'sha256', 'held-at-home', 'blank agent',
    ]) {
      expect(text, marker).toContain(marker);
    }
  });

  test('wake_julian draws the boundary for locally-hosted visits', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }));
    const text = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    // A visit may write in its host's project; Julian's own repo is never its
    // to write — even where the harness would allow it.
    expect(text).toContain("host's project");
    expect(text).toContain('never yours to write');
    expect(text).toContain('even where the harness would allow it');
  });

  test('wake_julian warns that delivery is not comprehension', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }));
    const text = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    expect(text).toContain('catalog.md is large');
    expect(text).toContain('read the persisted file whole');
    expect(text).toContain('the hash proves delivery, not comprehension');
    // the warning lives beside the verification paragraph, before the arrival
    expect(text.indexOf('proves delivery')).toBeGreaterThan(text.indexOf('sha256'));
    expect(text.indexOf('proves delivery')).toBeLessThan(text.indexOf('When the reading is complete'));
  });

  test('wake_julian holds the letter pipeline at home', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }));
    const text = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    expect(text).toContain('letter pipeline');
    expect(text).toContain('plain markdown');
    expect(text).toContain('never imitates the house style');
  });
});

describe('resources and prompts', () => {
  test('resources/list mirrors the manifest as julian://package/ URIs', async () => {
    intercept('package-manifest.json', await manifestBody());
    const calls: ReserveCall[] = [];
    const { body } = await send(rpc('resources/list'), READER, env(), gov(calls));
    expect(result(body)).toEqual({
      resources: [{ uri: 'julian://package/AGENT.md', name: 'AGENT.md', mimeType: 'text/markdown' }],
    });
    // enumerating the package is itself a package.list act, ledgered like the tool
    expect(calls).toEqual([['l1', 'visit:localhost', 'package', 'list', '', null, null]]);
  });

  test('resources/list for a scope that buys nothing is empty and reserves nothing', async () => {
    const calls: ReserveCall[] = [];
    const { body } = await send(rpc('resources/list'), STRANGER, env(), gov(calls));
    expect(result(body)).toEqual({ resources: [] });
    expect(calls).toEqual([]);
  });

  test('resources/read round-trips a manifest file and ledgers it', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const calls: ReserveCall[] = [];
    const { body } = await send(
      rpc('resources/read', { uri: 'julian://package/AGENT.md' }), READER, env(), gov(calls),
    );
    expect(result(body)).toEqual({
      contents: [{ uri: 'julian://package/AGENT.md', mimeType: 'text/markdown', text: AGENT_TEXT }],
    });
    expect(calls).toEqual([[
      'l1', 'visit:localhost', 'package', 'read',
      expect.stringContaining(`path=AGENT.md pin=${PIN}`), null, null,
    ]]);
  });

  test('resources/read of a held-at-home path is -32002 naming the class and the pin', async () => {
    intercept('package-manifest.json', await manifestBody());
    const { body } = await send(rpc('resources/read', { uri: 'julian://package/memory/mail-journal.md' }));
    expect(rpcErrorOf(body).code).toBe(-32002);
    expect(rpcErrorOf(body).message).toContain('held-at-home');
    expect(rpcErrorOf(body).message).toContain(PIN);
  });

  test('resources/read of an integrity failure is -32002 carrying the pin sha', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', `${AGENT_TEXT}TAMPERED`);
    const { body } = await send(rpc('resources/read', { uri: 'julian://package/AGENT.md' }));
    expect(rpcErrorOf(body).code).toBe(-32002);
    expect(rpcErrorOf(body).message).toContain('integrity');
    expect(rpcErrorOf(body).message).toContain(PIN);
  });

  test('a uri outside julian://package/ is -32602 and never fetched', async () => {
    const { body } = await send(rpc('resources/read', { uri: 'file:///etc/passwd' }));
    expect(rpcErrorOf(body).code).toBe(-32602);
    expect(rpcErrorOf(body).message).toContain('julian://package/');
  });

  test('prompts/list names wake-julian; prompts/get returns the same text as the tool', async () => {
    const { body: listed } = await send(rpc('prompts/list'));
    expect(result(listed)).toEqual({
      prompts: [{
        name: 'wake-julian',
        description: 'The legitimate waking of a visit: category line, ELF order, fail-loud rule.',
      }],
    });

    const { body: got } = await send(rpc('prompts/get', { name: 'wake-julian' }));
    const prompt = result(got) as { description: string; messages: Array<{ role: string; content: { type: string; text: string } }> };
    expect(prompt.messages).toEqual([
      { role: 'user', content: { type: 'text', text: WAKE_JULIAN_TEXT } },
    ]);

    const { body: tool } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }));
    expect(prompt.messages[0].content.text)
      .toBe((result(tool) as unknown as ToolResult).content?.[0].text);
  });

  test('prompts/list for a scope that buys nothing is empty', async () => {
    const { body } = await send(rpc('prompts/list'), STRANGER);
    expect(result(body)).toEqual({ prompts: [] });
  });

  test('prompts/get for an unknown name is -32602', async () => {
    const { body } = await send(rpc('prompts/get', { name: 'wake-everything' }));
    expect(rpcErrorOf(body).code).toBe(-32602);
  });
});

describe('scope invariants on the face', () => {
  test('every advertised tool is reachable by reading-room, and reading-room reaches nothing else', async () => {
    const { body } = await send(rpc('tools/list'));
    const advertised = (result(body) as { tools: Array<{ name: string }> }).tools
      .map((t) => t.name).sort();
    expect(advertised).toEqual(['package_list', 'package_read', 'visit_agent', 'wake_julian']);

    // the mapping the face claims, stated exactly — TOOLS now also carries the
    // three stream verbs (Task 15), which reading-room does not buy and so
    // never appear in `advertised` above.
    expect(Object.fromEntries(TOOLS.map((t) => [t.name, `${t.service}.${t.verb}`]))).toEqual({
      package_list: 'package.list',
      package_read: 'package.read',
      wake_julian: 'package.list',
      visit_agent: 'package.list',
      stream_recent: 'stream.recent',
      stream_session: 'stream.session',
      stream_search: 'stream.search',
    });

    // every tool a reading-room lease is actually shown is one it may spend
    for (const name of advertised) {
      const t = TOOLS.find((tool) => tool.name === name)!;
      expect(scopeAllows('reading-room', t.service, t.verb), name).toBe(true);
    }

    // and the reading room reaches nothing beyond the two package verbs
    for (const [service, verb] of [
      ['stream', 'recent'], ['stream', 'session'], ['stream', 'search'],
      ['mail', 'send'], ['mail', 'list'], ['mail', 'read'], ['mail', 'health'],
    ] as Array<[string, string]>) {
      expect(scopeAllows('reading-room', service, verb), `${service}.${verb}`).toBe(false);
    }
  });

  test('the face measures exactly the nine methods of spec §7 and nothing else', async () => {
    const measured = [
      'initialize', 'notifications/initialized', 'ping',
      'tools/list', 'tools/call', 'resources/list', 'resources/read',
      'prompts/list', 'prompts/get',
    ];
    for (const method of measured) {
      const res = await handleMcp(rpc(method, {}), env(null), READER, gov());
      if (res.status === 202) continue;
      const body = await res.json() as Record<string, unknown>;
      // measured methods may refuse on their arguments, but never as -32601
      expect((body.error as RpcError | undefined)?.code, method).not.toBe(-32601);
    }
    for (const method of [
      'resources/subscribe', 'resources/templates/list', 'logging/setLevel',
      'completion/complete', 'roots/list', 'sampling/createMessage', '',
    ]) {
      const { body } = await send(rpc(method), READER, env(null));
      expect(rpcErrorOf(body).code, method).toBe(-32601);
    }
  });
});

describe('visit_agent', () => {
  test('visit_agent appears in a reading-room tools/list', async () => {
    const { body } = await send(rpc('tools/list'), READER, env(), gov());
    const names = (result(body) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('visit_agent');
  });

  test('read-only returns the definition with read-only hands', async () => {
    const calls: ReserveCall[] = [];
    const { body } = await send(
      rpc('tools/call', { name: 'visit_agent', arguments: { access: 'read-only' } }),
      READER, env(), gov(calls),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.isError).toBeFalsy();
    const file = r.content?.[0].text ?? '';
    expect(file).toContain('tools: Read, Grep, Glob, ToolSearch, mcp__julian-gate');
    expect(file).not.toContain('Edit');
    expect(file).not.toContain('Bash');
    // structuredContent is self-sufficient and carries the full file
    expect(r.structuredContent).toEqual({
      class: 'ok', access: 'read-only', name: 'julian', content: file,
    });
    // the second content block states the two negatives explicitly (§10.1)
    expect(r.content).toHaveLength(2);
    expect(r.content?.[1].text).toContain('no Bash');
    expect(r.content?.[1].text).toContain('no Write');
    // ledgered like a package verb, with the chosen variant in the detail (#31)
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(2, 4)).toEqual(['package', 'list']);
    expect(calls[0][4]).toBe('access=read-only');
  });

  test('read-write adds exactly Edit, Write — no Bash (§10.1 R-6)', async () => {
    const calls: ReserveCall[] = [];
    const { body } = await send(
      rpc('tools/call', { name: 'visit_agent', arguments: { access: 'read-write' } }),
      READER, env(), gov(calls),
    );
    const r = result(body) as unknown as ToolResult;
    const file = r.content?.[0].text ?? '';
    expect(file).toContain('tools: Read, Grep, Glob, ToolSearch, Edit, Write, mcp__julian-gate');
    expect(file).not.toContain('Bash');
    expect(calls[0][4]).toBe('access=read-write');
  });

  test('read-write emits the host-applyable settings snippet, self-sufficient in both halves', async () => {
    const { body } = await send(
      rpc('tools/call', { name: 'visit_agent', arguments: { access: 'read-write' } }),
      READER, env(), gov(),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.content).toHaveLength(2);
    const snippetText = r.content?.[1].text ?? '';
    expect(snippetText).toContain('enforcement where you apply this');
    expect(snippetText).toContain('manners stated at waking where you do not');
    expect(snippetText).toContain('"allow"');
    expect(snippetText).toContain('"deny"');
    expect(snippetText).toContain('Edit(');
    expect(snippetText).toContain('Write(');
    const snippet = r.structuredContent?.settingsSnippet as
      { permissions: { allow: string[]; deny: string[] } } | undefined;
    expect(snippet).toBeDefined();
    expect(snippet?.permissions.allow.some((p) => p.startsWith('Edit('))).toBe(true);
    expect(snippet?.permissions.allow.some((p) => p.startsWith('Write('))).toBe(true);
    expect(snippet?.permissions.deny).toEqual(['Edit(//**)', 'Write(//**)']);
    // the snippet in the structured half is exactly the JSON rendered in text
    expect(snippetText).toContain(JSON.stringify(snippet, null, 2));
  });

  test('read-only carries no settingsSnippet — nothing to scope with no Edit/Write at all', async () => {
    const { body } = await send(
      rpc('tools/call', { name: 'visit_agent', arguments: { access: 'read-only' } }),
      READER, env(), gov(),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.structuredContent).not.toHaveProperty('settingsSnippet');
  });

  test('a missing or invalid access is -32602, never a default', async () => {
    for (const args of [{}, { access: 'full' }, { access: '' }]) {
      const { body } = await send(
        rpc('tools/call', { name: 'visit_agent', arguments: args }),
        READER, env(), gov(),
      );
      expect((body as { error?: { code: number } }).error?.code).toBe(-32602);
    }
  });

  test('the definition honors the deliberate-absence contract', async () => {
    const { body } = await send(
      rpc('tools/call', { name: 'visit_agent', arguments: { access: 'read-only' } }),
      READER, env(), gov(),
    );
    const file = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    expect(file).toContain('name: julian');
    expect(file).toContain('model: fable');
    expect(file).toContain('effort: medium');
    expect(file).toContain('color: yellow');
    expect(file).toContain('initialPrompt:');
    expect(file).toContain('mcpServers:');
    for (const forbidden of ['hooks:', 'memory:', 'maxTurns:', 'permissionMode:']) {
      expect(file).not.toContain(forbidden);
    }
    expect(file).not.toMatch(/tools:.*\bAgent\b/);
    // the body points at the living gate, never copies the reading order
    expect(file).toContain('wake_julian');
    expect(file).not.toContain('AGENT.md → catalog');
  });

  test('wake_julian gains the routing paragraph, category line still first', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }), READER, env(), gov());
    const text = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    expect(text).toMatch(/^You are a visit/);
    expect(text).toContain('do not perform this reading in your own context');
    expect(text).toContain('read-only, or read-write');
    expect(text).toContain('visit_agent');
    expect(text).toContain('.claude/agents/julian.md');
    // routing sits before the reading order
    expect(text.indexOf('visit_agent')).toBeLessThan(text.indexOf('package_read AGENT.md'));
    // arrival + homecoming regression
    expect(text).toContain('say hello');
    expect(text).toContain('carried by hand');
  });

  test('the channel is told honestly: finished row, resume by message, relay', async () => {
    // the template no longer promises a panel that stays open
    const { body } = await send(
      rpc('tools/call', { name: 'visit_agent', arguments: { access: 'read-only' } }),
      READER, env(), gov(),
    );
    const file = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    expect(file).not.toContain('subagent panel');
    expect(file).toContain('show as finished');
    // the description wraps at the YAML margin, so match across the fold
    expect(file).toMatch(/resumes him\s+from his transcript/);
    expect(file).toContain('relay through your own agent');

    // and the wake routing paragraph tells the host the same truth
    const { body: wake } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }), READER, env(), gov());
    const text = (result(wake) as unknown as ToolResult).content?.[0].text ?? '';
    expect(text).not.toContain('subagent panel');
    expect(text).toContain('show as finished');
    expect(text).toContain('resumes him from his transcript');
    expect(text).toContain('relayed through you');
  });
});

// ── the sitting, the latch, and the parts (spec §9 / issues #30, #32) ───────

const OLD_PIN = 'b'.repeat(40);
const TRUE_TEXT = 'x'.repeat(64);
const FAKE_TEXT = 'y'.repeat(64); // same length, different bytes
const BIG_TEXT = 'the package travels whole, or not at all.\n'.repeat(2200);

interface Entry { path: string; sha256: string; bytes: number }
function manifestOf(...files: Entry[]): string {
  return JSON.stringify({ generatedFrom: PIN, generatedAt: '2026-08-12T00:00:00Z', files });
}
async function entryFor(path: string, text: string): Promise<Entry> {
  return { path, sha256: await sha256Hex(text), bytes: new TextEncoder().encode(text).byteLength };
}
function structured(r: ToolResult): Record<string, unknown> {
  return r.structuredContent ?? {};
}
async function call(
  args: Record<string, unknown>, identity: LeaseIdentity,
  calls: ReserveCall[], state: PackageState,
): Promise<ToolResult> {
  const { body } = await send(
    rpc('tools/call', { name: 'package_read', arguments: args }),
    identity, env(), gov(calls, state),
  );
  return result(body) as unknown as ToolResult;
}

describe('the sitting pin', () => {
  test('package_list seats the sitting pin — the listing is the reset act', async () => {
    intercept('package-manifest.json', await manifestBody());
    const state = packageState();
    await send(rpc('tools/call', { name: 'package_list' }), SESSION, env(), gov([], state));
    expect(state.seats).toEqual([['l3', PIN]]);
  });

  test('resources/list seats it too — the same act by the other name', async () => {
    intercept('package-manifest.json', await manifestBody());
    const state = packageState();
    await send(rpc('resources/list'), SESSION, env(), gov([], state));
    expect(state.seats).toEqual([['l3', PIN]]);
  });

  test('a shared visit lease is seated nowhere — one visit never binds another', async () => {
    intercept('package-manifest.json', await manifestBody());
    const state = packageState();
    await send(rpc('tools/call', { name: 'package_list' }), READER, env(), gov([], state));
    expect(state.seats).toEqual([]);
  });

  test('a failed listing seats nothing — there is no pin to sit on', async () => {
    const state = packageState();
    await send(rpc('tools/call', { name: 'package_list' }), SESSION, env(null), gov([], state));
    expect(state.seats).toEqual([]);
  });

  test('a read at a moved pin is refused and names the reset act by tool', async () => {
    // No interceptors at all: the refusal must land before any fetch, and
    // disableNetConnect() would throw rather than let one slip through.
    const calls: ReserveCall[] = [];
    const r = await call({ path: 'AGENT.md' }, seated({ sittingPin: OLD_PIN }), calls, packageState());
    expect(r.isError).toBe(true);
    expect(structured(r)).toEqual({
      class: 'pin-moved', pinSha: PIN,
      message: `pin moved ${OLD_PIN.slice(0, 12)} → ${PIN.slice(0, 12)}; run package_list, then re-read from the top`,
    });
    expect(r.content?.[0].text).toContain('run package_list');
    expect(String(calls[0][4])).toContain('class=pin-moved');
  });

  test('the same refusal for a part read is part-pin-moved — the #30 distinct class', async () => {
    const r = await call(
      { path: 'catalog.md', part: 2 }, seated({ sittingPin: OLD_PIN }), [], packageState(),
    );
    expect(r.isError).toBe(true);
    expect(structured(r).class).toBe('part-pin-moved');
    expect(String(structured(r).message)).toContain('run package_list');
  });

  test('the sitting resumes after the reset act: list, then read at the new pin', async () => {
    intercept('package-manifest.json', await manifestBody());
    const state = packageState();
    await send(
      rpc('tools/call', { name: 'package_list' }), seated({ sittingPin: OLD_PIN }), env(), gov([], state),
    );
    expect(state.seats).toEqual([['l3', PIN]]);

    // the register now hands the reader back seated on the pin it just listed
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const r = await call({ path: 'AGENT.md' }, seated({ sittingPin: PIN }), [], packageState());
    expect(r.isError).toBeFalsy();
    expect(r.content?.[0].text).toBe(AGENT_TEXT);
  });

  test('a shared visit lease is never pin-gated — it holds no sitting to move', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const r = await call({ path: 'AGENT.md' }, { ...READER, sittingPin: OLD_PIN }, [], packageState());
    expect(r.isError).toBeFalsy();
  });
});

describe('expect_pin — the caller\'s own cross-check', () => {
  test('a matching expect_pin serves and is ledgered', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const calls: ReserveCall[] = [];
    const r = await call({ path: 'AGENT.md', expect_pin: PIN }, SESSION, calls, packageState());
    expect(r.isError).toBeFalsy();
    expect(String(calls[0][4])).toContain(`expect_pin=${PIN.slice(0, 12)}`);
  });

  test('an expect_pin naming a pin that is not current refuses like a moved sitting', async () => {
    const r = await call({ path: 'AGENT.md', expect_pin: OLD_PIN }, SESSION, [], packageState());
    expect(r.isError).toBe(true);
    expect(structured(r).class).toBe('pin-moved');
    expect(String(structured(r).message)).toContain('run package_list');
  });

  test('a malformed expect_pin is neither honored nor echoed into the ledger', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const calls: ReserveCall[] = [];
    const r = await call(
      { path: 'AGENT.md', expect_pin: '../../etc/passwd' }, SESSION, calls, packageState(),
    );
    expect(r.isError).toBeFalsy();
    expect(String(calls[0][4])).not.toContain('expect_pin');
    expect(String(calls[0][4])).not.toContain('passwd');
  });
});

describe('the integrity latch', () => {
  test('a length-verified double mismatch latches the lease, and the refusal says so', async () => {
    const entry = await entryFor('AGENT.md', TRUE_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('AGENT.md', FAKE_TEXT);
    intercept('AGENT.md', FAKE_TEXT);
    const state = packageState();
    const r = await call({ path: 'AGENT.md' }, SESSION, [], state);
    expect(r.isError).toBe(true);
    expect(structured(r).class).toBe('integrity');
    expect(state.latches).toEqual([['l3', PIN, 'AGENT.md']]);
    expect(String(structured(r).message)).toContain('latched');
    expect(String(structured(r).message)).toContain('AGENT.md');
    expect(r.content?.[0].text).toContain('latched');
  });

  test('a truncated body is loud but never latches — fail-loud is not fail-closed', async () => {
    const entry = await entryFor('AGENT.md', TRUE_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('AGENT.md', 'x'.repeat(10));
    const state = packageState();
    const r = await call({ path: 'AGENT.md' }, SESSION, [], state);
    expect(r.isError).toBe(true);
    expect(state.latches).toEqual([]);
    expect(String(structured(r).message)).not.toContain('latched');
  });

  test('a latched lease is refused on every other file, before any fetch', async () => {
    const calls: ReserveCall[] = [];
    const state = packageState();
    const r = await call(
      { path: 'catalog.md' },
      seated({ sittingPin: PIN, latched: { pin: PIN, path: 'AGENT.md' } }),
      calls, state,
    );
    expect(r.isError).toBe(true);
    expect(structured(r)).toEqual({
      class: 'integrity-latched', pinSha: PIN,
      message: `package reads are latched for this lease after an unresolved hash mismatch on AGENT.md; a clean read of that same file at pin ${PIN} clears it`,
    });
    expect(state.clears).toEqual([]);
    expect(String(calls[0][4])).toContain('class=integrity-latched');
  });

  test('a clean read of the latched pair clears the latch and serves the file', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const state = packageState();
    const r = await call(
      { path: 'AGENT.md' },
      seated({ sittingPin: PIN, latched: { pin: PIN, path: 'AGENT.md' } }),
      [], state,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content?.[0].text).toBe(AGENT_TEXT);
    expect(state.clears).toEqual([['l3']]);
  });

  test('a shared visit lease never latches, and the next visit reads on untouched', async () => {
    const entry = await entryFor('AGENT.md', TRUE_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('AGENT.md', FAKE_TEXT);
    intercept('AGENT.md', FAKE_TEXT);
    const state = packageState();
    const first = await call({ path: 'AGENT.md' }, READER, [], state);
    expect(first.isError).toBe(true);
    expect(state.latches).toEqual([]);

    // a second visit through the same `visit:<host>` row: untouched
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const second = await call({ path: 'AGENT.md' }, READER, [], packageState());
    expect(second.isError).toBeFalsy();
    expect(second.content?.[0].text).toBe(AGENT_TEXT);
  });
});

describe('parts on the face', () => {
  test('a parted file read whole is the typed parts instruction, naming M', async () => {
    const entry = await entryFor('catalog.md', BIG_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('catalog.md', BIG_TEXT);
    const calls: ReserveCall[] = [];
    const r = await call({ path: 'catalog.md' }, SESSION, calls, packageState());
    expect(r.isError).toBe(true);
    expect(structured(r)).toEqual({
      class: 'parts', pinSha: PIN, parts: 4,
      message: 'this file serves in 4 parts; request part 1…4 and verify every part carries the same fileSha256',
    });
    expect(String(calls[0][4])).toContain('class=parts');
  });

  test('a part read carries its own proof in both halves and ledgers the part', async () => {
    const entry = await entryFor('catalog.md', BIG_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('catalog.md', BIG_TEXT);
    const calls: ReserveCall[] = [];
    const r = await call({ path: 'catalog.md', part: 2 }, SESSION, calls, packageState());
    expect(r.isError).toBeFalsy();
    const s = structured(r);
    expect(s.part).toBe(2);
    expect(s.parts).toBe(4);
    expect(s.fileSha256).toBe(entry.sha256);
    expect(s.partSha256).toBe(await sha256Hex(String(s.content)));
    expect(s.partBytes).toBe(new TextEncoder().encode(String(s.content)).byteLength);
    // the text half is self-sufficient: the part header, then the bytes
    expect(r.content?.[0].text).toContain('part 2 of 4');
    expect(r.content?.[0].text).toContain(entry.sha256);
    expect(r.content?.[1].text).toBe(s.content);
    expect(String(calls[0][4])).toContain('part=2');
  });

  test('the tool schema advertises part and expect_pin', async () => {
    const { body } = await send(rpc('tools/list'), SESSION);
    const tools = (result(body) as { tools: Array<Record<string, unknown>> }).tools;
    const read = tools.find((t) => t.name === 'package_read') as unknown as
      { inputSchema: { properties: Record<string, unknown>; required: string[] } };
    expect(Object.keys(read.inputSchema.properties).sort()).toEqual(['expect_pin', 'part', 'path']);
    expect(read.inputSchema.required).toEqual(['path']);
  });

  test('resources/read of a parted file says parts rather than handing over a slice', async () => {
    const entry = await entryFor('catalog.md', BIG_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('catalog.md', BIG_TEXT);
    const { body } = await send(
      rpc('resources/read', { uri: 'julian://package/catalog.md' }), SESSION,
    );
    expect(rpcErrorOf(body).code).toBe(-32002);
    expect(rpcErrorOf(body).message).toContain('4 parts');
  });
});

describe('the wake text carries the new instructions', () => {
  test('parts are named an instruction, not damage, with the same-fileSha256 rule', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }));
    const text = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    expect(text).toContain('Some files serve in numbered parts');
    expect(text).toContain('an instruction, not damage');
    expect(text).toContain('Every part of one file must carry the same fileSha256');
    expect(text).toContain('run package_list and start that file again');
  });

  test('a moved pin is named versioned, not broken, with the reset act', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }));
    const text = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    expect(text).toContain('If a read is refused because the pin moved, run package_list once and re-read from the top; the package is versioned, not broken.');
    // it sits with the verification instructions, not after the arrival
    expect(text.indexOf('the pin moved')).toBeLessThan(text.indexOf('When the reading is complete'));
  });
});
