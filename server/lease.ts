// ── The lease holder ──────────────────────────────────────────────────────
// This door holds a named, until-revoked lease from the gate: a refresh token
// on disk, and a short-lived access token it keeps fresh. Subprocesses never
// see the refresh token — they ask the loopback mint for the current access
// token, which is why the mint is bound to 127.0.0.1 and shut while a demo
// session is live. A kiosk visitor gets neither a token nor the mint's URL.

import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

export interface LeaseFile {
  refresh_token: string;
  access_token: string;
  access_expires: number;
}

export interface LeaseHolderOptions {
  /** Path to the lease file (`~/.julian/gate-lease.json` in production). */
  path: string;
  /** Base URL of the gate — `POST <brokerUrl>/token` carries the refresh grant. */
  brokerUrl: string;
  /** The kiosk invariant: true while the live session is a demo session. */
  isDemoActive: () => boolean;
  now?: () => number;
  port?: number;
  /** Test seam: how often the renewal check runs. Production leaves it at 60s. */
  checkIntervalMs?: number;
}

export interface LeaseHolder {
  port: number;
  hostname: string;
  stop: () => void;
  currentToken: () => Promise<string | null>;
}

/** Renew once fewer than 30 minutes of the access token's hour remain. */
const RENEW_WINDOW_MS = 1_800_000;
const CHECK_INTERVAL_MS = 60_000;
/** ±10% on the renewal check, so a fleet of doors never renews in lockstep. */
const JITTER = 0.1;
const RENEW_TIMEOUT_MS = 10_000;
const LOOPBACK_PORT = 8377;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

interface LeaseRecord {
  lease: LeaseFile;
  /** The whole file as written, so a rewrite preserves door_name, scope, … */
  raw: Record<string, unknown>;
}

function readLeaseRecord(path: string): LeaseRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null; // absent or unreadable — this door holds no lease
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  const refresh = raw.refresh_token;
  const access = raw.access_token;
  const expires = raw.access_expires;
  if (typeof refresh !== "string" || refresh.length === 0) return null;
  if (typeof access !== "string") return null;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
  return {
    lease: { refresh_token: refresh, access_token: access, access_expires: expires },
    raw,
  };
}

/**
 * Read the lease file defensively. Anything missing, unparseable, or mistyped
 * is `null` — never a throw, and never a half-populated lease.
 */
export function loadLeaseFile(path: string): LeaseFile | null {
  return readLeaseRecord(path)?.lease ?? null;
}

/**
 * Rewrite the lease atomically: a temp file created 0600 in the same
 * directory, then rename over the target. A reader either sees the whole old
 * lease or the whole new one — a crash mid-write never leaves a door with a
 * truncated refresh token.
 */
function writeLeaseAtomic(path: string, record: Record<string, unknown>): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: FILE_MODE });
    chmodSync(tmp, FILE_MODE); // the mode arg above is subject to umask; this is not
    renameSync(tmp, path);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// The listener is bound to 127.0.0.1, but a Host check closes the DNS-rebinding
// path: a page on attacker.example that resolves to 127.0.0.1 reaches the
// socket, and its request carries its own Host. A missing Host (HTTP/2 maps
// :authority, so this is only ever a malformed HTTP/1.1 request) is allowed —
// the bind is the primary control; this is the second lock.
function isLoopbackHost(host: string | null): boolean {
  if (!host) return true;
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

export async function startLeaseHolder(opts: LeaseHolderOptions): Promise<LeaseHolder> {
  const now = opts.now ?? Date.now;
  const tokenUrl = `${opts.brokerUrl.replace(/\/+$/, "")}/token`;
  let renewInFlight: Promise<boolean> | null = null;
  let consecutiveFailures = 0;
  let stopped = false;

  // Renewal is strictly single-flight. Rotation is one-shot by design: present
  // the same refresh token twice and the gate kills the lease as a replay, so
  // a timer tick and a subprocess asking at the same moment must share one
  // request, never race into two.
  function renew(): Promise<boolean> {
    if (!renewInFlight) {
      renewInFlight = renewOnce().finally(() => { renewInFlight = null; });
    }
    return renewInFlight;
  }

  function noteFailure(message: string): false {
    consecutiveFailures += 1;
    // Loud on the first failure, then every tenth — a wedged gate must be
    // visible without drowning the log.
    if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
      console.error(`[Lease] renewal failed (${consecutiveFailures}x): ${message}`);
    }
    return false;
  }

  async function renewOnce(): Promise<boolean> {
    // Re-read rather than trusting an in-memory copy: a door-side CLI may have
    // rotated the file since the last check, and a stale refresh token reads
    // as a replay.
    const current = readLeaseRecord(opts.path);
    if (!current) return false;

    let resp: Response;
    try {
      resp = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.lease.refresh_token,
        }).toString(),
        signal: AbortSignal.timeout(RENEW_TIMEOUT_MS),
      });
    } catch (e) {
      return noteFailure(`gate unreachable — ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!resp.ok) {
      const body = (await resp.text().catch(() => "")).slice(0, 200);
      // 400 invalid_grant means this lease is dead (revoked, or killed as a
      // rotation replay). The file is left as it is for forensics; the door
      // re-knocks: bun scripts/door-knock.ts
      return noteFailure(`gate refused with HTTP ${resp.status} ${body}`);
    }

    let payload: unknown;
    try {
      payload = await resp.json();
    } catch {
      return noteFailure("gate response was not JSON");
    }
    const p = payload as Record<string, unknown> | null;
    const access = p?.access_token;
    const refresh = p?.refresh_token;
    const expiresIn = p?.expires_in;
    if (
      typeof access !== "string" || access.length === 0 ||
      typeof refresh !== "string" || refresh.length === 0 ||
      typeof expiresIn !== "number" || !Number.isFinite(expiresIn)
    ) {
      return noteFailure("gate response missing access_token/refresh_token/expires_in");
    }

    try {
      writeLeaseAtomic(opts.path, {
        ...current.raw,
        access_token: access,
        refresh_token: refresh,
        access_expires: now() + expiresIn * 1000,
      });
    } catch (e) {
      return noteFailure(`could not write the lease file — ${e instanceof Error ? e.message : String(e)}`);
    }
    consecutiveFailures = 0;
    return true;
  }

  function dueForRenewal(lease: LeaseFile): boolean {
    const window = RENEW_WINDOW_MS * (1 + (Math.random() * 2 - 1) * JITTER);
    return lease.access_expires - now() < window;
  }

  async function check(): Promise<void> {
    if (stopped) return;
    const current = readLeaseRecord(opts.path);
    if (!current) return; // no lease enrolled — nothing to keep alive
    if (!dueForRenewal(current.lease)) return;
    await renew();
  }

  /** The lease as it stands, renewed first if it is inside the window. */
  async function currentLease(): Promise<LeaseFile | null> {
    let current = readLeaseRecord(opts.path);
    if (!current) return null;
    if (current.lease.access_expires - now() < RENEW_WINDOW_MS) {
      await renew();
      current = readLeaseRecord(opts.path) ?? current;
    }
    // A renewal that failed leaves the old token: still usable until it
    // actually expires, and worthless after.
    if (current.lease.access_expires <= now()) return null;
    return current.lease.access_token ? current.lease : null;
  }

  async function currentToken(): Promise<string | null> {
    return (await currentLease())?.access_token ?? null;
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? LOOPBACK_PORT,
    async fetch(req) {
      if (!isLoopbackHost(req.headers.get("host"))) {
        return json({ error: "loopback only" }, 403);
      }
      const url = new URL(req.url);
      if (url.pathname !== "/lease/token") return json({ error: "not found" }, 404);
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      // The kiosk invariant, checked before the lease is even read: while the
      // live session is a demo, this door mints nothing.
      if (opts.isDemoActive()) return json({ error: "demo session active" }, 403);
      if (!readLeaseRecord(opts.path)) return json({ error: "no lease enrolled" }, 503);
      const lease = await currentLease();
      if (!lease) {
        return json({ error: "lease token expired — renew, or re-knock if revoked" }, 503);
      }
      return json({ access_token: lease.access_token, expires_at: lease.access_expires }, 200);
    },
  });

  const timer = setInterval(() => { void check(); }, opts.checkIntervalMs ?? CHECK_INTERVAL_MS);
  // Don't wait a full interval to discover the lease is nearly out.
  void check();

  return {
    port: server.port,
    hostname: server.hostname,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      server.stop(true);
    },
    currentToken,
  };
}
