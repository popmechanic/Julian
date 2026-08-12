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

/** Records every reservation and always allows — the pen, not the policy. */
function gov(calls: ReserveCall[] = []): DurableObjectStub<GovernorDO> {
  return {
    async reserveLease(...args: unknown[]) {
      calls.push(args);
      return { ok: true, count: 1, cap: null };
    },
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

const READER: LeaseIdentity = {
  leaseId: 'l1', doorName: 'visit:localhost', scope: 'reading-room', principal: 'julian',
};
const STRANGER: LeaseIdentity = {
  leaseId: 'l2', doorName: 'visit:nowhere', scope: 'no-such-scope', principal: 'julian',
};

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
  test('tools/list for reading-room shows exactly package_list, package_read, wake_julian', async () => {
    const { body } = await send(rpc('tools/list'));
    const tools = (result(body) as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t.name as string).sort())
      .toEqual(['package_list', 'package_read', 'wake_julian']);
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
    expect(advertised).toEqual(['package_list', 'package_read', 'wake_julian']);

    // the mapping the face claims, stated exactly
    expect(Object.fromEntries(TOOLS.map((t) => [t.name, `${t.service}.${t.verb}`]))).toEqual({
      package_list: 'package.list',
      package_read: 'package.read',
      wake_julian: 'package.list',
    });

    // every advertised tool is one a reading-room lease may actually spend
    for (const t of TOOLS) {
      expect(advertised).toContain(t.name);
      expect(scopeAllows('reading-room', t.service, t.verb), t.name).toBe(true);
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
