import { DurableObject } from 'cloudflare:workers';
import { AUTHCODE_SCOPES, EXCHANGE_SCOPES, KNOCK_SCOPES } from 'julian-shared/scopes';

/**
 * `id` is the ledger table's sqlite `rowid`, aliased on the way out — a
 * unique, monotonically-increasing row identity. The table has no declared
 * primary key and `ts` is bare `Date.now()`, so distinct rows sharing one
 * millisecond are routine; `id` is what lets a cursor land strictly between
 * two same-ts rows (see the compound `before`/`beforeId` cursor on
 * `entries()`) instead of losing or repeating whichever ones a page boundary
 * happens to split.
 */
export interface LedgerEntry {
  id: number; ts: number; sub: string; service: string; verb: string; detail: string; allowed: number;
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
/** The integrity latch: the one `(pin, path)` a door is refused on until it clears. */
export interface LeaseLatch { pin: string; path: string }
/**
 * Everything the register knows about the holder of one credential. B3 grows it
 * by five: the Pocket ID `subject` a browser session belongs to, which `flow`
 * minted it, the access token's own `tokenId` handle, and the two pieces of
 * package state (`sittingPin`, `latched`) the reader needs before it serves a
 * part. All five are honestly nullable — a device lease has no subject, and a
 * token minted before B3 has no handle.
 */
export interface LeaseIdentity {
  leaseId: string; doorName: string; scope: string; principal: string;
  subject: string | null; flow: string; tokenId: string | null;
  sittingPin: string | null; latched: LeaseLatch | null;
  /**
   * When the credential itself dies — the access row's own expiry, in the
   * seconds the wire speaks rather than the milliseconds the register stores.
   * It rides the introspection answer so a socket can measure "my token aged
   * out" (WS 4004, re-exchange) against "my lease died" (WS 4001, terminal).
   *
   * Optional because an identity read from something other than an access row
   * has no expiry to give, and saying nothing is better than inventing a
   * number. Everything `identityFrom` builds carries one.
   */
  exp?: number;
}
/**
 * The by-handle answer, which is three answers and not two. A hibernating
 * socket holds `(leaseId, tokenId)` and nothing else, so a bare null would tell
 * it only that it is not welcome — and the two ways of being unwelcome want
 * opposite responses: a dead lease is terminal, an aged token wants one more
 * exchange. `validateAccess` needs no such split; a bearer that fails is simply
 * not a credential.
 */
export type HandleVerdict =
  | { status: 'active'; identity: LeaseIdentity }
  | { status: 'token-expired' }
  | { status: 'dead' };
/**
 * The answer to a browser's `/exchange`. `leaseId` rides the ok-shape because
 * the face ledgers the success under it, and there is no second round-trip to
 * ask who was just served.
 */
export type ExchangeMintResult =
  | { status: 'ok'; leaseId: string; accessToken: string; tokenId: string; expiresIn: number }
  | { status: 'revoked' }
  | { status: 'session-cap' };
/**
 * The answer to `/socket-ticket`. There is no third outcome: a ticket is either
 * minted or the lease is holding too many live ones already.
 */
export type MintTicketResult =
  | { status: 'ok'; ticket: string; expiresIn: typeof TICKET_TTL_SECONDS }
  | { status: 'cap' };
/**
 * The answer to `/consume-ticket`. The ok-shape is the whole identity the sync
 * worker needs to open the socket, because the ticket is gone by the time it
 * reads this and there is nobody left to ask.
 */
export type ConsumeTicketResult =
  | {
    ok: true; leaseId: string; tokenId: string; subject: string | null;
    scope: string; flow: string; principal: string;
    /**
     * The expiry of the ACCESS TOKEN that minted this ticket, in seconds —
     * never the ticket's own, which is sixty seconds old and spent. The socket
     * carries this in its attachment and measures 4004 against it. Absent when
     * the minting row is gone (rotated away mid-flight), because a socket told
     * nothing falls back on the gate's answers, while a socket told the wrong
     * number closes early.
     */
    exp?: number;
  }
  | { ok: false; error: 'unknown' | 'expired' | 'reused' };
/** The answer to `/leases/reinstate`. One verb, three ways to be told no. */
export type ReinstateResult =
  | { ok: true }
  | { error: 'not-found' | 'not-revoked' | 'not-exchange' };
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

/**
 * How many access tokens one browser session may hold at once — six tabs, or
 * six reloads inside the hour. The seventh is *refused*, never served by
 * evicting the oldest: silently logging a live tab out is indistinguishable
 * from a revoke to the person looking at it, and the honest answer is cheap.
 */
export const EXCHANGE_SESSION_CAP = 6;

/**
 * The socket ticket. A WebSocket upgrade has no header a browser may set, so
 * the credential has to ride in the URL — where it will be logged, kept in
 * history, and handed to anyone reading over a shoulder. Everything about this
 * shape is an answer to that: sixty seconds of life, one single use, and no
 * standing of its own (the ticket buys a lookup of the lease, never a scope).
 *
 * `TICKET_MINT_CAP` bounds how many may be live for one lease at once. Ten is
 * generous for a reconnect storm and small enough that a stolen access token
 * cannot quietly manufacture a drawer full of upgrade credentials.
 */
export const TICKET_PREFIX = 'jst_';
export const TICKET_TTL_SECONDS = 60;
export const TICKET_MINT_CAP = 10;
// The exchange flow hands out exactly one scope, and it is not this file's to
// choose: `EXCHANGE_SCOPES` is spec §5's mint allowlist.
const EXCHANGE_SCOPE = EXCHANGE_SCOPES[0];
// What a browser-session lease says about itself. Unlike a device knock there
// is no client to ask, so the claim is the flow's own constant.
const EXCHANGE_CLAIMS = JSON.stringify({ issuer: 'pocket-id', kind: 'browser-session' });

type Row = Record<string, unknown>;

/**
 * The stored latch, read back defensively. Anything that is not a JSON object
 * carrying two strings is "no latch": a column that has been half-written or
 * hand-edited must not be able to fabricate a pin the reader would trust.
 */
function parseLatch(value: unknown): LeaseLatch | null {
  if (typeof value !== 'string' || value === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { pin, path } = parsed as { pin?: unknown; path?: unknown };
  if (typeof pin !== 'string' || typeof path !== 'string') return null;
  return { pin, path };
}

/** The one place a joined lease/token row becomes an identity. */
function identityFrom(row: Row): LeaseIdentity {
  return {
    leaseId: String(row.lease_id),
    doorName: String(row.door_name),
    scope: String(row.scope),
    principal: String(row.principal),
    subject: row.subject === null || row.subject === undefined ? null : String(row.subject),
    flow: String(row.flow),
    tokenId: row.token_id === null || row.token_id === undefined ? null : String(row.token_id),
    sittingPin: row.sitting_pin === null || row.sitting_pin === undefined ? null : String(row.sitting_pin),
    latched: parseLatch(row.latch),
    exp: expiresToSeconds(row.token_expires),
  };
}

/** The register keeps expiries in milliseconds; every wire that carries one speaks seconds. */
function expiresToSeconds(expires: unknown): number {
  return Math.floor(Number(expires) / 1000);
}

// The columns every identity is built from, joined the same way twice: once by
// secret (`validateAccess`) and once by handle (`validateByHandle`).
const IDENTITY_COLUMNS = `l.lease_id AS lease_id, l.door_name AS door_name, l.scope AS scope,
         l.principal AS principal, l.subject AS subject, l.flow AS flow,
         l.sitting_pin AS sitting_pin, l.latch AS latch, t.token_id AS token_id,
         t.expires AS token_expires`;

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

  // `verb: null` means "the whole service shares one budget" (#35: stream
  // reads draw one combined 500/day allowance across recent/session/search,
  // rather than 500 apiece). Every other caller today passes a concrete verb
  // and keeps its own independent bucket — mail.send, mail.list, and so on
  // are unaffected.
  private countSince(dayStart: number, service: string, verb: string | null, sub: string | null): number {
    const row = verb === null
      ? (sub === null
        ? this.sql.exec(
          'SELECT COUNT(*) AS n FROM ledger WHERE service = ? AND allowed = 1 AND ts >= ?',
          service, dayStart).one()
        : this.sql.exec(
          'SELECT COUNT(*) AS n FROM ledger WHERE sub = ? AND service = ? AND allowed = 1 AND ts >= ?',
          sub, service, dayStart).one())
      : (sub === null
        ? this.sql.exec(
          'SELECT COUNT(*) AS n FROM ledger WHERE service = ? AND verb = ? AND allowed = 1 AND ts >= ?',
          service, verb, dayStart).one()
        : this.sql.exec(
          'SELECT COUNT(*) AS n FROM ledger WHERE sub = ? AND service = ? AND verb = ? AND allowed = 1 AND ts >= ?',
          sub, service, verb, dayStart).one());
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

    const leaseCountVerb = service === 'stream' ? null : verb; // #35: one budget across stream verbs
    const leaseUsed = effectiveLeaseCap === null ? 0 : this.countSince(dayStart, service, leaseCountVerb, sub);
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
   * `_doorName` is accepted and ignored, exactly as in `reserveLease`. Door
   * names come from the register or from nowhere: when the lease is known the
   * register's word lands in the ledger, and when it is *not* known the row is
   * written nameless (`door=`) rather than borrowing the caller's string. A
   * caller holding the introspection secret can therefore never write another
   * door's name into the record — not even by naming a lease that does not
   * exist. The nameless row is the honest one: it says an act happened under a
   * lease id the register cannot vouch for, which is itself worth reading.
   */
  recordAllowed(leaseId: string, _doorName: string, service: string, verb: string, detail: string): void {
    const now = this.now();
    const row = this.sql.exec(
      'SELECT door_name FROM leases WHERE lease_id = ?', leaseId,
    ).toArray()[0] as Row | undefined;
    const name = row ? String(row.door_name) : '';
    this.ledger(now, `lease:${leaseId}`, service, verb, detail ? `door=${name} ${detail}` : `door=${name}`, true);
    this.sql.exec('UPDATE leases SET last_verb = ? WHERE lease_id = ?', `${service}.${verb}`, leaseId);
  }

  /**
   * `before` alone pages on `ts` only (back-compat with the pre-redirect
   * contract). `before` + `beforeId` together page on the compound key
   * `(ts, rowid)` — the only way to land strictly between two rows that
   * share one millisecond, which `ts`-only paging cannot do without either
   * re-serving or dropping the tied group at a page boundary. `beforeId`
   * with no `before` is treated as absent; the HTTP face rejects that
   * combination outright rather than silently ignoring it.
   */
  entries(limit = 50, before?: number, beforeId?: number): LedgerEntry[] {
    const n = Math.min(Math.max(1, Math.floor(limit) || 1), MAX_LIMIT);
    const SELECT = 'SELECT rowid AS id, ts, sub, service, verb, detail, allowed FROM ledger';
    if (before !== undefined && Number.isFinite(before)) {
      if (beforeId !== undefined && Number.isFinite(beforeId)) {
        return this.sql
          .exec(
            `${SELECT} WHERE ts < ? OR (ts = ? AND rowid < ?) ORDER BY ts DESC, rowid DESC LIMIT ?`,
            before,
            before,
            beforeId,
            n,
          )
          .toArray() as unknown as LedgerEntry[];
      }
      return this.sql
        .exec(`${SELECT} WHERE ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?`, before, n)
        .toArray() as unknown as LedgerEntry[];
    }
    return this.sql
      .exec(`${SELECT} ORDER BY ts DESC, rowid DESC LIMIT ?`, n)
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
      `SELECT ${IDENTITY_COLUMNS}
         FROM lease_tokens t JOIN leases l ON l.lease_id = t.lease_id
        WHERE t.hash = ? AND t.kind = 'access' AND t.expires > ? AND l.status = 'living'`,
      hash, this.now(),
    ).toArray()[0] as Row | undefined;
    return row ? identityFrom(row) : null;
  }

  /**
   * The same answer, asked by handle instead of by secret. A live socket holds
   * no bearer any more — it holds `(leaseId, tokenId)` — and this is how it is
   * re-checked without the credential ever being serialized anywhere.
   *
   * Non-ledgering, exactly like `validateAccess`: a re-auth is a read.
   *
   * It answers a `HandleVerdict` rather than a nullable identity because the
   * two ways of failing are not the same event. The predicates are therefore
   * asked one at a time instead of collapsed into the WHERE clause: the row is
   * found first, then the lease's standing, then the token's clock — and in
   * that order, because revocation is terminal and outranks mere age. A lease
   * killed while its token was still in date must not soften into
   * "re-exchange" once the hour passes.
   */
  validateByHandle(leaseId: string, tokenId: string): HandleVerdict {
    // An empty handle is not a handle. Guarded explicitly so a caller that lost
    // its attachment cannot match a pre-B3 row whose `token_id` is absent.
    if (leaseId === '' || tokenId === '') return { status: 'dead' };
    const row = this.sql.exec(
      `SELECT ${IDENTITY_COLUMNS}, l.status AS lease_status
         FROM lease_tokens t JOIN leases l ON l.lease_id = t.lease_id
        WHERE t.lease_id = ? AND t.token_id = ? AND t.kind = 'access'`,
      leaseId, tokenId,
    ).toArray()[0] as Row | undefined;
    // No row at all is dead, not expired: a revoke burns the lease's token rows,
    // and so does a rotation, so "gone" is how a killed credential looks here.
    if (!row) return { status: 'dead' };
    if (String(row.lease_status) !== 'living') return { status: 'dead' };
    if (Number(row.token_expires) <= this.now()) return { status: 'token-expired' };
    return { status: 'active', identity: identityFrom(row) };
  }

  // ── the exchange (a browser session, delegated) ───────────────────────────

  /**
   * Trade a verified Pocket ID subject for one access token on that subject's
   * own `browser:<sub>` lease. Three things make this flow unlike the other two.
   *
   * It mints **no refresh token, ever** (SEC NEW-9): the Pocket ID session is
   * the renewal root, so a browser holds nothing worth stealing for longer than
   * an hour, and the rotation machine — tombstones, replay kills — never applies
   * to it. It therefore never touches `insertPair`, whose first act is to delete
   * the lease's other access rows.
   *
   * It is **additive** (SEC NEW-10): a second tab is a second live token on the
   * same lease, not a re-knock that logs the first one out.
   *
   * And it **refuses at the cap** rather than evicting. The prune below is
   * kind-scoped: expired *access* rows go, and rows of any other kind — a live
   * socket ticket, say — are none of this predicate's business.
   */
  async mintExchangeAccess(sub: string, principal: string): Promise<ExchangeMintResult> {
    // The only await, taken first: every read and write below then runs in one
    // uninterrupted turn, so two concurrent exchanges cannot both squeeze past
    // the session cap.
    const accessToken = ACCESS_PREFIX + randomToken();
    const accessHash = await sha256Hex(accessToken);
    const now = this.now();
    const doorName = BROWSER_PREFIX + sub;

    // Asked before the upsert so a revoked session is told the terminal truth
    // rather than the generic one. `upsertLease`'s reserved-name rule backstops
    // this: it refuses to revive a non-living reserved row either way.
    const existing = this.sql.exec(
      'SELECT status FROM leases WHERE door_name = ?', doorName,
    ).toArray()[0] as Row | undefined;
    if (existing && String(existing.status) !== 'living') return { status: 'revoked' };

    const leaseId = this.upsertLease(
      doorName, EXCHANGE_SCOPE, EXCHANGE_CLAIMS, now, 'exchange', principal, 'exchange', sub,
    );
    if (leaseId === null) return { status: 'revoked' };

    this.sql.exec(
      "DELETE FROM lease_tokens WHERE lease_id = ? AND kind = 'access' AND expires <= ?", leaseId, now,
    );
    const live = Number(
      this.sql.exec(
        "SELECT COUNT(*) AS n FROM lease_tokens WHERE lease_id = ? AND kind = 'access'", leaseId,
      ).one().n,
    );
    if (live >= EXCHANGE_SESSION_CAP) return { status: 'session-cap' };

    // Generation 0 for every exchange token: there is no chain to be a link in,
    // so the rotation arithmetic has nothing to count here.
    const tokenId = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO lease_tokens (hash, lease_id, kind, generation, expires, used, token_id)
       VALUES (?, ?, 'access', 0, ?, 0, ?)`,
      accessHash, leaseId, now + ACCESS_TTL_SECONDS * 1000, tokenId,
    );
    return { status: 'ok', leaseId, accessToken, tokenId, expiresIn: ACCESS_TTL_SECONDS };
  }

  // ── the socket ticket (a bearer that survives one URL) ────────────────────

  /**
   * Mint one sixty-second, single-use ticket against a live access token. The
   * ticket carries no standing of its own: what it stores is the `(leaseId,
   * tokenId)` binding, so consuming it is a lookup of the credential the
   * browser already holds and never a second grant.
   *
   * The prune is kind-scoped, the mirror of `mintExchangeAccess`'s: dead
   * *ticket* rows go, and an access row — expired or not — is none of this
   * predicate's business. A spent ticket is kept until it expires, because a
   * deleted row answers `unknown` and `unknown` is exactly what a reuse must
   * not be allowed to sound like.
   *
   * A retried mint after a lost response is simply a second row. Two live
   * tickets for one session is not a fault; each is single-use, each dies in a
   * minute, and the cap is what bounds the retry.
   */
  async mintTicket(leaseId: string, tokenId: string): Promise<MintTicketResult> {
    // The only await, taken first: every read and write below then runs in one
    // uninterrupted turn, so two concurrent mints cannot both pass the cap.
    const ticket = TICKET_PREFIX + randomToken();
    const hash = await sha256Hex(ticket);
    const now = this.now();

    this.sql.exec(
      "DELETE FROM lease_tokens WHERE lease_id = ? AND kind = 'ticket' AND expires <= ?", leaseId, now,
    );
    const live = Number(
      this.sql.exec(
        "SELECT COUNT(*) AS n FROM lease_tokens WHERE lease_id = ? AND kind = 'ticket'", leaseId,
      ).one().n,
    );
    if (live >= TICKET_MINT_CAP) return { status: 'cap' };

    // Generation 0, like the exchange access rows: there is no chain to be a
    // link in. Two different guards keep this row out of the rotation
    // arithmetic, and they are not the same guard. The tombstone sweep and the
    // successor lookup are `kind`-scoped to the refresh family, so a ticket is
    // outside their WHERE clause entirely. `MAX(generation)` is *not*
    // kind-scoped — it spans every row of the lease — and what keeps a ticket
    // from perturbing it is the hardcoded `0` below: the floor of the
    // generation column can never raise a maximum. Both are load-bearing; this
    // literal is the one holding up the half nothing else covers.
    this.sql.exec(
      `INSERT INTO lease_tokens (hash, lease_id, kind, generation, expires, used, token_id)
       VALUES (?, ?, 'ticket', 0, ?, 0, ?)`,
      hash, leaseId, now + TICKET_TTL_SECONDS * 1000, tokenId,
    );
    return { status: 'ok', ticket, expiresIn: TICKET_TTL_SECONDS };
  }

  /**
   * Spend a ticket. Single-use is claimed by many systems and implemented by
   * few, so here it is as a mechanism rather than an adverb (SEC NEW-8):
   * `sha256Hex` is the only await and it is taken first, so the read, the burn
   * and the ledger below are one uninterrupted turn of the DO's single thread.
   * The burn is a conditional `UPDATE … WHERE used = 0` and **its write count
   * is the arbiter** — the second of two racing presentations writes no row and
   * is told `reused`, with no window between checking and taking.
   *
   * A reuse is a theft signal, not an error code: somebody presented a
   * credential that had already been spent, which one holder cannot do. It
   * lands in the ledger as its own verb so the fold can never collapse it into
   * a count of routine traffic.
   *
   * Expiry is judged *after* the burn, deliberately. A late ticket is dead
   * either way, and spending it on the way out means a ticket that expires
   * mid-flight can never be presented a second time and read as fresh.
   */
  async consumeTicket(ticket: string): Promise<ConsumeTicketResult> {
    const hash = await sha256Hex(ticket);
    const now = this.now();
    const row = this.sql.exec(
      `SELECT t.lease_id AS lease_id, t.token_id AS token_id, t.expires AS expires,
              l.door_name AS door_name, l.scope AS scope, l.principal AS principal,
              l.subject AS subject, l.flow AS flow, l.status AS status
         FROM lease_tokens t JOIN leases l ON l.lease_id = t.lease_id
        WHERE t.hash = ? AND t.kind = 'ticket'`,
      hash,
    ).toArray()[0] as Row | undefined;
    // An unknown ticket, a ticket of the wrong kind, and a ticket whose lease
    // was revoked out from under it (the revoke burns the rows) all sound
    // identical from outside, and none of them is worth a ledger row.
    if (!row) return { ok: false, error: 'unknown' };

    const leaseId = String(row.lease_id);
    const doorName = String(row.door_name);
    const tokenId = row.token_id === null || row.token_id === undefined ? '' : String(row.token_id);
    const sub = `lease:${leaseId}`;

    const burn = this.sql.exec('UPDATE lease_tokens SET used = 1 WHERE hash = ? AND used = 0', hash);
    burn.toArray();
    if (burn.rowsWritten === 0) {
      this.ledger(
        now, sub, 'stream', 'ticket-reused',
        `door=${doorName} socket ticket presented twice token_id=${tokenId}`, false,
      );
      return { ok: false, error: 'reused' };
    }

    if (Number(row.expires) <= now) return { ok: false, error: 'expired' };

    // The lease stopped standing while the ticket was in flight. Refused in the
    // same shape as an unknown ticket — the presenter learns nothing about
    // whose lease died — but with a detail of its own in the record, because
    // from inside the house this is a different event entirely.
    if (String(row.status) !== 'living') {
      this.ledger(
        now, sub, 'stream', 'ticket.consume',
        `door=${doorName} ticket refused: lease not living token_id=${tokenId}`, false,
      );
      return { ok: false, error: 'unknown' };
    }

    // The socket's whole clock, read here because there is nobody left to ask:
    // the expiry of the ACCESS token this ticket was minted against, not the
    // ticket's, which is a minute long and already spent.
    const minting = this.sql.exec(
      "SELECT expires FROM lease_tokens WHERE lease_id = ? AND token_id = ? AND kind = 'access'",
      leaseId, tokenId,
    ).toArray()[0] as Row | undefined;

    this.ledger(now, sub, 'stream', 'ticket.consume', `door=${doorName} token_id=${tokenId}`, true);
    return {
      ok: true,
      leaseId,
      tokenId,
      subject: row.subject === null || row.subject === undefined ? null : String(row.subject),
      scope: String(row.scope),
      flow: String(row.flow),
      principal: String(row.principal),
      ...(minting ? { exp: expiresToSeconds(minting.expires) } : {}),
    };
  }

  // ── package state: sitting pin and integrity latch ────────────────────────
  //
  // Three deliberately dumb writes. The *policy* — who may seat a pin, when a
  // latch may be cleared — lives in Task 16's read path, where the reviewer
  // can see it whole; this file only ever does what it is told. All three are
  // silent no-ops on an unknown lease id: an `UPDATE … WHERE lease_id = ?`
  // that matches no row writes nothing and throws nothing, which is exactly
  // the shape "no such lease" wants here.

  /**
   * Seat a door on a new pin. The reset act clears the latch counter with it
   * (R2-D4): a fresh `package_list` is a fresh sitting, and a latch that
   * belonged to the pin just left behind has nothing left to be about.
   */
  seatSitting(leaseId: string, pin: string): void {
    this.sql.exec('UPDATE leases SET sitting_pin = ?, latch = NULL WHERE lease_id = ?', pin, leaseId);
  }

  /** Store the one `(pin, path)` a door is refused on until it clears. */
  setLatch(leaseId: string, pin: string, path: string): void {
    this.sql.exec(
      'UPDATE leases SET latch = ? WHERE lease_id = ?', JSON.stringify({ pin, path }), leaseId,
    );
  }

  /** Clear the latch without touching the sitting pin underneath it. */
  clearLatch(leaseId: string): void {
    this.sql.exec('UPDATE leases SET latch = NULL WHERE lease_id = ?', leaseId);
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

  /**
   * The one verb that undoes a revoke — and the only one. It is deliberately
   * narrow (SEC NEW-11, COLD M-9):
   *
   *   • status must be `revoked`. A `killed-rotation` row is a theft signal,
   *     and a theft signal is undone by no verb: the lease stays dead and the
   *     holder re-knocks under a fresh name.
   *   • flow must be `exchange`. A device or visit lease that Marcus revoked
   *     stays revoked; those flows already have a way back in — knock again —
   *     and a browser session does not, because `browser:<sub>` is reserved for
   *     life and `upsertLease` will not revive it.
   *
   * Status is judged before flow so that `killed-rotation` names itself the
   * same way on every flow. Nothing is minted: the revoke burned the tokens and
   * they stay burned; the holder simply exchanges their session again. The
   * package state goes with them — a reinstated door is seated nowhere and
   * latched on nothing.
   */
  reinstate(doorNameOrId: string, by: string, reason: string): ReinstateResult {
    const row = this.sql.exec(
      'SELECT lease_id, door_name, status, flow FROM leases WHERE lease_id = ? OR door_name = ? LIMIT 1',
      doorNameOrId, doorNameOrId,
    ).toArray()[0] as Row | undefined;
    if (!row) return { error: 'not-found' };
    if (String(row.status) !== 'revoked') return { error: 'not-revoked' };
    if (String(row.flow) !== 'exchange') return { error: 'not-exchange' };

    const leaseId = String(row.lease_id);
    this.sql.exec(
      "UPDATE leases SET status = 'living', sitting_pin = NULL, latch = NULL WHERE lease_id = ?", leaseId,
    );
    this.ledger(
      this.now(), `lease:${leaseId}`, 'lease', 'reinstated',
      `door=${String(row.door_name)} by=${by} reason=${reason}`, true,
    );
    return { ok: true };
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
   *
   * The purge is flow-aware. Delete-then-insert is the *device and visit*
   * bargain — one credential per door, re-taking it retires the last. A browser
   * session is not that: `flow='exchange'` re-mints update the row and touch no
   * token, because a second tab must not log the first one out (SEC NEW-10).
   */
  private upsertLease(
    doorName: string, scope: string, claims: string, now: number,
    flow = 'device', principal = 'julian', mintClass: MintClass = 'device',
    subject: string | null = null,
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
           last_renewal = ?, flow = ?, principal = ?, subject = ? WHERE lease_id = ?`,
        claims, scope, now, flow, principal, subject, leaseId,
      );
      if (flow !== 'exchange') this.sql.exec('DELETE FROM lease_tokens WHERE lease_id = ?', leaseId);
      return leaseId;
    }
    const leaseId = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO leases
         (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb,
          send_cap_per_day, flow, principal, subject)
       VALUES (?, ?, ?, ?, 'living', ?, NULL, NULL, ?, ?, ?, ?)`,
      leaseId, doorName, claims, scope, now, DEFAULT_LEASE_SEND_CAP, flow, principal, subject,
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
