import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bearerToken, subprocessEnv } from '../../server/lib';

describe('subprocessEnv', () => {
  test('injects the session token and keeps the existing spawn flags', () => {
    const env = subprocessEnv({ PATH: '/bin', BROKER_URL: 'https://broker.example' }, { CLAUDE_CODE_OAUTH_TOKEN: 't' }, 'oidc-token-xyz');
    expect(env.JULIAN_OIDC_TOKEN).toBe('oidc-token-xyz');
    expect(env.BROKER_URL).toBe('https://broker.example'); // rides through from base
    expect(env.PATH).toBe('/bin');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('t');
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(env.CLAUDECODE).toBe('');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('');
  });
  test('empty token → no JULIAN_OIDC_TOKEN key at all (no stale empty var)', () => {
    const env = subprocessEnv({}, {}, '');
    expect('JULIAN_OIDC_TOKEN' in env).toBe(false);
  });
  test('demo sessions carry no token: empty token also scrubs an inherited one', () => {
    // The server's own env must never hand a previous door's token to a new
    // subprocess: no token captured means no token passed, full stop. This is
    // what makes the demo call site safe — /api/session/start passes '' for a
    // demo session, so an anonymous kiosk visitor's subprocess has no bearer
    // to spend at the broker, whatever the server process inherited.
    expect('JULIAN_OIDC_TOKEN' in subprocessEnv({ JULIAN_OIDC_TOKEN: 'someone-elses-token' }, {}, '')).toBe(false);
    expect('JULIAN_OIDC_TOKEN' in subprocessEnv({ JULIAN_OIDC_TOKEN: 'stale-from-server-env' }, {}, '')).toBe(false);
  });
  test('the captured token wins over one inherited from the base env', () => {
    const env = subprocessEnv({ JULIAN_OIDC_TOKEN: 'stale' }, {}, 'fresh');
    expect(env.JULIAN_OIDC_TOKEN).toBe('fresh');
  });
  test('authEnv overrides base, and the spawn flags override both', () => {
    const env = subprocessEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: 'base', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' },
      { CLAUDE_CODE_OAUTH_TOKEN: 'auth' },
      '',
    );
    expect(env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'auth',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDECODE: '',
      CLAUDE_CODE_ENTRYPOINT: '',
    });
  });
  test('does not mutate the base or authEnv objects it was given', () => {
    const base = { JULIAN_OIDC_TOKEN: 'stale', PATH: '/bin' };
    const authEnv = { CLAUDE_CODE_OAUTH_TOKEN: 't' };
    subprocessEnv(base, authEnv, 'fresh');
    expect(base).toEqual({ JULIAN_OIDC_TOKEN: 'stale', PATH: '/bin' });
    expect(authEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
  });
});

describe('bearerToken', () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  test('reads the raw bearer from Authorization', () => {
    expect(bearerToken(headers({ Authorization: 'Bearer oidc-token-xyz' }))).toBe('oidc-token-xyz');
  });
  test('falls back to X-Authorization (the exe.dev edge proxy strips Authorization)', () => {
    expect(bearerToken(headers({ 'X-Authorization': 'Bearer proxied-token' }))).toBe('proxied-token');
  });
  test('prefers Authorization when both are present', () => {
    expect(bearerToken(headers({ Authorization: 'Bearer direct', 'X-Authorization': 'Bearer proxied' }))).toBe('direct');
  });
  test('returns empty string when there is no bearer header', () => {
    expect(bearerToken(headers({}))).toBe('');
  });
  test('returns empty string for a non-Bearer scheme rather than slicing garbage', () => {
    expect(bearerToken(headers({ Authorization: 'Basic dXNlcjpwYXNz' }))).toBe('');
  });
});

// ── The kiosk lock (DEMO_MODE=1) binds regardless of request body ──────────
// The helper above guarantees a demo session gets no token; that guarantee is
// only worth anything if the handler actually classifies the session as demo.
// A bodyless POST /api/session/start makes req.json() throw, so a lock read
// only inside the body-parse try block fails OPEN: the deployment spawns a
// NORMAL session and hands the operator's live bearer to an anonymous kiosk
// visitor's subprocess. This exercises the real handler to prove it does not.

// Bind port 0 so the OS picks a free port, then release it for the server.
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = probe;
  probe.stop(true);
  return port;
}

async function waitForServer(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  let lastFailure: unknown = 'no attempt completed';
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
      lastFailure = `HTTP ${resp.status}`;
    } catch (e) {
      lastFailure = e;
    }
    await Bun.sleep(200);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms (last failure: ${lastFailure})`);
}

// Collect the replayed SSE events, then hang up. Buffered events are flushed
// on connect, so one read pass is enough. Failures throw with their cause: a
// red run must say whether the guard broke or the transport did.
async function replayedEvents(baseUrl: string, timeoutMs = 5000): Promise<any[]> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  let buffer = '';
  try {
    const resp = await fetch(`${baseUrl}/api/events?after=-1`, { signal: ctrl.signal });
    const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // The replay is one write; once a session-start event is in hand, stop.
      if (buffer.includes('"user_session_start"')) break;
    }
    // Deliberate hangup on a live stream — a cancel error is expected noise.
    await reader.cancel().catch(() => {});
  } catch (e) {
    throw timedOut
      ? new Error(`SSE replay: no user_session_start within ${timeoutMs}ms`, { cause: e })
      : new Error(`SSE replay transport failed: ${e}`, { cause: e });
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  const lines = buffer.split('\n');
  // The read stops as soon as the marker appears, so the tail may be a
  // partial line; complete SSE data lines are always newline-terminated.
  lines.pop();
  const events: any[] = [];
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch (e) {
      throw new Error(`SSE replay: unparseable data line ${JSON.stringify(line)}`, { cause: e });
    }
  }
  return events;
}

describe('POST /api/session/start under the kiosk lock', () => {
  let serverProc: Subprocess | null = null;
  let baseUrl = '';

  beforeAll(async () => {
    // A stub `claude` first on PATH: remote mode shells out to it for the
    // wake-up message, and no test may launch the real CLI.
    const stubDir = mkdtempSync(join(tmpdir(), 'julian-claude-stub-'));
    const stub = join(stubDir, 'claude');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    chmodSync(stub, 0o755);

    const port = freePort();
    baseUrl = `http://localhost:${port}`;

    // The env is an explicit allowlist, not an inherited spread: the test
    // process's ambient env carries the repo .env (real AGENTMAIL_API_KEY and
    // friends), and none of it belongs in a spawned server. --env-file=/dev/null
    // stops the child's own .env auto-load too, so absence here is absence
    // there — no issuer → local dev mode, bearer verification skipped.
    serverProc = Bun.spawn([process.execPath, '--env-file=/dev/null', 'run', 'server/server.ts'], {
      cwd: join(import.meta.dir, '..', '..'),
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '',
        PORT: String(port),
        ALLOWED_ORIGIN: baseUrl,
        DEMO_MODE: '1',
        // Remote mode: spawnClaude takes the no-subprocess path, so the handler
        // is exercised without a local Claude process.
        REMOTE_SESSION: 'kiosk-lock-test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForServer(`${baseUrl}/api/health`);
  });

  afterAll(async () => {
    if (serverProc) {
      serverProc.kill();
      await serverProc.exited;
      serverProc = null;
    }
  });

  test('a bodyless POST on a DEMO_MODE=1 deployment still starts a demo session', async () => {
    const resp = await fetch(`${baseUrl}/api/session/start`, { method: 'POST' });
    expect(resp.status).toBe(200);
    const events = await replayedEvents(baseUrl);
    const started = events.find(e => e.type === 'user_session_start');
    expect(started).toBeDefined();
    // false here means the handler would have spawned a normal session and
    // passed it the operator's bearer.
    expect(started.demoMode).toBe(true);
  });
});
