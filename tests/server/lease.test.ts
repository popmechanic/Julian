import { afterEach, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLeaseFile, startLeaseHolder } from '../../server/lease';

// A fixed clock: every holder gets `now` injected, so "20 minutes left" means
// exactly that no matter how long the test takes to schedule.
const T0 = 1_800_000_000_000;
const MIN = 60_000;

// ── Test fixtures ─────────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    const fn = cleanups.pop()!;
    try { fn(); } catch { /* a stopped server stopping twice is not a failure */ }
  }
});

interface GateHit {
  grant_type: string;
  refresh_token: string;
  contentType: string;
}

interface GateStub {
  url: string;
  hits: GateHit[];
  fail: (on: boolean) => void;
}

// The gate's `POST /token` refresh face, stubbed on a loopback ephemeral port.
// Tokens are obviously fake (`jla_TEST…`) — no fixture ever carries a secret.
function makeGate(opts: { failing?: boolean; delayMs?: number } = {}): GateStub {
  let failing = opts.failing ?? false;
  let minted = 0;
  const hits: GateHit[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/token' || req.method !== 'POST') {
        return Response.json({ error: 'unexpected request' }, { status: 404 });
      }
      const form = new URLSearchParams(await req.text());
      hits.push({
        grant_type: form.get('grant_type') ?? '',
        refresh_token: form.get('refresh_token') ?? '',
        contentType: req.headers.get('content-type') ?? '',
      });
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      if (failing) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
      minted += 1;
      return Response.json({
        access_token: `jla_TESTNEW${minted}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `jlr_TESTNEW${minted}`,
        scope: 'full-house',
      });
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    hits,
    fail: (on: boolean) => { failing = on; },
  };
}

function seedLease(extra: Record<string, unknown> = {}): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'julian-lease-'));
  const path = join(dir, 'gate-lease.json');
  const record = {
    door_name: 'mac-studio',
    scope: 'full-house',
    refresh_token: 'jlr_TESTSEED',
    access_token: 'jla_TESTSEED',
    access_expires: T0 + 20 * MIN,
    ...extra,
  };
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { dir, path };
}

async function startHolder(opts: Parameters<typeof startLeaseHolder>[0]) {
  const holder = await startLeaseHolder(opts);
  cleanups.push(() => holder.stop());
  return holder;
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

// A raw HTTP/1.1 request, because `fetch` refuses to set the Host header and
// the mint's DNS-rebinding guard is a Host check.
function rawGet(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    sock.setTimeout(3000, () => { sock.destroy(); reject(new Error('raw request timed out')); });
    sock.on('data', (chunk) => { raw += chunk.toString(); });
    sock.on('error', reject);
    sock.on('close', () => {
      const status = Number(raw.split(' ')[1]);
      const idx = raw.indexOf('\r\n\r\n');
      resolve({ status, body: idx === -1 ? '' : raw.slice(idx + 4) });
    });
  });
}

// ── loadLeaseFile ─────────────────────────────────────────────────────────

describe('loadLeaseFile', () => {
  test('reads the three fields the holder needs and drops the rest', () => {
    const { path } = seedLease();
    expect(loadLeaseFile(path)).toEqual({
      refresh_token: 'jlr_TESTSEED',
      access_token: 'jla_TESTSEED',
      access_expires: T0 + 20 * MIN,
    });
  });

  test('a missing file is null, not a throw', () => {
    const { dir } = seedLease();
    expect(loadLeaseFile(join(dir, 'absent.json'))).toBeNull();
  });

  test('malformed or mistyped records are null', () => {
    const { dir } = seedLease();
    const write = (name: string, text: string) => {
      const p = join(dir, name);
      writeFileSync(p, text, { mode: 0o600 });
      return p;
    };
    expect(loadLeaseFile(write('a.json', '{ not json'))).toBeNull();
    expect(loadLeaseFile(write('b.json', '"a string"'))).toBeNull();
    expect(loadLeaseFile(write('c.json', '[]'))).toBeNull();
    expect(loadLeaseFile(write('d.json', 'null'))).toBeNull();
    expect(loadLeaseFile(write('e.json', JSON.stringify({ access_token: 'jla_TEST', access_expires: T0 })))).toBeNull();
    expect(loadLeaseFile(write('f.json', JSON.stringify({ refresh_token: '', access_token: 'jla_TEST', access_expires: T0 })))).toBeNull();
    expect(loadLeaseFile(write('g.json', JSON.stringify({ refresh_token: 'jlr_TEST', access_token: 42, access_expires: T0 })))).toBeNull();
    // a bool must not pass the number check
    expect(loadLeaseFile(write('h.json', JSON.stringify({ refresh_token: 'jlr_TEST', access_token: 'jla_TEST', access_expires: true })))).toBeNull();
    expect(loadLeaseFile(write('i.json', JSON.stringify({ refresh_token: 'jlr_TEST', access_token: 'jla_TEST', access_expires: '123' })))).toBeNull();
  });
});

// ── Renewal ───────────────────────────────────────────────────────────────

describe('lease renewal', () => {
  test('renewal fires when under 30 min remain and rewrites the file atomically 0600', async () => {
    const gate = makeGate();
    const { dir, path } = seedLease();
    await startHolder({
      path,
      brokerUrl: gate.url,
      isDemoActive: () => false,
      now: () => T0,
      port: 0,
      checkIntervalMs: 5,
    });

    await waitFor(() => loadLeaseFile(path)?.access_token === 'jla_TESTNEW1', 'the renewed lease file');

    expect(loadLeaseFile(path)).toEqual({
      refresh_token: 'jlr_TESTNEW1',
      access_token: 'jla_TESTNEW1',
      access_expires: T0 + 3_600_000,
    });
    expect(mode(path)).toBe(0o600);
    // temp+rename, not truncate-in-place: nothing left behind in the directory
    expect(readdirSync(dir)).toEqual(['gate-lease.json']);
    // the door's own metadata survives a rewrite
    expect(JSON.parse(readFileSync(path, 'utf-8')).door_name).toBe('mac-studio');

    expect(gate.hits[0]).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'jlr_TESTSEED',
      contentType: 'application/x-www-form-urlencoded',
    });
    // the fresh token is far outside the renewal window — no second rotation
    await Bun.sleep(60);
    expect(gate.hits.length).toBe(1);
  });

  test('a lease with more than the jittered window left is left alone', async () => {
    const gate = makeGate();
    const { path } = seedLease({ access_expires: T0 + 40 * MIN });
    await startHolder({
      path,
      brokerUrl: gate.url,
      isDemoActive: () => false,
      now: () => T0,
      port: 0,
      checkIntervalMs: 5,
    });
    await Bun.sleep(80);
    expect(gate.hits.length).toBe(0);
    expect(loadLeaseFile(path)?.access_token).toBe('jla_TESTSEED');
  });

  test('renewal survives a failed attempt (gate 503) and retries next tick without corrupting the file', async () => {
    const gate = makeGate({ failing: true });
    const { dir, path } = seedLease();
    await startHolder({
      path,
      brokerUrl: gate.url,
      isDemoActive: () => false,
      now: () => T0,
      port: 0,
      checkIntervalMs: 5,
    });

    await waitFor(() => gate.hits.length >= 2, 'a retried renewal attempt');
    // the refused attempts left the enrolled lease exactly as it was
    expect(loadLeaseFile(path)).toEqual({
      refresh_token: 'jlr_TESTSEED',
      access_token: 'jla_TESTSEED',
      access_expires: T0 + 20 * MIN,
    });
    expect(readdirSync(dir)).toEqual(['gate-lease.json']);

    gate.fail(false);
    await waitFor(() => loadLeaseFile(path)?.access_token === 'jla_TESTNEW1', 'the lease file after recovery');
    expect(loadLeaseFile(path)?.refresh_token).toBe('jlr_TESTNEW1');
    expect(mode(path)).toBe(0o600);
    // every attempt presented the seeded refresh token — a failed rotation
    // must not advance the generation
    expect(gate.hits.every((h) => h.refresh_token === 'jlr_TESTSEED')).toBe(true);
  });

  test('concurrent demand rotates once — a replayed refresh token would kill the lease', async () => {
    const gate = makeGate({ delayMs: 120 });
    const { path } = seedLease({ access_expires: T0 + 5 * MIN });
    const holder = await startHolder({
      path,
      brokerUrl: gate.url,
      isDemoActive: () => false,
      now: () => T0,
      port: 0,
      checkIntervalMs: 5,
    });

    const tokens = await Promise.all([holder.currentToken(), holder.currentToken(), holder.currentToken()]);
    expect(tokens).toEqual(['jla_TESTNEW1', 'jla_TESTNEW1', 'jla_TESTNEW1']);
    expect(gate.hits.length).toBe(1);
  });
});

// ── The loopback mint ─────────────────────────────────────────────────────

describe('loopback mint GET /lease/token', () => {
  test('serves the current access token, and refuses 403 while a demo session is live', async () => {
    const gate = makeGate();
    const { path } = seedLease({ access_expires: T0 + 120 * MIN });
    let demo = false;
    const holder = await startHolder({
      path,
      brokerUrl: gate.url,
      isDemoActive: () => demo,
      now: () => T0,
      port: 0,
      checkIntervalMs: 5,
    });

    const ok = await fetch(`http://127.0.0.1:${holder.port}/lease/token`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ access_token: 'jla_TESTSEED', expires_at: T0 + 120 * MIN });

    // The kiosk invariant: while the live session is a demo, the mint is shut.
    demo = true;
    const refused = await fetch(`http://127.0.0.1:${holder.port}/lease/token`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'demo session active' });
  });

  test('503 with no lease file', async () => {
    const gate = makeGate();
    const { dir } = seedLease();
    const holder = await startHolder({
      path: join(dir, 'absent.json'),
      brokerUrl: gate.url,
      isDemoActive: () => false,
      now: () => T0,
      port: 0,
      checkIntervalMs: 5,
    });
    const resp = await fetch(`http://127.0.0.1:${holder.port}/lease/token`);
    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({ error: 'no lease enrolled' });
    expect(gate.hits.length).toBe(0);
  });

  test('an expired lease the gate will not renew is 503, never a dead token', async () => {
    const gate = makeGate({ failing: true });
    const { path } = seedLease({ access_expires: T0 - MIN });
    const holder = await startHolder({
      path,
      brokerUrl: gate.url,
      isDemoActive: () => false,
      now: () => T0,
      port: 0,
      checkIntervalMs: 5,
    });
    const resp = await fetch(`http://127.0.0.1:${holder.port}/lease/token`);
    expect(resp.status).toBe(503);
    expect(await resp.text()).toContain('re-knock');
  });

  test('loopback binds 127.0.0.1 and refuses a rebound Host', async () => {
    const gate = makeGate();
    const { path } = seedLease({ access_expires: T0 + 120 * MIN });
    const holder = await startHolder({
      path,
      brokerUrl: gate.url,
      isDemoActive: () => false,
      now: () => T0,
      port: 0,
      checkIntervalMs: 5,
    });
    expect(holder.hostname).toBe('127.0.0.1');

    expect((await rawGet(holder.port, '/lease/token', `127.0.0.1:${holder.port}`)).status).toBe(200);
    expect((await rawGet(holder.port, '/lease/token', `localhost:${holder.port}`)).status).toBe(200);
    // DNS rebinding: a page on attacker.example resolving to 127.0.0.1
    const rebound = await rawGet(holder.port, '/lease/token', 'attacker.example');
    expect(rebound.status).toBe(403);
    expect(rebound.body).not.toContain('jla_');
  });

  test('other paths and methods get nothing', async () => {
    const gate = makeGate();
    const { path } = seedLease({ access_expires: T0 + 120 * MIN });
    const holder = await startHolder({
      path,
      brokerUrl: gate.url,
      isDemoActive: () => false,
      now: () => T0,
      port: 0,
      checkIntervalMs: 5,
    });
    const base = `http://127.0.0.1:${holder.port}`;
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/lease/tokens`)).status).toBe(404);
    const post = await fetch(`${base}/lease/token`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(await post.text()).not.toContain('jla_');
  });

  test('stop() closes the listener', async () => {
    const gate = makeGate();
    const { path } = seedLease({ access_expires: T0 + 120 * MIN });
    const holder = await startHolder({
      path,
      brokerUrl: gate.url,
      isDemoActive: () => false,
      now: () => T0,
      port: 0,
      checkIntervalMs: 5,
    });
    const port = holder.port;
    holder.stop();
    await expect(fetch(`http://127.0.0.1:${port}/lease/token`)).rejects.toThrow();
  });
});
