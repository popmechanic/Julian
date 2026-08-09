// scripts/lib/lease-client.ts — resolves a working gate access token for a
// door-side script, in order of directness: the Mac loopback mint (fastest,
// always fresh), a self-refreshing lease file (mint-on-demand, works off
// the Mac too), then a deprecated legacy bearer. Never fabricates a token
// and never silently downgrades past an explicit refusal (kiosk invariant:
// a 403/503 from the loopback is authoritative and is surfaced as-is, not
// treated as a miss to fall through from).

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// The single lease-path story: every door script that reads or writes a
// lease file resolves it through this one function, so `JULIAN_LEASE_FILE`
// means the same thing everywhere it's honored — door-knock.ts (writes the
// file a knock produces) and this module (mints-on-demand against it) both
// call this rather than each carrying their own copy of the default.
export function resolveLeasePath(env: NodeJS.ProcessEnv): string {
  return env.JULIAN_LEASE_FILE ?? join(homedir(), '.julian', 'gate-lease.json');
}

export interface LeaseFileContents {
  access_token: string;
  refresh_token: string;
  access_expires: number; // epoch ms
}

export type ResolveResult =
  | { token: string; source: 'loopback' | 'lease-file' | 'legacy' }
  | { error: string };

// Matches the gate's access-token TTL (Global Constraints: 3600s). Refresh
// proactively once less than half that remains.
const ACCESS_TTL_MS = 3600_000;
const REFRESH_THRESHOLD_MS = ACCESS_TTL_MS / 2;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;

function now(): number {
  return Date.now();
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

async function readLeaseFile(path: string): Promise<LeaseFileContents | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as any).access_token === 'string' &&
      typeof (parsed as any).refresh_token === 'string' &&
      typeof (parsed as any).access_expires === 'number'
    ) {
      return parsed as LeaseFileContents;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeLeaseFileAtomic(path: string, contents: LeaseFileContents): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(contents), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, path);
}

async function acquireLock(lockPath: string): Promise<void> {
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      return;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lockPath);
        if (now() - st.mtimeMs > LOCK_STALE_MS) {
          // Stale lock — a prior holder died mid-refresh. Steal it.
          await fs.rmdir(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished mid-check; retry mkdir immediately
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await fs.rmdir(lockPath).catch(() => {});
}

async function mintFromRefresh(
  brokerUrl: string,
  refreshToken: string,
): Promise<LeaseFileContents | { error: string }> {
  let res: Response;
  try {
    res = await fetch(`${trimSlash(brokerUrl)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
  } catch (e) {
    return { error: `broker unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `refresh failed (${res.status}): ${text}` };
  }
  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; refresh_token?: string; expires_in?: number }
    | null;
  if (!body || !body.access_token || !body.refresh_token || typeof body.expires_in !== 'number') {
    return { error: 'refresh response malformed' };
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    access_expires: now() + body.expires_in * 1000,
  };
}

async function resolveFromLeaseFile(
  leasePath: string,
  brokerUrl: string,
): Promise<{ token: string } | { miss: string }> {
  let file = await readLeaseFile(leasePath);
  if (!file) return { miss: `lease file not found or unreadable at ${leasePath}` };

  const remaining = file.access_expires - now();
  if (remaining > REFRESH_THRESHOLD_MS) {
    return { token: file.access_token };
  }

  // Under 50% TTL (or already expired) — mint-on-demand, guarded by a lock
  // so concurrent doors sharing a lease file never race the refresh.
  const lockPath = `${leasePath}.lock`;
  await acquireLock(lockPath);
  try {
    // Re-read under the lock: another resolver may have already refreshed
    // while we were waiting.
    file = await readLeaseFile(leasePath);
    if (!file) return { miss: `lease file not found or unreadable at ${leasePath}` };
    const remainingUnderLock = file.access_expires - now();
    if (remainingUnderLock > REFRESH_THRESHOLD_MS) {
      return { token: file.access_token };
    }

    const minted = await mintFromRefresh(brokerUrl, file.refresh_token);
    if ('error' in minted) {
      if (remainingUnderLock > 0) {
        // Still technically valid — degrade gracefully rather than fail.
        process.stderr.write(`lease refresh failed, using still-valid token: ${minted.error}\n`);
        return { token: file.access_token };
      }
      return { miss: `lease file present but expired and refresh failed: ${minted.error}` };
    }

    await writeLeaseFileAtomic(leasePath, minted);
    return { token: minted.access_token };
  } finally {
    await releaseLock(lockPath);
  }
}

export async function resolveAccessToken(
  env: NodeJS.ProcessEnv,
  leasePath: string,
  brokerUrl: string,
): Promise<ResolveResult> {
  const misses: string[] = [];

  const loopbackUrl = env.JULIAN_LEASE_URL;
  if (loopbackUrl) {
    try {
      const res = await fetch(loopbackUrl);
      if (res.status === 403 || res.status === 503) {
        // Authoritative refusal (demo session active / no lease enrolled) —
        // surfaced verbatim, never treated as a miss to fall through from.
        const text = await res.text();
        return { error: text };
      }
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
        if (body?.access_token) return { token: body.access_token, source: 'loopback' };
        misses.push('JULIAN_LEASE_URL: response missing access_token');
      } else {
        misses.push(`JULIAN_LEASE_URL: unexpected status ${res.status}`);
      }
    } catch (e) {
      misses.push(`JULIAN_LEASE_URL: unreachable (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    misses.push('JULIAN_LEASE_URL not set');
  }

  const fileResult = await resolveFromLeaseFile(leasePath, brokerUrl);
  if ('token' in fileResult) return { token: fileResult.token, source: 'lease-file' };
  misses.push(fileResult.miss);

  const legacy = env.JULIAN_OIDC_TOKEN;
  if (legacy) {
    process.stderr.write('legacy bearer — this door should knock: bun scripts/door-knock.ts\n');
    return { token: legacy, source: 'legacy' };
  }
  misses.push('JULIAN_OIDC_TOKEN not set');

  return { error: `no access token available — ${misses.join('; ')}` };
}
