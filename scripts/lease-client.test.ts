import { describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { resolveAccessToken, resolveLeasePath } from './lib/lease-client';
import { fetchLeaseList } from './door-leases';

// vitest runs under a node worker pool (even when invoked via `bunx`), so
// the global `Bun.serve` isn't reliably available here — plain `node:http`
// on port 0 is the concurrency-safe stub server for this suite.
function jsonBody(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

async function readReqBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind a port');
  return `http://127.0.0.1:${addr.port}`;
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function tempLeasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lease-client-'));
  return join(dir, 'lease.json');
}

function seedLeaseFile(
  path: string,
  opts: { accessToken?: string; refreshToken?: string; remainingMs: number },
): void {
  writeFileSync(
    path,
    JSON.stringify({
      access_token: opts.accessToken ?? 'jla_seed',
      refresh_token: opts.refreshToken ?? 'jlr_seed',
      access_expires: Date.now() + opts.remainingMs,
    }),
    { mode: 0o600 },
  );
}

describe('resolveAccessToken — resolution order', () => {
  test('JULIAN_LEASE_URL wins over lease file and legacy env', async () => {
    const server = createServer((_req, res) => {
      jsonBody(res, 200, { access_token: 'jla_loopback', expires_at: Date.now() + 3600_000 });
    });
    const base = await listen(server);
    const leasePath = tempLeasePath();
    seedLeaseFile(leasePath, { remainingMs: 3600_000 });
    const env = {
      JULIAN_LEASE_URL: `${base}/lease/token`,
      JULIAN_OIDC_TOKEN: 'legacy-token',
    } as NodeJS.ProcessEnv;

    const result = await resolveAccessToken(env, leasePath, 'http://unused.invalid');
    await stop(server);

    expect(result).toEqual({ token: 'jla_loopback', source: 'loopback' });
  });

  test('403/503 loopback bodies surface verbatim without falling back (kiosk invariant)', async () => {
    const bodyText = JSON.stringify({ error: 'demo session active' });
    const server = createServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(bodyText);
    });
    const base = await listen(server);
    const leasePath = tempLeasePath();
    seedLeaseFile(leasePath, { remainingMs: 3600_000 });
    const env = {
      JULIAN_LEASE_URL: `${base}/lease/token`,
      JULIAN_OIDC_TOKEN: 'legacy-token',
    } as NodeJS.ProcessEnv;

    const result = await resolveAccessToken(env, leasePath, 'http://unused.invalid');
    await stop(server);

    expect(result).toEqual({ error: bodyText });
  });

  test('falls to lease file when no loopback url is set', async () => {
    const leasePath = tempLeasePath();
    seedLeaseFile(leasePath, { accessToken: 'jla_fromfile', remainingMs: 3600_000 });
    const env = { JULIAN_OIDC_TOKEN: 'legacy-token' } as NodeJS.ProcessEnv;

    const result = await resolveAccessToken(env, leasePath, 'http://unused.invalid');

    expect(result).toEqual({ token: 'jla_fromfile', source: 'lease-file' });
  });

  test('falls to legacy bearer last, with a stderr deprecation line', async () => {
    const leasePath = tempLeasePath(); // no file written — a miss
    const env = { JULIAN_OIDC_TOKEN: 'legacy-token' } as NodeJS.ProcessEnv;
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await resolveAccessToken(env, leasePath, 'http://unused.invalid');
    const wroteDeprecation = errSpy.mock.calls.some(([msg]) => String(msg).includes('door-knock.ts'));
    errSpy.mockRestore();

    expect(result).toEqual({ token: 'legacy-token', source: 'legacy' });
    expect(wroteDeprecation).toBe(true);
  });

  test('all three miss → error naming all three', async () => {
    const leasePath = tempLeasePath();
    const env = {} as NodeJS.ProcessEnv;

    const result = await resolveAccessToken(env, leasePath, 'http://unused.invalid');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/JULIAN_LEASE_URL/);
      expect(result.error).toMatch(/lease file/);
      expect(result.error).toMatch(/JULIAN_OIDC_TOKEN/);
    }
  });
});

describe('resolveAccessToken — mint-on-demand refresh', () => {
  test('refreshes when under 50% TTL and rewrites the file atomically 0600', async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      void (async () => {
        const body = await readReqBody(req);
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=jlr_stale');
        jsonBody(res, 200, {
          access_token: 'jla_fresh',
          refresh_token: 'jlr_fresh',
          expires_in: 3600,
          scope: 'full-house',
        });
      })();
    });
    const base = await listen(server);
    const leasePath = tempLeasePath();
    // 10 minutes remaining — under the 30-minute (50% of 3600s) threshold.
    seedLeaseFile(leasePath, { accessToken: 'jla_stale', refreshToken: 'jlr_stale', remainingMs: 10 * 60_000 });
    const env = {} as NodeJS.ProcessEnv;

    const result = await resolveAccessToken(env, leasePath, base);
    await stop(server);

    expect(result).toEqual({ token: 'jla_fresh', source: 'lease-file' });
    expect(hits).toBe(1);

    const onDisk = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(onDisk.access_token).toBe('jla_fresh');
    expect(onDisk.refresh_token).toBe('jlr_fresh');
    const mode = statSync(leasePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('token still valid but under threshold: a failed refresh degrades gracefully instead of erroring', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'authorization_pending' }));
    });
    const base = await listen(server);
    const leasePath = tempLeasePath();
    seedLeaseFile(leasePath, { accessToken: 'jla_still_good', refreshToken: 'jlr_stale', remainingMs: 10 * 60_000 });
    const env = {} as NodeJS.ProcessEnv;

    const result = await resolveAccessToken(env, leasePath, base);
    await stop(server);

    expect(result).toEqual({ token: 'jla_still_good', source: 'lease-file' });
  });

  test('two concurrent resolvers sharing a lock refresh exactly once', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      const n = hits;
      setTimeout(() => {
        jsonBody(res, 200, {
          access_token: `jla_fresh_${n}`,
          refresh_token: `jlr_fresh_${n}`,
          expires_in: 3600,
          scope: 'full-house',
        });
      }, 30); // widen the race window
    });
    const base = await listen(server);
    const leasePath = tempLeasePath();
    seedLeaseFile(leasePath, { remainingMs: 5 * 60_000 });
    const env = {} as NodeJS.ProcessEnv;

    const [r1, r2] = await Promise.all([
      resolveAccessToken(env, leasePath, base),
      resolveAccessToken(env, leasePath, base),
    ]);
    await stop(server);

    expect(hits).toBe(1);
    expect('token' in r1).toBe(true);
    expect('token' in r2).toBe(true);
    if ('token' in r1 && 'token' in r2) {
      expect(r1.token).toBe(r2.token);
      expect(r1.token).toBe('jla_fresh_1');
    }
  });
});

describe('resolveLeasePath — the single lease-path story', () => {
  test('defaults to ~/.julian/gate-lease.json when JULIAN_LEASE_FILE is unset', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveLeasePath(env)).toBe(join(homedir(), '.julian', 'gate-lease.json'));
  });

  test('JULIAN_LEASE_FILE overrides the default', () => {
    const env = { JULIAN_LEASE_FILE: '/tmp/custom/lease.json' } as NodeJS.ProcessEnv;
    expect(resolveLeasePath(env)).toBe('/tmp/custom/lease.json');
  });

  test('the override is respected end-to-end: resolveAccessToken reads from the overridden path, not the default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lease-client-override-'));
    const overridePath = join(dir, 'custom-lease.json');
    seedLeaseFile(overridePath, { accessToken: 'jla_override', remainingMs: 3600_000 });
    const env = { JULIAN_LEASE_FILE: overridePath } as NodeJS.ProcessEnv;

    const leasePath = resolveLeasePath(env);
    expect(leasePath).toBe(overridePath);

    const result = await resolveAccessToken(env, leasePath, 'http://unused.invalid');

    expect(result).toEqual({ token: 'jla_override', source: 'lease-file' });
  });
});

describe('door-leases.ts list — /leases response parsing', () => {
  test('parses the gate\'s real {"leases": [...]} shape (not a bare array)', async () => {
    const leases = [
      {
        leaseId: 'l1',
        doorName: 'door:julian-new-web',
        scope: 'full-house',
        status: 'living',
        born: 1,
        lastRenewal: null,
        lastVerb: null,
      },
    ];
    const server = createServer((req, res) => {
      expect(req.headers['x-breakglass-secret']).toBe('test-secret');
      jsonBody(res, 200, { leases });
    });
    const base = await listen(server);

    const result = await fetchLeaseList(base, 'test-secret');
    await stop(server);

    expect(result).toEqual(leases);
  });

  test('tolerates a bare array defensively', async () => {
    const leases = [
      {
        leaseId: 'l2',
        doorName: 'door:julian-vm',
        scope: 'reading-room',
        status: 'living',
        born: 2,
        lastRenewal: null,
        lastVerb: null,
      },
    ];
    const server = createServer((_req, res) => jsonBody(res, 200, leases));
    const base = await listen(server);

    const result = await fetchLeaseList(base, 'test-secret');
    await stop(server);

    expect(result).toEqual(leases);
  });

  test('non-ok response throws with the body text', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401);
      res.end('unauthorized');
    });
    const base = await listen(server);

    await expect(fetchLeaseList(base, 'wrong-secret')).rejects.toThrow('unauthorized');
    await stop(server);
  });
});
