import { DurableObject } from 'cloudflare:workers';

// The DCR/authcode store: dynamically registered public clients (`clients`)
// and the pending/spent authorization codes issued to them (`authcodes`).
// Isolated in its own DO from `GovernorDO` — the register of who was let in
// stays a leaner, single-purpose object than the client directory that feeds
// it.
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

  /** Test seam: column names of a table, for migration assertions. */
  __columnsOf(table: 'clients' | 'authcodes'): string[] {
    if (!['clients', 'authcodes'].includes(table)) throw new Error('unknown table');
    return (this.sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{ name: string }>).map((r) => r.name);
  }
}
