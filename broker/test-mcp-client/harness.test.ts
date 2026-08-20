// The acceptance harness: the *official* MCP SDK, as a client, driving a
// deployed-shape worker. Everything the gate's own suite proves in pieces —
// DCR, PKCE, the consent, the code exchange, the pin, the reads, the sitting,
// the latch, the parts, the stream verbs — is walked here end to end, over real
// sockets, by software that did not read our code.
//
// The SDK appears only here, and only as a client (spec §7): the `/mcp` face
// itself stays hand-rolled. A failure in this file is a protocol or flow defect
// to fix in the worker, not an assertion to soften — unless the assertion
// contradicts the merged wire truth, in which case the harness is what is wrong.
//
// The legs below are ORDERED, and deliberately so: the pin moves twice across
// this file (§9's drift is not something you can stage in isolation), so a leg
// reads the ground the leg before it left behind. `describe` blocks and tests
// run in declaration order, and `vitest.node.config.ts` pins one fork and no
// file parallelism, so that order is the run.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import { INTERNAL_READ_PREFIX, SYNC_READ_SECRET_HEADER } from 'julian-shared/gate-contract';
import type { InternalReadRequest, InternalReadResponse, StreamRow } from 'julian-shared/gate-contract';
import { csrfFor, mintSession } from '../src/as/session';
import { PART_TARGET_BYTES } from '../src/package-types';
import { LONG_PATH, startFixture } from './fixture-content';

const SESSION_SECRET = 'harness-secret';
const APPROVER = 'harness-approver-sub';
const BREAKGLASS = 'harness-breakglass';
/** A loopback callback, as an MCP client registers one (RFC 8252). */
const CALLBACK = 'http://127.0.0.1:9999/cb';
/**
 * The door name the register derives for every authcode lease in this file —
 * `visit:<origin-host>` off the pending's own redirect_uri (registrar.ts). It
 * is the same name for every knock here, which is the point: one visit door,
 * re-elected at whatever scope the desk grants that time.
 */
const VISIT_DOOR = `visit:${new URL(CALLBACK).host}`;
/** The client's own CSRF value; the gate must echo it back untouched. */
const CLIENT_STATE = 'h1';
/** The ELF waking order the wake-julian text prescribes. */
const ELF_ORDER = ['AGENT.md', 'catalog.md', 'soul/01-naming.md', 'memory/dreams/0001.md'];
/** Every path the fixture's manifest carries, in manifest (sorted) order. */
const PACKAGE_PATHS = [
  'AGENT.md', 'catalog.md', 'memory/dreams/0001.md', LONG_PATH, 'soul/01-naming.md',
];
/** The narrow scope an MCP visit elects by default; the house is never on the ballot. */
const SCOPE = 'reading-room';
/** The wider visit scope — the one that buys the stream verbs (spec §5). */
const STREAM_SCOPE = 'stream-read';

// The browser door (spec §11): a Pocket ID session traded at `/exchange` for a
// `flow='exchange'` lease. It is the only lease in this file that is *not*
// shared, which is why the sitting, the latch and the parts legs are driven
// through it — a shared `visit:` lease deliberately holds no sitting to move.
const OIDC_ISSUER = 'https://pocket.harness.test';
const OIDC_AUDIENCE = 'harness-audience';
const STREAM_SUB = 'harness-stream-sub';
const PRINCIPAL = 'julian';
const SYNC_READ_SECRET = 'harness-sync-read-secret';

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let fixture: Awaited<ReturnType<typeof startFixture>>;
let base: string;
let signingKey: CryptoKey;

// ── the scripted sync worker ────────────────────────────────────────────────

interface SyncCall { path: string; secret: string | null; body: InternalReadRequest }

/** Every internal read the gate actually made, in order. */
const syncCalls: SyncCall[] = [];
/** What the far side answers next. `null` is "the store could not be reached". */
let syncReply: InternalReadResponse | null = null;

/**
 * The service-binding stub of spec §8: it asserts nothing itself, it *records*
 * the `InternalReadRequest` the gate built and replays a scripted
 * `InternalReadResponse` — both shapes imported from `julian-shared/gate-contract`,
 * the same seam sync's own suite builds against. This is the cross-worker
 * request-shape fixture, driven here through a real worker rather than a stub
 * env, so `unstable_startWorker`'s service-binding scripting needs no waiver.
 */
async function syncFetcher(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const secret = request.headers.get(SYNC_READ_SECRET_HEADER);
  let body: InternalReadRequest;
  try {
    body = await request.json() as InternalReadRequest;
  } catch {
    body = {} as InternalReadRequest;
  }
  syncCalls.push({ path, secret, body });
  if (!path.startsWith(INTERNAL_READ_PREFIX)) {
    return new Response('sync stub: the gate reached a route that is not an internal read', { status: 404 });
  }
  // Bodiless 403 on a bad secret, first statement — the same refusal the real
  // sync router owes (spec §8).
  if (secret !== SYNC_READ_SECRET) return new Response(null, { status: 403 });
  if (syncReply === null) return new Response('sync stub: the store is unreachable', { status: 500 });
  return new Response(JSON.stringify(syncReply), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

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

  // A local Pocket ID: one RS256 key, its public half served to the gate as the
  // inline-JWKS test seam, so `/exchange` verifies a real signature against a
  // real key set and the run still never leaves the loopback.
  const pair = await generateKeyPair('RS256', { extractable: true });
  signingKey = pair.privateKey as CryptoKey;
  const jwk = await exportJWK(pair.publicKey);
  const jwks = JSON.stringify({ keys: [{ ...jwk, kid: 'harness', alg: 'RS256', use: 'sig' }] });

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
      // The browser door's configuration. `OIDC_JWKS_JSON` is the documented
      // test seam (env.ts): a local key set instead of a remote fetch.
      OIDC_ISSUER: { type: 'plain_text', value: OIDC_ISSUER },
      OIDC_AUDIENCE: { type: 'plain_text', value: OIDC_AUDIENCE },
      OIDC_JWKS_JSON: { type: 'plain_text', value: jwks },
      STREAM_SUBS: { type: 'plain_text', value: `${STREAM_SUB}=${PRINCIPAL}` },
      SYNC_READ_SECRET: { type: 'plain_text', value: SYNC_READ_SECRET },
      // `wrangler.toml` binds SYNC to the *deployed* julian-sync worker, which
      // does not exist beside a lone `unstable_startWorker` run — workerd
      // refuses to start on the dangling service reference. Bind the scripted
      // stub above instead: the stream verbs are driven through it, and any
      // route the face reaches that is not an internal read is a loud 404
      // rather than a silent trip to the real stream.
      SYNC: { type: 'fetcher', fetcher: syncFetcher },
    } as Parameters<typeof unstable_startWorker>[0]['bindings'],
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

// ── the knock, in pieces (so both delivery arms can be driven) ───────────────

/** Dynamic client registration (RFC 7591): a public client, loopback callback. */
async function registerClient(): Promise<string> {
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
  });
  expect(reg.status).toBe(201);
  const { client_id: clientId } = await reg.json() as { client_id: string };
  return clientId;
}

/**
 * PKCE + /authorize. The pending id comes back in an HttpOnly cookie — never a
 * query param — so it is read off Set-Cookie, exactly as a browser would.
 */
async function authorizePending(clientId: string, challenge: string): Promise<string> {
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
  return setCookieValue(authRes, 'gate_pending');
}

/**
 * The approval desk. The harness holds the gate's own SESSION_SECRET, so it can
 * mint the approver session Pocket ID would otherwise mint, and the CSRF token
 * bound to this session and this exact pending. Returns the delivery redirect.
 */
async function confirmPending(
  pendingId: string, decision: 'open' | 'refuse', scope: string,
): Promise<URL> {
  const session = await mintSession(APPROVER, SESSION_SECRET);
  const csrf = await csrfFor(session, pendingId, SESSION_SECRET);
  const body = new URLSearchParams({ csrf, decision, scope });
  // The wider scope takes a second, explicit confirmation at the desk.
  if (scope === STREAM_SCOPE) body.set('stream_confirm', 'yes');
  const confirm = await fetch(`${base}/approve/confirm`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `gate_session=${session}; gate_pending=${pendingId}`,
    },
    body,
  });
  expect(confirm.status).toBe(302);
  return new URL(confirm.headers.get('Location') ?? '');
}

/** The full B1 knock, scripted: DCR → authorize → approve → token. */
async function obtainLease(scope: string = SCOPE): Promise<string> {
  const clientId = await registerClient();
  const verifier = 'v'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const pendingId = await authorizePending(clientId, challenge);
  const delivered = await confirmPending(pendingId, 'open', scope);
  // RFC 6749 §4.1.2: the code lands at the client's own callback, state echoed.
  expect(delivered.origin + delivered.pathname).toBe(CALLBACK);
  expect(delivered.searchParams.get('state')).toBe(CLIENT_STATE);
  const code = delivered.searchParams.get('code');
  expect(code).toBeTruthy();

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
  expect(granted.scope).toBe(scope);
  return granted.access_token;
}

// ── the browser door ────────────────────────────────────────────────────────

/** A Pocket ID session token, signed by the harness's own local issuer. */
async function pocketIdToken(sub: string = STREAM_SUB): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'harness' })
    .setIssuer(OIDC_ISSUER)
    .setAudience(OIDC_AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey);
}

/**
 * One `flow='exchange'` lease for the whole run. The sitting pin and the latch
 * live on the lease row, not the token, so re-minting would be harmless — but
 * one session keeps the session cap out of the story entirely.
 */
let sessionAccess: string | null = null;
async function sessionToken(): Promise<string> {
  if (sessionAccess) return sessionAccess;
  const res = await fetch(`${base}/exchange`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await pocketIdToken()}` },
  });
  expect(res.status).toBe(200);
  const granted = await res.json() as { access_token: string; scope: string; expires_in: number };
  expect(granted.scope).toBe('stream');
  expect(granted.expires_in).toBe(3600);
  expect(granted.access_token.startsWith('jla_')).toBe(true);
  sessionAccess = granted.access_token;
  return sessionAccess;
}

// ── driving the face ────────────────────────────────────────────────────────

/** The SDK client, connected over streamable HTTP with the lease in hand. */
async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'harness', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** A raw JSON-RPC message, sent as a client that never handshook would send it. */
async function rawRpc(
  token: string, message: unknown, extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...extraHeaders,
    },
    body: JSON.stringify(message),
  });
}

interface RpcEnvelope {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rawResult(token: string, message: unknown): Promise<RpcEnvelope> {
  const res = await rawRpc(token, message);
  expect(res.status).toBe(200);
  return await res.json() as RpcEnvelope;
}

interface TextBlock { type: 'text'; text: string }

function textOf(result: unknown, index = 0): string {
  const blocks = (result as { content: TextBlock[] }).content;
  return blocks[index].text;
}

interface ReadShape {
  class: string; path?: string; message?: string; pinSha: string | null;
  sha256?: string; bytes?: number; content?: string;
  part?: number; parts?: number; partBytes?: number; partSha256?: string; fileSha256?: string;
}

function readShape(result: { structuredContent?: unknown }): ReadShape {
  return result.structuredContent as ReadShape;
}

function sha256Of(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

async function pinBumpTo(sha: string): Promise<void> {
  const bump = await fetch(`${base}/pin-bump`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Breakglass-Secret': BREAKGLASS },
    body: new URLSearchParams({ sha }),
  });
  expect(bump.status).toBe(200);
  expect(await bump.json()).toEqual({ pinned: sha });
}

// ── reading the register's own pen ──────────────────────────────────────────

interface LedgerRow {
  ts: number; sub: string; service: string; verb: string; detail: string; allowed: number;
}
/** One row, stripped of the two fields a run cannot predict (clock, args hmac). */
interface LedgerFace { sub: string; service: string; verb: string; allowed: number }

/** How deep a readout goes. The whole harness run writes well under this. */
const LEDGER_LIMIT = 200;

/**
 * `GET /ledger`, through the same breakglass credential `/pin-bump` uses — the
 * ledger is a register action, gated exactly like `/leases` (as/admin.ts). Rows
 * come back newest-first.
 */
async function ledgerRows(): Promise<LedgerRow[]> {
  const res = await fetch(`${base}/ledger?limit=${LEDGER_LIMIT}`, {
    headers: { 'X-Breakglass-Secret': BREAKGLASS },
  });
  expect(res.status).toBe(200);
  const { entries } = await res.json() as { entries: LedgerRow[] };
  return entries;
}

/**
 * The rows written between two readouts. The ledger only grows and reads
 * newest-first, so what is new is the prefix sitting ahead of the earlier
 * snapshot — and the suffix is re-asserted equal to that snapshot, so a
 * saturated window fails loud instead of quietly re-labelling old rows as new.
 */
function ledgerSince(before: LedgerRow[], after: LedgerRow[]): LedgerRow[] {
  expect(after.length).toBeLessThan(LEDGER_LIMIT);
  const added = after.length - before.length;
  expect(added).toBeGreaterThanOrEqual(0);
  expect(after.slice(added)).toEqual(before);
  return after.slice(0, added);
}

function ledgerFaces(rows: LedgerRow[]): LedgerFace[] {
  return rows.map(({ sub, service, verb, allowed }) => ({ sub, service, verb, allowed }));
}

/** The lease id the register holds for one door name. */
async function leaseIdOf(doorName: string): Promise<string> {
  const res = await fetch(`${base}/leases`, { headers: { 'X-Breakglass-Secret': BREAKGLASS } });
  expect(res.status).toBe(200);
  const { leases } = await res.json() as { leases: Array<{ leaseId: string; doorName: string }> };
  const row = leases.find((l) => l.doorName === doorName);
  expect(row, `no ${doorName} lease in the register`).toBeDefined();
  return row!.leaseId;
}

/** `package_list` through a real client, returning the manifest it seats on. */
async function listPackage(client: Client): Promise<{
  pinSha: string; files: Array<{ path: string; sha256: string; bytes: number }>;
}> {
  const listed = await client.callTool({ name: 'package_list', arguments: {} });
  expect(listed.isError ?? false).toBe(false);
  const sc = listed.structuredContent as {
    manifest: { files: Array<{ path: string; sha256: string; bytes: number }> }; pinSha: string;
  };
  return { pinSha: sc.pinSha, files: sc.manifest.files };
}

describe('a real MCP client against the gate', () => {
  test('the whole flow: pin-bump, connect, wake, ordered verified reads, broken-pin stop', async () => {
    // Pin via the register (breakglass), against the fixture server.
    await pinBumpTo(fixture.sha);

    const token = await obtainLease();
    const client = await connect(token);

    // Scope-filtered listing: a reading room, not a wall of refused teases.
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['package_list', 'package_read', 'visit_agent', 'wake_julian']);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['wake-julian']);

    // wake-julian leads with the category line.
    const wake = await client.callTool({ name: 'wake_julian', arguments: {} });
    expect(textOf(wake)).toMatch(/^You are a visit/);

    // The manifest enumerates exactly what travels, at the pin we just set.
    const manifest = await listPackage(client);
    expect(manifest.pinSha).toBe(fixture.sha);
    expect(manifest.files.map((f) => f.path)).toEqual(PACKAGE_PATHS);

    // Ordered, manifest-verified reads (ELF order).
    for (const path of ELF_ORDER) {
      const r = await client.callTool({ name: 'package_read', arguments: { path } });
      expect(r.isError ?? false).toBe(false);
      const sc = readShape(r);
      expect(sc.class).toBe('ok');
      expect(sc.path).toBe(path);
      expect(sc.pinSha).toBe(fixture.sha);
      expect(sha256Of(textOf(r, 1))).toBe(sc.sha256); // bytes block; header rides at [0] (#41)
      // The live-probe lesson (Aug 12): a client may render structuredContent as
      // THE result — it must carry the body itself, hash-verifiable on its own.
      expect(sha256Of(sc.content ?? '')).toBe(sc.sha256);
    }

    // A catalog artifact the manifest does not carry is a *refusal*, not damage:
    // held-at-home is typed, and never wears the integrity-error class.
    const home = await client.callTool({ name: 'package_read', arguments: { path: 'memory/held-at-home.md' } });
    expect(home.isError ?? false).toBe(false);
    expect(readShape(home).class).toBe('held-at-home');

    // Broken pin: corrupt a file behind the same manifest → fail loud, pin named.
    fixture.corrupt('catalog.md');
    const broken = await client.callTool({ name: 'package_read', arguments: { path: 'catalog.md' } });
    expect(broken.isError).toBe(true);
    expect(textOf(broken)).toContain(fixture.sha);
    expect(readShape(broken).class).toBe('integrity');
    // A truncation-shaped lie is loud but never latching: this visit lease is a
    // shared one, and the file goes back where it was for the legs that follow.
    fixture.heal('catalog.md');

    // The visit's body round-trips through a real client, both hands.
    for (const access of ['read-only', 'read-write'] as const) {
      const va = await client.callTool({ name: 'visit_agent', arguments: { access } });
      expect(va.isError ?? false).toBe(false);
      const sc = va.structuredContent as { access: string; name: string; content: string };
      expect(sc.name).toBe('julian');
      expect(sc.access).toBe(access);
      expect(sc.content).toContain('model: fable');
      // The read-write visit has no shell (§10.1 R-6): Bash left the grant,
      // so the differentiator is Edit, present only on the read-write hand.
      expect(sc.content).toContain(access === 'read-write' ? 'Edit' : 'mcp__julian-gate');
      expect(sc.content).not.toContain('Bash');
    }

    await client.close();
  }, 120_000);

  test('the wire contract: JSON only, GET refused, no session ever issued', async () => {
    const token = await obtainLease();

    // The SDK's own handshake is the JSON-response proof: it completed above and
    // completes here without ever being handed an SSE stream or a session id.
    const initialize = await rawRpc(token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
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

// ── the protocol pins (spec §7) ─────────────────────────────────────────────

describe('the protocol pins', () => {
  test('ping is exactly {}, an id-less message is a bodiless 202, a batch is refused', async () => {
    const token = await obtainLease();
    const client = await connect(token);

    // `EmptyResultSchema` is strict: a `ping` result carrying anything at all —
    // a cache hint included — would fail inside the SDK, not in this assertion.
    expect(await client.ping()).toEqual({});
    await client.close();

    // A JSON-RPC Notification is a request object with no `id`: 202, no body,
    // whatever it names as its method.
    for (const method of ['notifications/initialized', 'tools/list', 'no/such/method']) {
      const res = await rawRpc(token, { jsonrpc: '2.0', method });
      expect(res.status).toBe(202);
      expect(await res.text()).toBe('');
    }

    // One message per request. A batch has no single id to answer under, so the
    // refusal is anonymous.
    const batch = await rawRpc(token, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);
    expect(batch.status).toBe(200);
    const refused = await batch.json() as RpcEnvelope;
    expect(refused.id).toBeNull();
    expect(refused.error?.code).toBe(-32600);
    expect(refused.error?.message).toContain('never a batch');
  }, 120_000);

  test('a raw handshake-less v2-shaped envelope is served exactly like any other call', async () => {
    const token = await obtainLease();
    const res = await rawRpc(token, {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: {
        name: 'package_list',
        arguments: {},
        _meta: { protocolVersion: '2024-11-05', 'some.unknown/field': true },
      },
      someUnknownTopLevelField: 'ignored',
    }, {
      'MCP-Protocol-Version': '2024-11-05',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'package_list',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as RpcEnvelope;
    const result = body.result as { content: TextBlock[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.split('\n')[0]).toBe(
      `${PACKAGE_PATHS.length} files at pin ${fixture.sha}`,
    );
  }, 120_000);

  test('the cache hint rides tools/list and prompts/list, and nothing else', async () => {
    const token = await obtainLease();
    const hint = { 'io.modelcontextprotocol/cacheControl': { ttlMs: 300_000 } };

    const tools = await rawResult(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(tools.result?._meta).toEqual(hint);
    const prompts = await rawResult(token, { jsonrpc: '2.0', id: 2, method: 'prompts/list' });
    expect(prompts.result?._meta).toEqual(hint);

    // ping stays exactly `{}`; a package URI carries no pin, so a client
    // honoring a ttl on the resource results would cache content across a pin
    // bump — silent drift the sitting pin cannot see.
    const ping = await rawResult(token, { jsonrpc: '2.0', id: 3, method: 'ping' });
    expect(ping.result).toEqual({});
    const resources = await rawResult(token, { jsonrpc: '2.0', id: 4, method: 'resources/list' });
    expect(resources.result?._meta).toBeUndefined();
    const read = await rawResult(token, {
      jsonrpc: '2.0', id: 5, method: 'resources/read',
      params: { uri: 'julian://package/AGENT.md' },
    });
    expect(read.result?._meta).toBeUndefined();
  }, 120_000);

  test('RFC 9207: iss rides both delivery arms, byte-identical to the discovery issuer', async () => {
    const discovery = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(discovery.status).toBe(200);
    const meta = await discovery.json() as { issuer: string; authorization_response_iss_parameter_supported: boolean };
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);

    const challenge = createHash('sha256').update('v'.repeat(64)).digest('base64url');

    const granted = await confirmPending(
      await authorizePending(await registerClient(), challenge), 'open', SCOPE,
    );
    expect(granted.searchParams.get('code')).toBeTruthy();
    expect(granted.searchParams.get('iss')).toBe(meta.issuer);

    const denied = await confirmPending(
      await authorizePending(await registerClient(), challenge), 'refuse', SCOPE,
    );
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('iss')).toBe(meta.issuer);
  }, 120_000);
});

// ── the sitting, the latch, the parts (spec §9) ─────────────────────────────
//
// All three are driven through the browser door: a `flow='exchange'` lease is
// the one lease in this file that is not shared, and only an unshared lease
// holds a sitting to move or a latch to trip.

describe('the sitting pin, through a real client', () => {
  test('the pin drifts mid-sitting: refused by name, reset by package_list, resumed', async () => {
    const client = await connect(await sessionToken());
    const opened = fixture.sha;

    // The listing IS the reset act: it seats this lease on the pin it just read.
    const seated = await listPackage(client);
    expect(seated.pinSha).toBe(opened);
    const before = await client.callTool({ name: 'package_read', arguments: { path: 'AGENT.md' } });
    expect(before.isError ?? false).toBe(false);
    expect(readShape(before).pinSha).toBe(opened);

    // The ground moves under the reader.
    const moved = fixture.bump();
    expect(moved).not.toBe(opened);
    await pinBumpTo(moved);

    const refused = await client.callTool({ name: 'package_read', arguments: { path: 'AGENT.md' } });
    expect(refused.isError).toBe(true);
    expect(readShape(refused)).toEqual({
      class: 'pin-moved', pinSha: moved,
      message: `pin moved ${opened.slice(0, 12)} → ${moved.slice(0, 12)}; run package_list, then re-read from the top`,
    });
    // The refusal says what died and what to do, in the text half too.
    expect(textOf(refused)).toContain('run package_list');

    // The named act, and only it, gets the reader unstuck.
    const reseated = await listPackage(client);
    expect(reseated.pinSha).toBe(moved);
    const after = await client.callTool({ name: 'package_read', arguments: { path: 'AGENT.md' } });
    expect(after.isError ?? false).toBe(false);
    expect(readShape(after).pinSha).toBe(moved);
    expect(readShape(after).content).toBe(fixture.original('AGENT.md'));

    // The caller's own cross-check is a second, independent way to be told:
    // it names the pin it believed in and is answered the same way.
    const stale = await client.callTool({
      name: 'package_read', arguments: { path: 'AGENT.md', expect_pin: opened },
    });
    expect(stale.isError).toBe(true);
    expect(readShape(stale).class).toBe('pin-moved');
    expect(String(readShape(stale).message)).toContain('run package_list');

    await client.close();
  }, 120_000);
});

describe('the integrity latch, through a real client', () => {
  test('a length-preserved lie latches the lease, and a clean read of the same pair clears it', async () => {
    const client = await connect(await sessionToken());
    const pin = (await listPackage(client)).pinSha;
    expect(pin).toBe(fixture.sha);

    const poisoned = 'soul/01-naming.md';
    const healthy = 'AGENT.md';
    fixture.poison(poisoned);
    const servedBefore = fixture.hits(poisoned);

    const damaged = await client.callTool({ name: 'package_read', arguments: { path: poisoned } });
    expect(damaged.isError).toBe(true);
    expect(readShape(damaged).class).toBe('integrity');
    // The double-check is not an assertion about the code — the content root
    // counted two deliveries, so the `cacheTtl: 0` refetch demonstrably happened.
    expect(fixture.hits(poisoned) - servedBefore).toBe(2);
    expect(String(readShape(damaged).message)).toContain('latched');
    expect(String(readShape(damaged).message)).toContain(poisoned);
    expect(textOf(damaged)).toContain('latched');

    // Every other file is now refused before any fetch — that is the point of a
    // latch: one unexplained byte stops the reading, it does not warn about it.
    const healthyHits = fixture.hits(healthy);
    const blocked = await client.callTool({ name: 'package_read', arguments: { path: healthy } });
    expect(blocked.isError).toBe(true);
    expect(readShape(blocked)).toEqual({
      class: 'integrity-latched', pinSha: pin,
      message: `package reads are latched for this lease after an unresolved hash mismatch on ${poisoned}; a clean read of that same file at pin ${pin} clears it`,
    });
    expect(fixture.hits(healthy)).toBe(healthyHits);

    // Only a clean read of the very pair that latched clears it.
    fixture.heal(poisoned);
    const cleared = await client.callTool({ name: 'package_read', arguments: { path: poisoned } });
    expect(cleared.isError ?? false).toBe(false);
    expect(readShape(cleared).content).toBe(fixture.original(poisoned));
    const resumed = await client.callTool({ name: 'package_read', arguments: { path: healthy } });
    expect(resumed.isError ?? false).toBe(false);
    expect(readShape(resumed).content).toBe(fixture.original(healthy));

    await client.close();
  }, 120_000);
});

describe('the parts, through a real client', () => {
  test('a long file is an instruction, not damage: 1…M concatenate to the original', async () => {
    const client = await connect(await sessionToken());
    const listed = await listPackage(client);
    const pin = listed.pinSha;
    const entry = listed.files.find((f) => f.path === LONG_PATH);
    expect(entry).toBeDefined();
    expect(entry!.bytes).toBeGreaterThan(32_768);

    // A whole read of a parted file is the typed instruction — M is the
    // server's arithmetic, and the refusal names it.
    const whole = await client.callTool({ name: 'package_read', arguments: { path: LONG_PATH } });
    expect(whole.isError).toBe(true);
    const instruction = readShape(whole);
    expect(instruction.class).toBe('parts');
    expect(instruction.pinSha).toBe(pin);
    const count = instruction.parts as number;
    expect(count).toBeGreaterThan(1);
    expect(String(instruction.message)).toBe(
      `this file serves in ${count} parts; request part 1…${count} and verify every part carries the same fileSha256`,
    );

    let rebuilt = '';
    for (let part = 1; part <= count; part++) {
      const r = await client.callTool({ name: 'package_read', arguments: { path: LONG_PATH, part } });
      expect(r.isError ?? false).toBe(false);
      const sc = readShape(r);
      expect(sc.class).toBe('ok');
      expect(sc.part).toBe(part);
      expect(sc.parts).toBe(count);
      // `sha256`/`bytes` keep naming the WHOLE file; `fileSha256` restates it
      // under the name the wake text tells a reader to compare across parts.
      expect(sc.sha256).toBe(entry!.sha256);
      expect(sc.bytes).toBe(entry!.bytes);
      expect(sc.fileSha256).toBe(entry!.sha256);
      const chunk = sc.content ?? '';
      const chunkBytes = Buffer.from(chunk, 'utf8');
      expect(sc.partBytes).toBe(chunkBytes.byteLength);
      expect(chunkBytes.byteLength).toBeLessThanOrEqual(PART_TARGET_BYTES);
      expect(sc.partSha256).toBe(createHash('sha256').update(chunkBytes).digest('hex'));
      // The header block above the body carries the same proof for a client
      // that renders only text.
      expect(textOf(r, 0)).toContain(`part ${part} of ${count}`);
      expect(textOf(r, 0)).toContain(entry!.sha256);
      expect(textOf(r, 1)).toBe(chunk);
      rebuilt += chunk;
    }
    // Codepoint-safe: the concatenation is the original, byte for byte.
    expect(rebuilt).toBe(fixture.original(LONG_PATH));
    expect(sha256Of(rebuilt)).toBe(entry!.sha256);

    // A part asked at a pin that has since moved is its own class — a reader
    // mid-file must not be told the same thing as a reader between files.
    const moved = fixture.bump();
    await pinBumpTo(moved);
    const drifted = await client.callTool({ name: 'package_read', arguments: { path: LONG_PATH, part: 1 } });
    expect(drifted.isError).toBe(true);
    expect(readShape(drifted)).toEqual({
      class: 'part-pin-moved', pinSha: moved,
      message: `pin moved ${pin.slice(0, 12)} → ${moved.slice(0, 12)}; run package_list, then re-read from the top`,
    });

    await client.close();
  }, 120_000);
});

// ── the stream verbs (spec §8, §14) ─────────────────────────────────────────

const ROWS: StreamRow[] = [
  { id: 'r1', sessionId: 's-1', role: 'user', speakerName: 'Marcus', text: 'are you there', ts: 1, kind: 'text' },
  { id: 'r2', sessionId: 's-1', role: 'assistant', speakerName: 'Julian', text: 'I am', ts: 2, kind: 'text' },
];

describe('the stream verbs, through a real client', () => {
  test('a stream-read lease drives recent/session/search, and the wire shape is the contract', async () => {
    const token = await obtainLease(STREAM_SCOPE);
    const client = await connect(token);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'package_list', 'package_read', 'stream_recent', 'stream_search', 'stream_session',
      'visit_agent', 'wake_julian',
    ]);

    syncCalls.length = 0;
    syncReply = { ok: true, rows: ROWS, truncated: false };
    const ledgerBefore = await ledgerRows();
    const recent = await client.callTool({ name: 'stream_recent', arguments: { limit: 5 } });
    expect(recent.isError ?? false).toBe(false);
    expect(recent.structuredContent).toEqual({ rows: ROWS, truncated: false });
    expect(textOf(recent)).toBe('[1] Marcus: are you there\n[2] Julian: I am');

    syncReply = { ok: true, rows: [ROWS[0]], truncated: true };
    const session = await client.callTool({
      name: 'stream_session', arguments: { sessionId: 's-1', range: { from: 10, to: 20 } },
    });
    expect(session.isError ?? false).toBe(false);
    expect(session.structuredContent).toEqual({ rows: [ROWS[0]], truncated: true });
    expect(textOf(session)).toContain('(truncated');

    syncReply = { ok: true, rows: [], truncated: false };
    const search = await client.callTool({ name: 'stream_search', arguments: { query: 'door', limit: 3 } });
    expect(search.isError ?? false).toBe(false);
    expect(search.structuredContent).toEqual({ rows: [], truncated: false });
    expect(textOf(search)).toBe('(no rows)');

    // The seam both workers assert: the path per verb, the shared secret in its
    // own header, the caller's own principal, and nothing the caller sent that
    // could name another.
    expect(syncCalls.map((c) => c.path)).toEqual([
      `${INTERNAL_READ_PREFIX}recent`, `${INTERNAL_READ_PREFIX}session`, `${INTERNAL_READ_PREFIX}search`,
    ]);
    expect(syncCalls.map((c) => c.secret)).toEqual([SYNC_READ_SECRET, SYNC_READ_SECRET, SYNC_READ_SECRET]);
    expect(syncCalls.map((c) => c.body)).toEqual([
      { principal: PRINCIPAL, limit: 5 },
      { principal: PRINCIPAL, sessionId: 's-1', from: 10, to: 20 },
      { principal: PRINCIPAL, query: 'door', limit: 3 },
    ]);

    // A store that cannot be reached is a refusal, never an empty result.
    syncReply = null;
    const dead = await client.callTool({ name: 'stream_recent', arguments: {} });
    expect(dead.isError).toBe(true);
    expect(textOf(dead)).toBe(
      'stream unavailable — the stream could not be read; this is a refusal, not an empty result',
    );

    // The pen, read back through the register. `reserve` runs before the SYNC
    // binding is ever touched, so the reservation — not the answer — is what
    // lands: the unreachable-store call above is a row too, allowed, because the
    // gate did let it through and the far side is what failed.
    const visitLease = await leaseIdOf(VISIT_DOOR);
    const wrote = ledgerSince(ledgerBefore, await ledgerRows());
    const face = { sub: `lease:${visitLease}`, service: 'stream', allowed: 1 };
    expect(ledgerFaces(wrote)).toEqual([
      { ...face, verb: 'recent' },  // the store-unreachable call, newest first
      { ...face, verb: 'search' },
      { ...face, verb: 'session' },
      { ...face, verb: 'recent' },
    ]);
    // Every row names the door from the REGISTER (never a request body) and the
    // caller's own principal; the args ride as an hmac, so the session the
    // caller named is nowhere in the register's text in the clear.
    for (const row of wrote) {
      expect(row.detail).toMatch(
        new RegExp(`^door=${VISIT_DOOR.replace(/\./g, '\\.')} principal=${PRINCIPAL} args=[0-9a-f]{12}$`),
      );
      expect(row.detail).not.toContain('s-1');
    }

    await client.close();
  }, 120_000);

  // STATED DIVERGENCE from task 25, leg 5 — "a `reading-room` lease is refused
  // with ledger rows". The merged wire truth is narrower, and this suite records
  // it rather than asserting a row that is never written:
  //
  //   `tools/call` resolves the tool name against `visibleTools(auth.scope)` and
  //   answers -32602 *before* any `reserve()` runs (broker/src/mcp.ts), so an
  //   out-of-scope stream verb on a reading-room lease writes NO ledger row at
  //   all. `reserve` does keep the denied pen — it ledgers `refused: scope …`
  //   (lease-auth.ts) — but only for a verb the scope can see; an invisible one
  //   never reaches that pen. That is the design the harness above already
  //   names: a reading room LACKS the verb rather than dangling it behind a
  //   refusal, and a tease that got ledgered would be the tease the design
  //   refuses to serve.
  //
  // The criterion is therefore discharged as evidence, not as prose: the same
  // `GET /ledger` readout that proved four rows for the stream-read lease above
  // proves exactly zero for this one, through the same credential, across the
  // same seam. Both halves of the comparison come from the register itself.
  test('a reading-room lease has no stream verbs at all — an absence the ledger confirms', async () => {
    // The same `visit:` door, re-elected narrower: the scope a visit carries is
    // decided at the desk each time, and the previous election does not linger.
    const token = await obtainLease(SCOPE);
    const client = await connect(token);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort())
      .toEqual(['package_list', 'package_read', 'visit_agent', 'wake_julian']);
    await client.close();

    syncCalls.length = 0;
    syncReply = { ok: true, rows: ROWS, truncated: false };
    const ledgerBefore = await ledgerRows();
    const refused = await rawResult(token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'stream_recent', arguments: { limit: 5 } },
    });
    expect(refused.error?.code).toBe(-32602);
    expect(refused.error?.message).toBe('unknown tool: stream_recent');
    // Nothing reached the stream: an invisible tool never causes a read.
    expect(syncCalls).toEqual([]);
    // And nothing reached the register either. The absence is total, and it is
    // read back from the same pen that recorded the stream-read lease's work —
    // so this is a measured zero, not an untested silence.
    expect(ledgerSince(ledgerBefore, await ledgerRows())).toEqual([]);
  }, 120_000);
});

describe('text-only verifiability (#41), through a real client', () => {
  test('a text-only reading verifies a whole file from the listing and header lines alone', async () => {
    const client = await connect(await sessionToken());

    // The listing's text half alone carries the anchor: full pin, then hashes.
    const listed = await client.callTool({ name: 'package_list', arguments: {} });
    expect(listed.isError ?? false).toBe(false);
    const lines = textOf(listed).split('\n');
    const sc = listed.structuredContent as {
      pinSha: string; manifest: { files: Array<{ path: string; sha256: string }> };
    };
    expect(lines[0]).toBe(`${sc.manifest.files.length} files at pin ${sc.pinSha}`);
    const entryLine = lines.find((l) => l.startsWith('AGENT.md '));
    expect(entryLine).toBeDefined();
    const listedSha = entryLine!.split(' ')[1];

    // The read's text half alone agrees with the listing, and the bytes hash to it.
    const read = await client.callTool({ name: 'package_read', arguments: { path: 'AGENT.md' } });
    expect(read.isError ?? false).toBe(false);
    expect(textOf(read, 0)).toContain(`sha256 ${listedSha}`);
    expect(sha256Of(textOf(read, 1))).toBe(listedSha);
  }, 120_000);
});
