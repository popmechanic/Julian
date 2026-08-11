import { DurableObject } from 'cloudflare:workers';

// The DCR/authcode store: dynamically registered public clients (`clients`)
// and the pending/spent authorization codes issued to them (`authcodes`).
// Isolated in its own DO from `GovernorDO` — the register of who was let in
// stays a leaner, single-purpose object than the client directory that feeds
// it.

const TOKEN_BYTES = 32; // 256 bits → 43 base64url characters
// Unapproved clients and every authcode are ephemeral scaffolding of an
// in-flight consent. Anything older than this that never completed is swept
// on the next write — a registration a browser abandoned leaves no residue.
const SWEEP_MS = 2 * 60 * 60 * 1000; // 2h

type Row = Record<string, unknown>;

/** A random opaque token, base64url, matching `governor.ts`'s idiom. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The PKCE S256 challenge for a verifier: `base64url(sha256(verifier))`. */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Loopback per RFC 8252: `localhost` or the literal `127.0.0.1`. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * An acceptable client callback: an `https` URL, or an `http` loopback
 * (`http://localhost[:port]` / `http://127.0.0.1[:port]`). Anything else —
 * plain `http` to a public host, custom schemes — is refused.
 */
function acceptableRedirect(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && isLoopback(u.hostname)) return u;
  return null;
}

/**
 * RFC 8252 redirect comparison: exact on `protocol + hostname + pathname`,
 * ignoring `port` when the host is loopback (the client picks an ephemeral
 * port at request time). A non-loopback host must match port too.
 */
function redirectMatches(a: string, b: string): boolean {
  let ua: URL;
  let ub: URL;
  try {
    ua = new URL(a);
    ub = new URL(b);
  } catch {
    return false;
  }
  if (ua.protocol !== ub.protocol) return false;
  if (ua.hostname !== ub.hostname) return false;
  if (ua.pathname !== ub.pathname) return false;
  const loopback = isLoopback(ua.hostname) && isLoopback(ub.hostname);
  if (!loopback && ua.port !== ub.port) return false;
  return true;
}

export class RegistrarDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS clients (
      client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, origin TEXT NOT NULL,
      created INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS authcodes (
      code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL, resource TEXT NOT NULL, elected_scope TEXT,
      approver_sub TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0)`);
  }

  /** The only clock the DO reads. Tests override it to drive expiry. */
  now(): number { return Date.now(); }
  private get sql(): SqlStorage { return this.ctx.storage.sql; }

  /**
   * Register a public DCR client. Refuses anything that is not
   * `token_endpoint_auth_method: 'none'`; requires at least one acceptable
   * (`https` or `http` loopback) redirect_uri; records the decoded origin of
   * the first acceptable URI. Sweeps abandoned scaffolding on entry.
   */
  async registerClient(meta: {
    redirect_uris: string[];
    token_endpoint_auth_method: string;
    client_name?: string;
  }): Promise<{ client_id: string } | { error: string }> {
    this.sweep();
    if (meta.token_endpoint_auth_method !== 'none') {
      return { error: 'invalid_client_metadata: only public clients (token_endpoint_auth_method=none) are registered' };
    }
    const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
    const first = uris.map((u) => acceptableRedirect(u)).find((u): u is URL => u !== null);
    if (!first) {
      return { error: 'invalid_redirect_uri: at least one https or http loopback redirect_uri is required' };
    }
    const clientId = randomToken();
    this.sql.exec(
      'INSERT INTO clients (client_id, redirect_uris, origin, created, approved) VALUES (?, ?, ?, ?, 0)',
      clientId, JSON.stringify(uris), first.origin, this.now(),
    );
    return { client_id: clientId };
  }

  /**
   * Stage a pending authorization code for a known client. The `redirect_uri`
   * must exact-match one the client registered (loopback ignores port). The
   * row is keyed by `sha256(pendingId)`; the opaque `pendingId` is returned
   * (the value the browser cookie carries) and never stored in the clear.
   */
  async createPending(p: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    resource: string;
    ttlSeconds: number;
  }): Promise<{ pendingId: string } | { error: string }> {
    this.sweep();
    const client = this.sql.exec(
      'SELECT redirect_uris FROM clients WHERE client_id = ?', p.client_id,
    ).toArray()[0] as Row | undefined;
    if (!client) return { error: 'unknown_client' };
    const registered = JSON.parse(String(client.redirect_uris)) as string[];
    if (!registered.some((u) => redirectMatches(u, p.redirect_uri))) {
      return { error: 'invalid_redirect_uri' };
    }
    const pendingId = randomToken();
    const codeHash = await sha256Hex(pendingId);
    const now = this.now();
    this.sql.exec(
      `INSERT INTO authcodes
        (code_hash, client_id, redirect_uri, code_challenge, resource,
         elected_scope, approver_sub, created, expires, used)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0)`,
      codeHash, p.client_id, p.redirect_uri, p.code_challenge, p.resource,
      now, now + p.ttlSeconds * 1000,
    );
    return { pendingId };
  }

  /**
   * Bind an approver's decision to a staged code: sets `elected_scope` and
   * `approver_sub` on the matching un-used, un-expired row. Returns false if
   * no such row exists.
   */
  async attachApproval(pendingId: string, approverSub: string, electedScope: string): Promise<boolean> {
    const codeHash = await sha256Hex(pendingId);
    const changed = this.sql.exec(
      `UPDATE authcodes SET elected_scope = ?, approver_sub = ?
         WHERE code_hash = ? AND used = 0 AND expires > ?`,
      electedScope, approverSub, codeHash, this.now(),
    ).rowsWritten;
    return changed > 0;
  }

  /**
   * The un-privileged view the approval page renders. Returns the client,
   * origin, and the redirect_uri the code targets — never the challenge, the
   * scope, or the approver. Null when the pendingId is unknown.
   */
  async pendingView(
    pendingId: string,
  ): Promise<{ client_id: string; origin: string; redirect_uri: string } | null> {
    const codeHash = await sha256Hex(pendingId);
    const row = this.sql.exec(
      `SELECT a.client_id AS client_id, a.redirect_uri AS redirect_uri, c.origin AS origin
         FROM authcodes a JOIN clients c ON c.client_id = a.client_id
        WHERE a.code_hash = ?`,
      codeHash,
    ).toArray()[0] as Row | undefined;
    if (!row) return null;
    return {
      client_id: String(row.client_id),
      origin: String(row.origin),
      redirect_uri: String(row.redirect_uri),
    };
  }

  /**
   * Redeem a code for its elected scope. Single-use (marks `used=1`); requires
   * both `elected_scope` and `approver_sub` set; re-checks `client_id` and the
   * exact `redirect_uri`; verifies PKCE S256; refuses expired or already-used.
   * Derives a stable `door_name` (`visit:<origin-host>`) from the client origin.
   */
  async redeem(p: {
    code: string;
    client_id: string;
    redirect_uri: string;
    code_verifier: string;
  }): Promise<{ elected_scope: string; door_name: string } | { error: string }> {
    const codeHash = await sha256Hex(p.code);
    const row = this.sql.exec(
      `SELECT a.client_id AS client_id, a.redirect_uri AS redirect_uri,
              a.code_challenge AS code_challenge, a.elected_scope AS elected_scope,
              a.approver_sub AS approver_sub, a.expires AS expires, a.used AS used,
              c.origin AS origin
         FROM authcodes a JOIN clients c ON c.client_id = a.client_id
        WHERE a.code_hash = ?`,
      codeHash,
    ).toArray()[0] as Row | undefined;
    if (!row) return { error: 'invalid_grant' };
    if (Number(row.used) !== 0) return { error: 'invalid_grant: used' };
    if (Number(row.expires) <= this.now()) return { error: 'invalid_grant: expired' };
    if (row.elected_scope == null || row.approver_sub == null) {
      return { error: 'invalid_grant: not approved' };
    }
    if (String(row.client_id) !== p.client_id) return { error: 'invalid_grant: client mismatch' };
    if (!redirectMatches(String(row.redirect_uri), p.redirect_uri)) {
      return { error: 'invalid_grant: redirect mismatch' };
    }
    const computed = await pkceChallenge(p.code_verifier);
    if (computed !== String(row.code_challenge)) return { error: 'invalid_grant: pkce' };
    // Single-use: burn the row before returning. The guard re-asserts un-used
    // so two racing redemptions cannot both succeed.
    const burned = this.sql.exec(
      'UPDATE authcodes SET used = 1 WHERE code_hash = ? AND used = 0', codeHash,
    ).rowsWritten;
    if (burned === 0) return { error: 'invalid_grant: used' };
    let host: string;
    try {
      host = new URL(String(row.origin)).host;
    } catch {
      return { error: 'invalid_grant: origin' };
    }
    return { elected_scope: String(row.elected_scope), door_name: `visit:${host}` };
  }

  /** Drop authcodes past expiry and unapproved clients older than the window. */
  private sweep(): void {
    const now = this.now();
    this.sql.exec('DELETE FROM authcodes WHERE expires <= ?', now);
    this.sql.exec(
      'DELETE FROM clients WHERE approved = 0 AND created <= ?', now - SWEEP_MS,
    );
  }

  /** Test seam: column names of a table, for migration assertions. */
  __columnsOf(table: 'clients' | 'authcodes'): string[] {
    if (!['clients', 'authcodes'].includes(table)) throw new Error('unknown table');
    return (this.sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{ name: string }>).map((r) => r.name);
  }
}
