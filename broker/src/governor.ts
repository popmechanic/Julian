import { DurableObject } from 'cloudflare:workers';

export interface LedgerEntry {
  ts: number; sub: string; service: string; verb: string; detail: string; allowed: number;
}
export interface ReserveResult { ok: boolean; count: number; cap: number | null }

const DAY_MS = 86_400_000;
const MAX_DETAIL = 500;
const MAX_LIMIT = 200;

// One instance serves every service: a single ordered ledger of everything
// the doors did with borrowed hands. Traffic is dozens/day; a DO serializes
// hundreds/second — singular is a feature, not a bottleneck.
export class GovernorDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ledger (
         ts INTEGER NOT NULL, sub TEXT NOT NULL, service TEXT NOT NULL,
         verb TEXT NOT NULL, detail TEXT NOT NULL, allowed INTEGER NOT NULL)`,
    );
  }

  reserve(sub: string, service: string, verb: string, detail: string, capPerDay: number | null): ReserveResult {
    const now = Date.now();
    const dayStart = now - (now % DAY_MS); // UTC day boundary
    const row = this.ctx.storage.sql
      .exec('SELECT COUNT(*) AS n FROM ledger WHERE service = ? AND verb = ? AND allowed = 1 AND ts >= ?',
        service, verb, dayStart)
      .one();
    const used = Number(row.n);
    const ok = capPerDay === null || used < capPerDay;
    this.ctx.storage.sql.exec(
      'INSERT INTO ledger (ts, sub, service, verb, detail, allowed) VALUES (?, ?, ?, ?, ?, ?)',
      now, sub, service, verb, detail.slice(0, MAX_DETAIL), ok ? 1 : 0,
    );
    return { ok, count: used + (ok ? 1 : 0), cap: capPerDay };
  }

  entries(limit = 50): LedgerEntry[] {
    const n = Math.min(Math.max(1, Math.floor(limit) || 1), MAX_LIMIT);
    return this.ctx.storage.sql
      .exec('SELECT ts, sub, service, verb, detail, allowed FROM ledger ORDER BY ts DESC, rowid DESC LIMIT ?', n)
      .toArray() as unknown as LedgerEntry[];
  }
}
