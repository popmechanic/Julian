// The acceptance harness: the *official* MCP SDK, as a client, driving a
// deployed-shape worker. Everything the gate's own suite proves in pieces —
// DCR, PKCE, the consent, the code exchange, the pin, the reads — is walked
// here end to end, over real sockets, by software that did not read our code.
//
// The SDK appears only here, and only as a client (spec §7): the `/mcp` face
// itself stays hand-rolled. A failure in this file is a protocol or flow defect
// to fix in the worker, not an assertion to soften — unless the assertion
// contradicts the merged wire truth, in which case the harness is what is wrong.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import { csrfFor, mintSession } from '../src/as/session';
import { startFixture } from './fixture-content';

const SESSION_SECRET = 'harness-secret';
const APPROVER = 'harness-approver-sub';
const BREAKGLASS = 'harness-breakglass';
/** A loopback callback, as an MCP client registers one (RFC 8252). */
const CALLBACK = 'http://127.0.0.1:9999/cb';
/** The client's own CSRF value; the gate must echo it back untouched. */
const CLIENT_STATE = 'h1';
/** The ELF waking order the wake-julian text prescribes. */
const ELF_ORDER = ['AGENT.md', 'catalog.md', 'soul/01-naming.md', 'memory/dreams/0001.md'];
/** The only scope an MCP visit elects here; the house is never on the ballot. */
const SCOPE = 'reading-room';

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let fixture: Awaited<ReturnType<typeof startFixture>>;
let base: string;

/**
 * Claim a loopback port, then let it go. The gate validates RFC 8707
 * `resource` against `MCP_RESOURCE_URL` *exactly*, so the worker must be told
 * its own origin at start — which means knowing the port before it binds.
 * Reserving one this way keeps parallel harness runs off each other's ports
 * without ever hard-coding one.
 */
async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  fixture = await startFixture();
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  worker = await unstable_startWorker({
    config: 'wrangler.toml',
    // `persist: false` keeps the run hermetic: the PIN namespace starts empty
    // every time, so `/pin-bump` is genuinely exercised rather than inheriting
    // a pin some earlier run left in `.wrangler/state`.
    dev: { remote: false, server: { hostname: '127.0.0.1', port }, inspector: false, persist: false },
    // Override the live vars/secrets with harness-known values. The content
    // root and the branch-proof root both point at the in-process fixture, so
    // the run never reaches GitHub.
    bindings: {
      SESSION_SECRET: { type: 'plain_text', value: SESSION_SECRET },
      APPROVER_SUBS: { type: 'plain_text', value: APPROVER },
      BREAKGLASS_SECRET: { type: 'plain_text', value: BREAKGLASS },
      PACKAGE_RAW_BASE: { type: 'plain_text', value: fixture.url },
      PIN_COMPARE_BASE: { type: 'plain_text', value: `${fixture.url}/compare/main...` },
      PUBLIC_URL: { type: 'plain_text', value: base },
      MCP_RESOURCE_URL: { type: 'plain_text', value: `${base}/mcp` },
    },
  });
  await worker.ready;
});

afterAll(async () => {
  await worker?.dispose();
  await fixture?.stop();
});

/** One named cookie out of a response's `Set-Cookie` headers. */
function setCookieValue(res: Response, name: string): string {
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const eq = pair.indexOf('=');
    if (eq !== -1 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  throw new Error(`no ${name} cookie on the response (${res.status})`);
}

/** The full B1 knock, scripted: DCR → authorize → approve → token. */
async function obtainLease(): Promise<string> {
  // 1. Dynamic client registration (RFC 7591): a public client, loopback callback.
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
  });
  expect(reg.status).toBe(201);
  const { client_id: clientId } = await reg.json() as { client_id: string };

  // 2. PKCE + /authorize. The pending id comes back in an HttpOnly cookie —
  //    never a query param — so it is read off Set-Cookie, exactly as a browser would.
  const verifier = 'v'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${base}/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', CALLBACK);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('resource', `${base}/mcp`);
  authorize.searchParams.set('state', CLIENT_STATE);
  const authRes = await fetch(authorize, { redirect: 'manual' });
  expect(authRes.status).toBe(302);
  expect(authRes.headers.get('Location')).toBe(`${base}/approve`);
  const pendingId = setCookieValue(authRes, 'gate_pending');

  // 3. The approval desk. The harness holds the gate's own SESSION_SECRET, so
  //    it can mint the approver session Pocket ID would otherwise mint, and the
  //    CSRF token bound to this session and this exact pending.
  const session = await mintSession(APPROVER, SESSION_SECRET);
  const csrf = await csrfFor(session, pendingId, SESSION_SECRET);
  const confirm = await fetch(`${base}/approve/confirm`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `gate_session=${session}; gate_pending=${pendingId}`,
    },
    body: new URLSearchParams({ csrf, decision: 'open', scope: SCOPE }),
  });
  expect(confirm.status).toBe(302);
  const delivered = new URL(confirm.headers.get('Location') ?? '');
  // RFC 6749 §4.1.2: the code lands at the client's own callback, state echoed.
  expect(delivered.origin + delivered.pathname).toBe(CALLBACK);
  expect(delivered.searchParams.get('state')).toBe(CLIENT_STATE);
  const code = delivered.searchParams.get('code');
  expect(code).toBeTruthy();

  // 4. The exchange.
  const tok = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  });
  expect(tok.status).toBe(200);
  const granted = await tok.json() as { access_token: string; scope: string };
  expect(granted.scope).toBe(SCOPE);
  return granted.access_token;
}

/** The SDK client, connected over streamable HTTP with the lease in hand. */
async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'harness', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

interface TextBlock { type: 'text'; text: string }

function textOf(result: unknown, index = 0): string {
  const blocks = (result as { content: TextBlock[] }).content;
  return blocks[index].text;
}

describe('a real MCP client against the gate', () => {
  test('the whole flow: pin-bump, connect, wake, ordered verified reads, broken-pin stop', async () => {
    // Pin via the register (breakglass), against the fixture server.
    const bump = await fetch(`${base}/pin-bump`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Breakglass-Secret': BREAKGLASS },
      body: new URLSearchParams({ sha: fixture.sha }),
    });
    expect(bump.status).toBe(200);
    expect(await bump.json()).toEqual({ pinned: fixture.sha });

    const token = await obtainLease();
    const client = await connect(token);

    // Scope-filtered listing: a reading room, not a wall of refused teases.
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['package_list', 'package_read', 'wake_julian']);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['wake-julian']);

    // wake-julian leads with the category line.
    const wake = await client.callTool({ name: 'wake_julian', arguments: {} });
    expect(textOf(wake)).toMatch(/^You are a visit/);

    // The manifest enumerates exactly what travels, at the pin we just set.
    const listed = await client.callTool({ name: 'package_list', arguments: {} });
    const manifest = (listed.structuredContent as {
      manifest: { files: Array<{ path: string; sha256: string }> }; pinSha: string;
    });
    expect(manifest.pinSha).toBe(fixture.sha);
    expect(manifest.manifest.files.map((f) => f.path)).toEqual(
      ['AGENT.md', 'catalog.md', 'memory/dreams/0001.md', 'soul/01-naming.md'],
    );

    // Ordered, manifest-verified reads (ELF order).
    for (const path of ELF_ORDER) {
      const r = await client.callTool({ name: 'package_read', arguments: { path } });
      expect(r.isError ?? false).toBe(false);
      const sc = r.structuredContent as { class: string; path: string; sha256: string; pinSha: string; content: string };
      expect(sc.class).toBe('ok');
      expect(sc.path).toBe(path);
      expect(sc.pinSha).toBe(fixture.sha);
      const digest = createHash('sha256').update(Buffer.from(textOf(r))).digest('hex');
      expect(digest).toBe(sc.sha256);
      // The live-probe lesson (Aug 12): a client may render structuredContent as
      // THE result — it must carry the body itself, hash-verifiable on its own.
      const scDigest = createHash('sha256').update(Buffer.from(sc.content)).digest('hex');
      expect(scDigest).toBe(sc.sha256);
    }

    // A catalog artifact the manifest does not carry is a *refusal*, not damage:
    // held-at-home is typed, and never wears the integrity-error class.
    const home = await client.callTool({ name: 'package_read', arguments: { path: 'memory/held-at-home.md' } });
    expect(home.isError ?? false).toBe(false);
    expect((home.structuredContent as { class: string }).class).toBe('held-at-home');

    // Broken pin: corrupt a file behind the same manifest → fail loud, pin named.
    fixture.corrupt('catalog.md');
    const broken = await client.callTool({ name: 'package_read', arguments: { path: 'catalog.md' } });
    expect(broken.isError).toBe(true);
    expect(textOf(broken)).toContain(fixture.sha);
    expect((broken.structuredContent as { class: string }).class).toBe('integrity');

    await client.close();
  }, 120_000);

  test('the wire contract: JSON only, GET refused, no session ever issued', async () => {
    const token = await obtainLease();

    // The SDK's own handshake is the JSON-response proof: it completed above and
    // completes here without ever being handed an SSE stream or a session id.
    const initialize = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
      }),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get('Content-Type')).toBe('application/json');
    expect(initialize.headers.get('Mcp-Session-Id')).toBeNull();

    const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);

    // And an unauthenticated caller is handed the RFC 9728 discovery chain,
    // not a JSON scolding it cannot parse.
    const bare = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(bare.status).toBe(401);
    expect(bare.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
  }, 120_000);
});
