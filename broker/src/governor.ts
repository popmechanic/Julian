import { DurableObject } from 'cloudflare:workers';

export interface LedgerEntry {
  ts: number; sub: string; service: string; verb: string; detail: string; allowed: number;
}
export interface ReserveResult { ok: boolean; count: number; cap: number | null }

/** A reservation judged against two counters: the house's and the lease's own. */
export interface LeaseReserveResult {
  ok: boolean; refusedBy?: 'global' | 'lease'; count: number; cap: number | null;
}

export type LeaseScope = 'full-house' | 'reading-room';
export type KnockDecision = 'approved' | 'refused';

export interface KnockCreated { deviceCode: string; userCode: string; expiresIn: number; interval: number }
export interface KnockRefused { error: 'slow_down' }
export interface KnockView {
  userCode: string; clientId: string; host: string; purpose: string; created: number;
}
export type DevicePollResult =
  | { status: 'pending' | 'slow_down' | 'expired' | 'refused' }
  | { status: 'ready'; accessToken: string; refreshToken: string; expiresIn: number; scope: string };
export type MintResult =
  | { status: 'ok'; accessToken: string; refreshToken: string; expiresIn: number; scope: string }
  | { status: 'killed' }
  | { status: 'invalid' };
export interface LeaseIdentity { leaseId: string; doorName: string; scope: string }
export interface LeaseSummary {
  leaseId: string; doorName: string; scope: string; status: string;
  born: number; lastRenewal: number | null; lastVerb: string | null;
}
export interface LeaseExport { leases: unknown[]; tokens: unknown[]; knocks: unknown[] }

const DAY_MS = 86_400_000;
const MAX_DETAIL = 500;
const MAX_LIMIT = 200;

const ACCESS_TTL_SECONDS = 3600;
const DEVICE_CODE_TTL_SECONDS = 900;
const POLL_INTERVAL_SECONDS = 5;
const MAX_PENDING_KNOCKS = 5;          // a sixth pending knock still lands; a seventh is flooding
const DEFAULT_LEASE_SEND_CAP = 5;
const ACCESS_PREFIX = 'jla_';
const REFRESH_PREFIX = 'jlr_';
const LEGACY_LEASE_ID = 'legacy-window';
// Twenty consonants: no vowels (no accidental words), no 0/O/1/I/L lookalikes.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_HALF = 4;
const TOKEN_BYTES = 32;                // 256 bits → 43 base64url characters
const SCOPES: readonly string[] = ['full-house', 'reading-room'];

type Row = Record<string, unknown>;

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newUserCode(): string {
  const picks = crypto.getRandomValues(new Uint8Array(USER_CODE_HALF * 2));
  let code = '';
  for (let i = 0; i < picks.length; i++) {
    if (i === USER_CODE_HALF) code += '-';
    code += USER_CODE_ALPHABET[picks[i] % USER_CODE_ALPHABET.length];
  }
  return code;
}

/** Accepts the code as the human retyped it: lowercase, spaced, dashless. */
function normalizeUserCode(input: string): string {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length !== USER_CODE_HALF * 2) return '';
  return `${letters.slice(0, USER_CODE_HALF)}-${letters.slice(USER_CODE_HALF)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// One instance serves every service: a single ordered ledger of everything
// the doors did with borrowed hands. Traffic is dozens/day; a DO serializes
// hundreds/second — singular is a feature, not a bottleneck.
//
// It is also the lease register: who was let in, on whose approval, with which
// token generation. Tokens live here only as SHA-256 hashes — a stolen database
// yields no working credential.
export class GovernorDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const sql = ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ledger (
         ts INTEGER NOT NULL, sub TEXT NOT NULL, service TEXT NOT NULL,
         verb TEXT NOT NULL, detail TEXT NOT NULL, allowed INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS leases (
         lease_id TEXT PRIMARY KEY, door_name TEXT NOT NULL UNIQUE,
         client_claims TEXT NOT NULL, scope TEXT NOT NULL,
         status TEXT NOT NULL,
         born INTEGER NOT NULL, last_renewal INTEGER, last_verb TEXT,
         send_cap_per_day INTEGER NOT NULL DEFAULT 5)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS lease_tokens (
         hash TEXT PRIMARY KEY, lease_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         generation INTEGER NOT NULL, expires INTEGER, used INTEGER NOT NULL DEFAULT 0)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS knocks (
         device_code TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE,
         client_id TEXT NOT NULL, host TEXT NOT NULL, purpose TEXT NOT NULL,
         status TEXT NOT NULL,
         scope TEXT, door_name TEXT,
         created INTEGER NOT NULL, expires INTEGER NOT NULL, last_poll INTEGER NOT NULL DEFAULT 0)`,
    );
    // The legacy window is a lease like any other, so that closing it early is
    // one revoke rather than a deploy. It is seeded once and never re-seeded.
    sql.exec(
      `INSERT OR IGNORE INTO leases
         (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb, send_cap_per_day)
       VALUES (?, ?, ?, ?, 'living', ?, NULL, NULL, ?)`,
      LEGACY_LEASE_ID, LEGACY_LEASE_ID, '{"issuer":"pocket-id"}', 'full-house', Date.now(), DEFAULT_LEASE_SEND_CAP,
    );
  }

  /** The only clock the DO reads. Tests override it to drive expiry and day boundaries. */
  now(): number {
    return Date.now();
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private ledger(now: number, sub: string, service: string, verb: string, detail: string, allowed: boolean): void {
    this.sql.exec(
      'INSERT INTO ledger (ts, sub, service, verb, detail, allowed) VALUES (?, ?, ?, ?, ?, ?)',
      now, sub, service, verb, detail.slice(0, MAX_DETAIL), allowed ? 1 : 0,
    );
  }

  private countSince(dayStart: number, service: string, verb: string, sub: string | null): number {
    const row = sub === null
      ? this.sql.exec(
        'SELECT COUNT(*) AS n FROM ledger WHERE service = ? AND verb = ? AND allowed = 1 AND ts >= ?',
        service, verb, dayStart).one()
      : this.sql.exec(
        'SELECT COUNT(*) AS n FROM ledger WHERE sub = ? AND service = ? AND verb = ? AND allowed = 1 AND ts >= ?',
        sub, service, verb, dayStart).one();
    return Number(row.n);
  }

  reserve(sub: string, service: string, verb: string, detail: string, capPerDay: number | null): ReserveResult {
    const now = this.now();
    const dayStart = now - (now % DAY_MS); // UTC day boundary
    const used = this.countSince(dayStart, service, verb, null);
    const ok = capPerDay === null || used < capPerDay;
    this.ledger(now, sub, service, verb, detail, ok);
    return { ok, count: used + (ok ? 1 : 0), cap: capPerDay };
  }

  // Gate-authenticated acts. The lease's own counter is judged first, so a
  // single greedy door is told it is the greedy one rather than blaming the
  // house. `count`/`cap` always describe the counter that decided: the refusing
  // one on refusal, the global one when the act is allowed.
  reserveLease(
    leaseId: string, doorName: string, service: string, verb: string, detail: string,
    globalCap: number | null, leaseCap: number | null,
  ): LeaseReserveResult {
    const now = this.now();
    const dayStart = now - (now % DAY_MS);
    const sub = `lease:${leaseId}`;
    const leaseUsed = leaseCap === null ? 0 : this.countSince(dayStart, service, verb, sub);
    const globalUsed = this.countSince(dayStart, service, verb, null);
    const leaseOk = leaseCap === null || leaseUsed < leaseCap;
    const globalOk = globalCap === null || globalUsed < globalCap;
    const ok = leaseOk && globalOk;

    this.ledger(now, sub, service, verb, detail ? `door=${doorName} ${detail}` : `door=${doorName}`, ok);
    this.sql.exec('UPDATE leases SET last_verb = ? WHERE lease_id = ?', `${service}.${verb}`, leaseId);

    if (!leaseOk) return { ok: false, refusedBy: 'lease', count: leaseUsed, cap: leaseCap };
    if (!globalOk) return { ok: false, refusedBy: 'global', count: globalUsed, cap: globalCap };
    return { ok: true, count: globalUsed + 1, cap: globalCap };
  }

  entries(limit = 50): LedgerEntry[] {
    const n = Math.min(Math.max(1, Math.floor(limit) || 1), MAX_LIMIT);
    return this.sql
      .exec('SELECT ts, sub, service, verb, detail, allowed FROM ledger ORDER BY ts DESC, rowid DESC LIMIT ?', n)
      .toArray() as unknown as LedgerEntry[];
  }

  // ── the knock (RFC 8628 device flow) ──────────────────────────────────────

  async knockCreate(clientId: string, host: string, purpose: string): Promise<KnockCreated | KnockRefused> {
    const now = this.now();
    this.sql.exec('DELETE FROM knocks WHERE expires <= ?', now);
    const pending = Number(
      this.sql.exec("SELECT COUNT(*) AS n FROM knocks WHERE status = 'pending' AND expires > ?", now).one().n,
    );
    if (pending > MAX_PENDING_KNOCKS) return { error: 'slow_down' };

    let userCode = '';
    for (let attempt = 0; attempt < 10 && userCode === ''; attempt++) {
      const candidate = newUserCode();
      const taken = this.sql.exec('SELECT 1 AS hit FROM knocks WHERE user_code = ?', candidate).toArray().length > 0;
      if (!taken) userCode = candidate;
    }
    if (userCode === '') return { error: 'slow_down' };

    const deviceCode = randomToken();
    this.sql.exec(
      `INSERT INTO knocks
         (device_code, user_code, client_id, host, purpose, status, scope, door_name, created, expires, last_poll)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, 0)`,
      deviceCode, userCode, clientId, host, purpose, now, now + DEVICE_CODE_TTL_SECONDS * 1000,
    );
    return {
      deviceCode, userCode, expiresIn: DEVICE_CODE_TTL_SECONDS, interval: POLL_INTERVAL_SECONDS,
    };
  }

  /** What the approval page shows Marcus: who is knocking, from where, for what. */
  knockByUserCode(userCode: string): KnockView | null {
    const code = normalizeUserCode(userCode);
    if (code === '') return null;
    const row = this.sql.exec(
      `SELECT user_code, client_id, host, purpose, created FROM knocks
        WHERE user_code = ? AND status = 'pending' AND expires > ?`,
      code, this.now(),
    ).toArray()[0] as Row | undefined;
    if (!row) return null;
    return {
      userCode: String(row.user_code), clientId: String(row.client_id), host: String(row.host),
      purpose: String(row.purpose), created: Number(row.created),
    };
  }

  knockDecide(userCode: string, decision: KnockDecision, doorName: string, scope: LeaseScope): boolean {
    if (decision !== 'approved' && decision !== 'refused') return false;
    if (!SCOPES.includes(scope)) return false;
    if (doorName.trim() === '') return false;
    const code = normalizeUserCode(userCode);
    if (code === '') return false;
    const row = this.sql.exec(
      'SELECT status, expires FROM knocks WHERE user_code = ?', code,
    ).toArray()[0] as Row | undefined;
    if (!row || String(row.status) !== 'pending' || Number(row.expires) <= this.now()) return false;
    this.sql.exec(
      'UPDATE knocks SET status = ?, door_name = ?, scope = ? WHERE user_code = ?',
      decision, doorName, scope, code,
    );
    return true;
  }

  async devicePoll(deviceCode: string, clientId: string): Promise<DevicePollResult> {
    // Mint the candidate pair before touching storage: hashing is the only
    // await in this method, so every read and write below runs in one
    // uninterrupted turn and two concurrent polls cannot both claim a knock.
    const pair = await this.newPair();
    const now = this.now();
    const row = this.sql.exec(
      `SELECT device_code, client_id, status, scope, door_name, host, purpose, expires, last_poll
         FROM knocks WHERE device_code = ?`, deviceCode,
    ).toArray()[0] as Row | undefined;

    // An unknown code, another client's code, a dead code and a spent code all
    // sound identical from outside: expired.
    if (!row || String(row.client_id) !== clientId) return { status: 'expired' };
    if (Number(row.expires) <= now || String(row.status) === 'claimed') return { status: 'expired' };

    if (now - Number(row.last_poll) < POLL_INTERVAL_SECONDS * 1000) {
      this.sql.exec('UPDATE knocks SET last_poll = ? WHERE device_code = ?', now, deviceCode);
      return { status: 'slow_down' };
    }
    this.sql.exec('UPDATE knocks SET last_poll = ? WHERE device_code = ?', now, deviceCode);

    const status = String(row.status);
    if (status === 'refused') return { status: 'refused' };
    if (status !== 'approved') return { status: 'pending' };

    const doorName = String(row.door_name);
    const scope = String(row.scope);
    const claims = JSON.stringify({ clientId, host: String(row.host), purpose: String(row.purpose) });
    const leaseId = this.upsertLease(doorName, scope, claims, now);
    this.insertPair(leaseId, 1, pair, now);
    this.sql.exec("UPDATE knocks SET status = 'claimed' WHERE device_code = ?", deviceCode);
    return {
      status: 'ready',
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      scope,
    };
  }

  // ── the rotation machine ──────────────────────────────────────────────────

  async mintFromRefresh(refreshToken: string): Promise<MintResult> {
    // Both awaits first, for the same reason as devicePoll: the decision and
    // the writes that follow are one uninterrupted turn.
    const [hash, pair] = await Promise.all([sha256Hex(refreshToken), this.newPair()]);
    const now = this.now();
    const token = this.sql.exec(
      "SELECT lease_id, kind, generation FROM lease_tokens WHERE hash = ? AND kind IN ('refresh', 'refresh_prev')",
      hash,
    ).toArray()[0] as Row | undefined;
    if (!token) return { status: 'invalid' };

    const leaseId = String(token.lease_id);
    const lease = this.sql.exec(
      'SELECT door_name, scope, status FROM leases WHERE lease_id = ?', leaseId,
    ).toArray()[0] as Row | undefined;
    if (!lease || String(lease.status) !== 'living') return { status: 'invalid' };

    const generation = Number(token.generation);
    if (String(token.kind) === 'refresh_prev') {
      // A superseded refresh comes back. If its successor was never spent this
      // is the lost-response retry — the door never received the new pair, so
      // mint another and revoke the one that went missing. If the successor was
      // spent, two parties hold this lease's tokens: kill it.
      const successor = this.sql.exec(
        `SELECT used FROM lease_tokens
          WHERE lease_id = ? AND generation > ? AND kind IN ('refresh', 'refresh_prev')
          ORDER BY generation ASC LIMIT 1`,
        leaseId, generation,
      ).toArray()[0] as Row | undefined;
      // No successor at all means the chain was already torn down: fail closed.
      if (!successor || Number(successor.used) === 1) return this.killLease(leaseId, String(lease.door_name), now);
    }

    this.sql.exec(
      "DELETE FROM lease_tokens WHERE lease_id = ? AND generation > ? AND kind = 'refresh' AND used = 0",
      leaseId, generation,
    );
    const maxGeneration = Number(
      this.sql.exec('SELECT COALESCE(MAX(generation), 0) AS g FROM lease_tokens WHERE lease_id = ?', leaseId).one().g,
    );
    this.sql.exec("UPDATE lease_tokens SET kind = 'refresh_prev', used = 1 WHERE hash = ?", hash);
    this.insertPair(leaseId, maxGeneration + 1, pair, now);
    this.sql.exec('UPDATE leases SET last_renewal = ? WHERE lease_id = ?', now, leaseId);
    return {
      status: 'ok',
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      scope: String(lease.scope),
    };
  }

  /** Routine auth. Writes nothing — a lease that only reads leaves no ledger trail. */
  async validateAccess(accessToken: string): Promise<LeaseIdentity | null> {
    const hash = await sha256Hex(accessToken);
    const row = this.sql.exec(
      `SELECT l.lease_id AS lease_id, l.door_name AS door_name, l.scope AS scope
         FROM lease_tokens t JOIN leases l ON l.lease_id = t.lease_id
        WHERE t.hash = ? AND t.kind = 'access' AND t.expires > ? AND l.status = 'living'`,
      hash, this.now(),
    ).toArray()[0] as Row | undefined;
    if (!row) return null;
    return { leaseId: String(row.lease_id), doorName: String(row.door_name), scope: String(row.scope) };
  }

  legacyAllowed(): boolean {
    const row = this.sql.exec(
      'SELECT status FROM leases WHERE lease_id = ?', LEGACY_LEASE_ID,
    ).toArray()[0] as Row | undefined;
    return !!row && String(row.status) === 'living';
  }

  // ── the register ──────────────────────────────────────────────────────────

  leaseRevoke(doorNameOrId: string, by: string): boolean {
    const row = this.sql.exec(
      'SELECT lease_id, door_name, status FROM leases WHERE lease_id = ? OR door_name = ? LIMIT 1',
      doorNameOrId, doorNameOrId,
    ).toArray()[0] as Row | undefined;
    if (!row || String(row.status) === 'revoked') return false;
    const leaseId = String(row.lease_id);
    this.sql.exec("UPDATE leases SET status = 'revoked' WHERE lease_id = ?", leaseId);
    this.sql.exec('DELETE FROM lease_tokens WHERE lease_id = ?', leaseId);
    this.ledger(this.now(), `lease:${leaseId}`, 'lease', 'revoked', `door=${String(row.door_name)} by=${by}`, true);
    return true;
  }

  leaseList(): LeaseSummary[] {
    return (this.sql.exec(
      `SELECT lease_id, door_name, scope, status, born, last_renewal, last_verb
         FROM leases ORDER BY born ASC, door_name ASC`,
    ).toArray() as Row[]).map((row) => ({
      leaseId: String(row.lease_id),
      doorName: String(row.door_name),
      scope: String(row.scope),
      status: String(row.status),
      born: Number(row.born),
      lastRenewal: row.last_renewal === null ? null : Number(row.last_renewal),
      lastVerb: row.last_verb === null ? null : String(row.last_verb),
    }));
  }

  /** The whole register, for the break-glass dump. Hashes only; device codes stay behind. */
  leaseExport(): LeaseExport {
    return {
      leases: this.sql.exec('SELECT * FROM leases ORDER BY born ASC').toArray(),
      tokens: this.sql.exec(
        'SELECT hash, lease_id, kind, generation, expires, used FROM lease_tokens ORDER BY lease_id, generation',
      ).toArray(),
      knocks: this.sql.exec(
        `SELECT user_code, client_id, host, purpose, status, scope, door_name, created, expires, last_poll
           FROM knocks ORDER BY created ASC`,
      ).toArray(),
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async newPair(): Promise<{
    accessToken: string; refreshToken: string; accessHash: string; refreshHash: string;
  }> {
    const accessToken = ACCESS_PREFIX + randomToken();
    const refreshToken = REFRESH_PREFIX + randomToken();
    const [accessHash, refreshHash] = await Promise.all([sha256Hex(accessToken), sha256Hex(refreshToken)]);
    return { accessToken, refreshToken, accessHash, refreshHash };
  }

  /** One access token per lease at a time: minting a pair retires the last one. */
  private insertPair(
    leaseId: string, generation: number,
    pair: { accessHash: string; refreshHash: string }, now: number,
  ): void {
    this.sql.exec("DELETE FROM lease_tokens WHERE lease_id = ? AND kind = 'access'", leaseId);
    this.sql.exec(
      "INSERT INTO lease_tokens (hash, lease_id, kind, generation, expires, used) VALUES (?, ?, 'access', ?, ?, 0)",
      pair.accessHash, leaseId, generation, now + ACCESS_TTL_SECONDS * 1000,
    );
    this.sql.exec(
      "INSERT INTO lease_tokens (hash, lease_id, kind, generation, expires, used) VALUES (?, ?, 'refresh', ?, NULL, 0)",
      pair.refreshHash, leaseId, generation,
    );
  }

  /** A door is one lease for life: re-knocking revives its row and buries its old tokens. */
  private upsertLease(doorName: string, scope: string, claims: string, now: number): string {
    const existing = this.sql.exec(
      'SELECT lease_id FROM leases WHERE door_name = ?', doorName,
    ).toArray()[0] as Row | undefined;
    if (existing) {
      const leaseId = String(existing.lease_id);
      this.sql.exec(
        "UPDATE leases SET client_claims = ?, scope = ?, status = 'living', last_renewal = ? WHERE lease_id = ?",
        claims, scope, now, leaseId,
      );
      this.sql.exec('DELETE FROM lease_tokens WHERE lease_id = ?', leaseId);
      return leaseId;
    }
    const leaseId = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO leases
         (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb, send_cap_per_day)
       VALUES (?, ?, ?, ?, 'living', ?, NULL, NULL, ?)`,
      leaseId, doorName, claims, scope, now, DEFAULT_LEASE_SEND_CAP,
    );
    return leaseId;
  }

  private killLease(leaseId: string, doorName: string, now: number): MintResult {
    this.sql.exec("UPDATE leases SET status = 'killed-rotation' WHERE lease_id = ?", leaseId);
    this.sql.exec('DELETE FROM lease_tokens WHERE lease_id = ?', leaseId);
    this.ledger(now, `lease:${leaseId}`, 'lease', 'killed', `door=${doorName} lease killed: rotation replay`, false);
    return { status: 'killed' };
  }
}
