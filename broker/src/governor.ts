import { DurableObject } from 'cloudflare:workers';
import { AUTHCODE_SCOPES, KNOCK_SCOPES } from 'julian-shared/scopes';

export interface LedgerEntry {
  ts: number; sub: string; service: string; verb: string; detail: string; allowed: number;
}
export interface ReserveResult { ok: boolean; count: number; cap: number | null }

/** A reservation judged against two counters: the house's and the lease's own. */
export interface LeaseReserveResult {
  ok: boolean; refusedBy?: 'global' | 'lease'; count: number; cap: number | null;
}

// The knock's scope vocabulary is not this file's to invent: it is spec §5's
// mint allowlist, read straight off `julian-shared/scopes`. `stream` is absent
// there, which is what makes it structurally unknockable.
export type LeaseScope = (typeof KNOCK_SCOPES)[number];
export type KnockDecision = 'approved' | 'refused';
/** Which mint path is asking. Every reserved door name belongs to exactly one. */
export type MintClass = 'device' | 'authcode' | 'exchange';

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
export interface LeaseIdentity { leaseId: string; doorName: string; scope: string; principal: string }
export interface LeaseSummary {
  leaseId: string; doorName: string; scope: string; status: string;
  born: number; lastRenewal: number | null; lastVerb: string | null;
  principal: string; flow: string;
}
export interface LeaseExport { leases: unknown[]; tokens: unknown[]; knocks: unknown[] }

const DAY_MS = 86_400_000;
const MAX_DETAIL = 500;
const MAX_LIMIT = 200;

const ACCESS_TTL_SECONDS = 3600;
const DEVICE_CODE_TTL_SECONDS = 900;
const POLL_INTERVAL_SECONDS = 5;
const MAX_PENDING_KNOCKS = 5;          // at most five may wait at once; the sixth is flooding
const MAX_CLAIM = 120;                 // the door's self-description, bounded before storage
const DEFAULT_LEASE_SEND_CAP = 5;
const ACCESS_PREFIX = 'jla_';
const REFRESH_PREFIX = 'jlr_';
const LEGACY_LEASE_ID = 'legacy-window';
// The sync worker's own legacy window. A second pseudo-lease rather than a
// second meaning for the first, so closing the browser's raw-JWT door and
// closing the MCP door are two separate revokes on two separate dates.
const LEGACY_SYNC_LEASE_ID = 'legacy-window-sync';
// Reserved door-name prefixes. `browser:` names are the browser session's, and
// only the exchange flow may mint one; `visit:` names are the MCP visit's, and
// only the authcode flow may mint one.
const BROWSER_PREFIX = 'browser:';
const VISIT_PREFIX = 'visit:';
// Twenty consonants: no vowels (no accidental words), no 0/O/1/I/L lookalikes.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_HALF = 4;
const TOKEN_BYTES = 32;                // 256 bits → 43 base64url characters
// Reuse-grace for the authcode path: a client that retries the very same
// refresh request inside this window is served the pair it already earned,
// idempotently, rather than being read as a replay and killed.
const AUTHCODE_GRACE_MS = 10_000;

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

/**
 * Everything a door says about itself is unverified text, and unverified text
 * gets a length. Applied at storage and at every later comparison, so a door
 * with an over-long client id still matches its own knock.
 */
function claim(value: string): string {
  return value.slice(0, MAX_CLAIM);
}

/**
 * The reserved-identifier table. Some door names are not a door's to choose:
 * they name a *kind* of holder, and a lease under one of them is trusted for
 * what that kind is trusted for. Three answers:
 *
 *   a `MintClass` — reserved, and only that one mint path may take the name
 *   `null`        — reserved for no mint path at all (the legacy literals,
 *                   which the constructor seeds directly and nothing mints)
 *   `undefined`   — not reserved: an ordinary door under the ordinary rules
 *
 * Read from below, inside `upsertLease`, so the absence of a button on a page
 * is never the enforcement and a flow nobody has written yet is bound too.
 */
function reservedOwner(doorName: string): MintClass | null | undefined {
  if (doorName.startsWith(BROWSER_PREFIX)) return 'exchange';
  if (doorName.startsWith(VISIT_PREFIX)) return 'authcode';
  if (doorName === LEGACY_LEASE_ID || doorName === LEGACY_SYNC_LEASE_ID) return null;
  return undefined;
}

/** The tighter of two caps; null is "no opinion", not "no limit". */
function tighter(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
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
  // Reuse-grace memory for the authcode path, keyed by the presented refresh
  // hash → the successor pair it minted and when. In memory only: a plaintext
  // successor token is never written to any table. Losing it (DO eviction)
  // costs nothing but the idempotency of an in-flight retry — the strict
  // rotation path still governs correctness.
  private authcodeGrace = new Map<
    string,
    { accessToken: string; refreshToken: string; mintedAt: number }
  >();

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
    // Guarded migration: a `leases` table from before `principal`/`flow`
    // existed (or a table this same literal just created, which is
    // identically shaped until this runs) gets the columns added here.
    // `ALTER TABLE ADD COLUMN` is unsafe to repeat, so it is gated on
    // `PRAGMA table_info` rather than run unconditionally.
    const leaseCols = new Set(
      (sql.exec('PRAGMA table_info(leases)').toArray() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!leaseCols.has('principal')) {
      sql.exec("ALTER TABLE leases ADD COLUMN principal TEXT NOT NULL DEFAULT 'julian'");
    }
    if (!leaseCols.has('flow')) {
      sql.exec("ALTER TABLE leases ADD COLUMN flow TEXT NOT NULL DEFAULT 'device'");
    }
    // B3's three: the Pocket ID `sub` a browser-session lease belongs to, the
    // package pin the door is currently sitting on, and the integrity latch
    // (JSON `{"pin","path"}` or NULL). All nullable — every row that predates
    // them is honestly "not yet known", never a fabricated default.
    if (!leaseCols.has('subject')) sql.exec('ALTER TABLE leases ADD COLUMN subject TEXT');
    if (!leaseCols.has('sitting_pin')) sql.exec('ALTER TABLE leases ADD COLUMN sitting_pin TEXT');
    if (!leaseCols.has('latch')) sql.exec('ALTER TABLE leases ADD COLUMN latch TEXT');
    sql.exec(
      `CREATE TABLE IF NOT EXISTS lease_tokens (
         hash TEXT PRIMARY KEY, lease_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         generation INTEGER NOT NULL, expires INTEGER, used INTEGER NOT NULL DEFAULT 0)`,
    );
    // A stable public handle for one token, so a socket can be re-checked and a
    // theft signal can name the credential without ever naming the credential.
    // Nullable: tokens minted before B3 keep working with no handle at all.
    const tokenCols = new Set(
      (sql.exec('PRAGMA table_info(lease_tokens)').toArray() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!tokenCols.has('token_id')) sql.exec('ALTER TABLE lease_tokens ADD COLUMN token_id TEXT');
    // The two shapes every cap question asks of the ledger, which is now also
    // written on the allowed path and so grows far faster than it used to.
    // Additive and idempotent: an index is not a schema the readers can see.
    sql.exec('CREATE INDEX IF NOT EXISTS idx_ledger_svc ON ledger (service, verb, allowed, ts)');
    sql.exec('CREATE INDEX IF NOT EXISTS idx_ledger_sub ON ledger (sub, service, verb, allowed, ts)');
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
    // The sync worker's window, seeded the same way and closable the same way.
    // It carries `stream`, not `full-house`: a raw Pocket ID JWT at the sync
    // socket buys the stream and nothing else, and never the mail.
    sql.exec(
      `INSERT OR IGNORE INTO leases
         (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb,
          send_cap_per_day, flow, principal)
       VALUES (?, ?, ?, 'stream', 'living', ?, NULL, NULL, ?, 'legacy', 'julian')`,
      LEGACY_SYNC_LEASE_ID, LEGACY_SYNC_LEASE_ID, '{"issuer":"pocket-id"}',
      Date.now(), DEFAULT_LEASE_SEND_CAP,
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
  //
  // `_doorName` is accepted and ignored. The caller's word for who it is has no
  // standing here: attribution and the door's own send allowance are both read
  // from the lease row, so a compromised caller cannot write another door's name
  // into the ledger or talk its way past a cap Marcus lowered.
  reserveLease(
    leaseId: string, _doorName: string, service: string, verb: string, detail: string,
    globalCap: number | null, leaseCap: number | null,
  ): LeaseReserveResult {
    const now = this.now();
    const dayStart = now - (now % DAY_MS);
    const sub = `lease:${leaseId}`;
    const lease = this.sql.exec(
      'SELECT door_name, send_cap_per_day FROM leases WHERE lease_id = ?', leaseId,
    ).toArray()[0] as Row | undefined;
    const doorName = lease ? String(lease.door_name) : 'unknown';
    // The stored allowance governs mail.send — the one verb the column names —
    // and only ever narrows what the caller asked for, so lowering a door's cap
    // in the register binds immediately with no deploy and no caller change.
    // The legacy window is exempt by design: it stands for everyone already
    // trusted yesterday, and metering them at five mid-migration would break the
    // doors the window exists to keep working. The house cap of 20 still binds
    // it, and it closes by date or by revoke.
    const metered = lease && leaseId !== LEGACY_LEASE_ID && service === 'mail' && verb === 'send';
    const storedCap = metered ? Number(lease.send_cap_per_day) : null;
    const effectiveLeaseCap = tighter(leaseCap, storedCap);

    const leaseUsed = effectiveLeaseCap === null ? 0 : this.countSince(dayStart, service, verb, sub);
    const globalUsed = this.countSince(dayStart, service, verb, null);
    const leaseOk = effectiveLeaseCap === null || leaseUsed < effectiveLeaseCap;
    const globalOk = globalCap === null || globalUsed < globalCap;
    const ok = leaseOk && globalOk;

    this.ledger(now, sub, service, verb, detail ? `door=${doorName} ${detail}` : `door=${doorName}`, ok);
    this.sql.exec('UPDATE leases SET last_verb = ? WHERE lease_id = ?', `${service}.${verb}`, leaseId);

    if (!leaseOk) return { ok: false, refusedBy: 'lease', count: leaseUsed, cap: effectiveLeaseCap };
    if (!globalOk) return { ok: false, refusedBy: 'global', count: globalUsed, cap: globalCap };
    return { ok: true, count: globalUsed + 1, cap: globalCap };
  }

  /**
   * The positive pen. `reserve`/`reserveLease` write the ledger as a side
   * effect of *deciding*; this writes it as a side effect of something having
   * *happened* — a socket opened, a part served, a read answered — where the
   * decision was made somewhere else and no cap is at stake. One row, always
   * `allowed:1`, never a refusal: there is no counter here to run out of.
   *
   * `doorName` is a label of last resort, not an identity. When the register
   * knows the lease, the register's word is what lands in the ledger, so a
   * caller holding the introspection secret still cannot write another door's
   * name into the record.
   */
  recordAllowed(leaseId: string, doorName: string, service: string, verb: string, detail: string): void {
    const now = this.now();
    const row = this.sql.exec(
      'SELECT door_name FROM leases WHERE lease_id = ?', leaseId,
    ).toArray()[0] as Row | undefined;
    const name = row ? String(row.door_name) : doorName;
    this.ledger(now, `lease:${leaseId}`, service, verb, detail ? `door=${name} ${detail}` : `door=${name}`, true);
    this.sql.exec('UPDATE leases SET last_verb = ? WHERE lease_id = ?', `${service}.${verb}`, leaseId);
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
    if (pending >= MAX_PENDING_KNOCKS) return { error: 'slow_down' };

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
      deviceCode, userCode, claim(clientId), claim(host), claim(purpose),
      now, now + DEVICE_CODE_TTL_SECONDS * 1000,
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
    if (!(KNOCK_SCOPES as readonly string[]).includes(scope)) return false;
    if (doorName.trim() === '') return false;
    // No reserved name is knockable — not even the one the device flow would
    // otherwise own, because the device flow owns none of them. Refused here as
    // well as in `upsertLease` so the approval page can say no before a knock
    // is spent; `upsertLease` remains the enforcement.
    if (reservedOwner(doorName) !== undefined) return false;
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
    if (!row || String(row.client_id) !== claim(clientId)) return { status: 'expired' };
    if (Number(row.expires) <= now || String(row.status) === 'claimed') return { status: 'expired' };

    // The window is measured from the last poll that was *answered*. Stamping an
    // impatient poll would let flooding push the door's own answer further away
    // — a self-inflicted denial of service.
    if (now - Number(row.last_poll) < POLL_INTERVAL_SECONDS * 1000) return { status: 'slow_down' };
    this.sql.exec('UPDATE knocks SET last_poll = ? WHERE device_code = ?', now, deviceCode);

    const status = String(row.status);
    if (status === 'refused') return { status: 'refused' };
    if (status !== 'approved') return { status: 'pending' };

    const doorName = String(row.door_name);
    const scope = String(row.scope);
    const claims = JSON.stringify({
      clientId: String(row.client_id), host: String(row.host), purpose: String(row.purpose),
    });
    // The knock row is storage, and storage is not testimony: a `door_name`
    // that reached it by any route other than `knockDecide` is still judged
    // here. The knock is left un-claimed, so the answer stays `refused` on
    // every retry rather than decaying into the ambiguous `expired`.
    const leaseId = this.upsertLease(doorName, scope, claims, now);
    if (leaseId === null) return { status: 'refused' };
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

  // ── the visit (RFC 8252 authorization-code flow) ──────────────────────────

  // Mints a lease for an MCP visit. The scope gate is here, server-side: any
  // scope outside `AUTHCODE_SCOPES` is refused before a token exists, so the
  // house can never be handed out over the authcode flow no matter what the
  // client asked for. Mirrors `devicePoll`'s ready branch — `newPair()` first,
  // then `upsertLease` + `insertPair` — but stamps `flow='authcode'`.
  async mintAuthcodeLease(
    doorName: string, scope: string, principal: string, claims: string,
  ): Promise<MintResult> {
    if (!(AUTHCODE_SCOPES as readonly string[]).includes(scope)) return { status: 'invalid' };
    const pair = await this.newPair();
    const now = this.now();
    const leaseId = this.upsertLease(doorName, scope, claims, now, 'authcode', principal, 'authcode');
    // A name this flow may not take, or a `visit:` row already put down: the
    // pair minted above is simply dropped, never written.
    if (leaseId === null) return { status: 'invalid' };
    this.insertPair(leaseId, 1, pair, now);
    return {
      status: 'ok',
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
      `SELECT lease_id, kind, generation FROM lease_tokens
        WHERE hash = ? AND kind IN ('refresh', 'refresh_prev', 'revoked')`,
      hash,
    ).toArray()[0] as Row | undefined;
    if (!token) return { status: 'invalid' };

    const leaseId = String(token.lease_id);
    const lease = this.sql.exec(
      'SELECT door_name, scope, status, flow FROM leases WHERE lease_id = ?', leaseId,
    ).toArray()[0] as Row | undefined;
    if (!lease || String(lease.status) !== 'living') return { status: 'invalid' };

    const isAuthcode = String(lease.flow) === 'authcode';

    // Reuse-grace, authcode only. A repeat of the same presented refresh inside
    // the window is an MCP client retrying a request whose answer it may not
    // have received; it is served the exact pair the first presentation minted,
    // idempotently, instead of taking the tombstone kill path. Device-flow
    // leases never enter here and keep their strict replay semantics.
    if (isAuthcode) {
      const cached = this.authcodeGrace.get(hash);
      if (cached && now - cached.mintedAt <= AUTHCODE_GRACE_MS) {
        return {
          status: 'ok',
          accessToken: cached.accessToken,
          refreshToken: cached.refreshToken,
          expiresIn: ACCESS_TTL_SECONDS,
          scope: String(lease.scope),
        };
      }
    }

    const generation = Number(token.generation);
    const kind = String(token.kind);

    // A tombstone comes back. Grace was already spent on someone: the pair this
    // token belonged to was superseded by a *replay* of an older refresh, which
    // only two holders can produce. Whoever presents it now is the second party.
    if (kind === 'revoked') return this.killLease(leaseId, String(lease.door_name), now);

    if (kind === 'refresh_prev') {
      // A superseded refresh comes back. If its successor was never spent this
      // is the lost-response retry — the door never received the new pair, so
      // mint another and tombstone the one that went missing. If the successor
      // was spent, two parties hold this lease's tokens: kill it. Tombstones are
      // not successors; a door retrying the same lost response keeps its grace.
      const successor = this.sql.exec(
        `SELECT used FROM lease_tokens
          WHERE lease_id = ? AND generation > ? AND kind IN ('refresh', 'refresh_prev')
          ORDER BY generation ASC LIMIT 1`,
        leaseId, generation,
      ).toArray()[0] as Row | undefined;
      // No successor at all means the chain was already torn down: fail closed.
      if (!successor || Number(successor.used) === 1) return this.killLease(leaseId, String(lease.door_name), now);
    }

    // The superseded pair is retired, not erased. A deleted hash is
    // indistinguishable from a hash that never existed, and "never existed"
    // answers `invalid` — which would let a replay be survived in silence.
    this.sql.exec(
      "UPDATE lease_tokens SET kind = 'revoked' WHERE lease_id = ? AND generation > ? AND kind = 'refresh' AND used = 0",
      leaseId, generation,
    );
    const maxGeneration = Number(
      this.sql.exec('SELECT COALESCE(MAX(generation), 0) AS g FROM lease_tokens WHERE lease_id = ?', leaseId).one().g,
    );
    this.sql.exec("UPDATE lease_tokens SET kind = 'refresh_prev', used = 1 WHERE hash = ?", hash);
    this.insertPair(leaseId, maxGeneration + 1, pair, now);
    this.sql.exec('UPDATE leases SET last_renewal = ? WHERE lease_id = ?', now, leaseId);
    // Remember this rotation so a within-window retry of the same presented
    // refresh is served idempotently — authcode leases only. Prune stale
    // entries opportunistically; traffic is dozens/day, so the map stays tiny.
    if (isAuthcode) {
      for (const [key, entry] of this.authcodeGrace) {
        if (now - entry.mintedAt > AUTHCODE_GRACE_MS) this.authcodeGrace.delete(key);
      }
      this.authcodeGrace.set(hash, {
        accessToken: pair.accessToken, refreshToken: pair.refreshToken, mintedAt: now,
      });
    }
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
      `SELECT l.lease_id AS lease_id, l.door_name AS door_name, l.scope AS scope, l.principal AS principal
         FROM lease_tokens t JOIN leases l ON l.lease_id = t.lease_id
        WHERE t.hash = ? AND t.kind = 'access' AND t.expires > ? AND l.status = 'living'`,
      hash, this.now(),
    ).toArray()[0] as Row | undefined;
    if (!row) return null;
    return {
      leaseId: String(row.lease_id), doorName: String(row.door_name), scope: String(row.scope),
      principal: String(row.principal),
    };
  }

  legacyAllowed(): boolean {
    return this.leaseLiving(LEGACY_LEASE_ID);
  }

  /**
   * The sync worker's window, asked and answered exactly like the gate's. Two
   * windows, two revokes: closing the browser's raw-JWT door early leaves the
   * MCP door standing, and the reverse.
   */
  legacySyncAllowed(): boolean {
    return this.leaseLiving(LEGACY_SYNC_LEASE_ID);
  }

  private leaseLiving(leaseId: string): boolean {
    const row = this.sql.exec(
      'SELECT status FROM leases WHERE lease_id = ?', leaseId,
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
      `SELECT lease_id, door_name, scope, status, born, last_renewal, last_verb, principal, flow
         FROM leases ORDER BY born ASC, door_name ASC`,
    ).toArray() as Row[]).map((row) => ({
      leaseId: String(row.lease_id),
      doorName: String(row.door_name),
      scope: String(row.scope),
      status: String(row.status),
      born: Number(row.born),
      lastRenewal: row.last_renewal === null ? null : Number(row.last_renewal),
      lastVerb: row.last_verb === null ? null : String(row.last_verb),
      principal: String(row.principal),
      flow: String(row.flow),
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

  /** Test seam: column names of a table, for migration assertions. */
  __columnsOf(table: 'leases' | 'lease_tokens' | 'knocks' | 'ledger'): string[] {
    if (!['leases', 'lease_tokens', 'knocks', 'ledger'].includes(table)) {
      throw new Error('unknown table');
    }
    return (this.sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{ name: string }>).map((r) => r.name);
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
    // Every access token minted from here on carries a handle of its own. It is
    // the access row that gets one because it is the access row a live socket
    // and a ledger row need to name; the refresh row is never spoken about out
    // loud, so it keeps its NULL.
    this.sql.exec(
      `INSERT INTO lease_tokens (hash, lease_id, kind, generation, expires, used, token_id)
       VALUES (?, ?, 'access', ?, ?, 0, ?)`,
      pair.accessHash, leaseId, generation, now + ACCESS_TTL_SECONDS * 1000, crypto.randomUUID(),
    );
    this.sql.exec(
      "INSERT INTO lease_tokens (hash, lease_id, kind, generation, expires, used) VALUES (?, ?, 'refresh', ?, NULL, 0)",
      pair.refreshHash, leaseId, generation,
    );
  }

  /**
   * A door is one lease for life: re-knocking revives its row and buries its
   * old tokens. `flow`/`principal` default to the device-flow values so the
   * knock path is unchanged; the authcode path passes `'authcode'` and its own
   * principal, and a re-mint keeps the row on that flow.
   *
   * `mintClass` says which flow is asking, and it is the only thing the
   * reserved-identifier guard trusts. `null` comes back — never a lease — when
   * the name belongs to a different class, belongs to no class at all, or names
   * a reserved row that has stopped being `living`. Every mint path in the DO
   * goes through here, so the guard cannot be walked around by adding a face.
   */
  private upsertLease(
    doorName: string, scope: string, claims: string, now: number,
    flow = 'device', principal = 'julian', mintClass: MintClass = 'device',
  ): string | null {
    const owner = reservedOwner(doorName);
    const reserved = owner !== undefined;
    if (reserved && owner !== mintClass) return null;

    const existing = this.sql.exec(
      'SELECT lease_id, status FROM leases WHERE door_name = ?', doorName,
    ).toArray()[0] as Row | undefined;
    // A reserved name is one identity for life. Once its row stops being
    // `living` — revoked by Marcus, or killed by a rotation replay — no mint
    // path brings it back; only `/leases/reinstate` does. Ordinary doors keep
    // the re-knock revival, which is the whole point of a knock.
    if (reserved && existing && String(existing.status) !== 'living') return null;

    if (existing) {
      const leaseId = String(existing.lease_id);
      this.sql.exec(
        `UPDATE leases SET client_claims = ?, scope = ?, status = 'living',
           last_renewal = ?, flow = ?, principal = ? WHERE lease_id = ?`,
        claims, scope, now, flow, principal, leaseId,
      );
      this.sql.exec('DELETE FROM lease_tokens WHERE lease_id = ?', leaseId);
      return leaseId;
    }
    const leaseId = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO leases
         (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb,
          send_cap_per_day, flow, principal)
       VALUES (?, ?, ?, ?, 'living', ?, NULL, NULL, ?, ?, ?)`,
      leaseId, doorName, claims, scope, now, DEFAULT_LEASE_SEND_CAP, flow, principal,
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
