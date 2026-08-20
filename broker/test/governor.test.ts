import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { GovernorDO } from '../src/governor';

function stub() {
  const ns = (env as { GOVERNOR: DurableObjectNamespace }).GOVERNOR;
  return ns.get(ns.idFromName(`test-${crypto.randomUUID().slice(0, 8)}`));
}

describe('GovernorDO', () => {
  test('reserve under cap → ok, counted; over cap → refused AND still logged', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      for (let i = 1; i <= 3; i++) {
        const r = g.reserve('user_marcus', 'mail', 'send', `to=a@b.c subject=n${i}`, 3);
        expect(r).toEqual({ ok: true, count: i, cap: 3 });
      }
      const refused = g.reserve('user_marcus', 'mail', 'send', 'to=a@b.c subject=n4', 3);
      expect(refused.ok).toBe(false);
      expect(refused.count).toBe(3);
      const rows = g.entries();
      expect(rows.length).toBe(4);            // the refused attempt is recorded
      expect(rows[0].allowed).toBe(0);        // newest first: the refusal
      expect(rows[1].allowed).toBe(1);
    });
  });

  test('null cap → always ok, always logged', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      for (let i = 0; i < 25; i++) expect(g.reserve('s', 'mail', 'list', '', null).ok).toBe(true);
      expect(g.entries(100).length).toBe(25);
    });
  });

  test('verbs count independently', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      g.reserve('s', 'mail', 'send', 'd', 1);
      const r = g.reserve('s', 'mail', 'read', 'd', 1);
      expect(r.ok).toBe(true); // read's count is not send's count
    });
  });

  test('entries: newest first, limit respected, detail truncated to 500', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      g.reserve('s', 'mail', 'send', 'x'.repeat(900), null);
      g.reserve('s', 'mail', 'send', 'second', null);
      const rows = g.entries(1);
      expect(rows.length).toBe(1);
      expect(rows[0].detail).toBe('second');
      expect(g.entries(10)[1].detail.length).toBe(500);
    });
  });

  test('cap window is per UTC day: yesterday\'s sends do not count against today', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      const yesterday = Date.now() - 86_400_000;
      for (let i = 0; i < 3; i++) {
        (g as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
          'INSERT INTO ledger (ts, sub, service, verb, detail, allowed) VALUES (?, ?, ?, ?, ?, ?)',
          yesterday, 's', 'mail', 'send', 'old', 1,
        );
      }
      // A window pinned to all-time (dayStart = 0) would count the 3 old rows
      // and refuse; the per-day window admits this as today's first send.
      expect(g.reserve('s', 'mail', 'send', 'today', 3)).toEqual({ ok: true, count: 1, cap: 3 });
    });
  });

  test('cap is one shared bucket across subjects — single shared inbox, by design', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      expect(g.reserve('door-a', 'mail', 'send', 'd', 2).ok).toBe(true);
      expect(g.reserve('door-b', 'mail', 'send', 'd', 2).ok).toBe(true);
      expect(g.reserve('door-c', 'mail', 'send', 'd', 2).ok).toBe(false);
    });
  });

  test('validateAccess returns principal on a living lease', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      const knock = await g.knockCreate('client', 'host', 'purpose');
      if ('error' in knock) throw new Error('knock refused');
      expect(g.knockDecide(knock.userCode, 'approved', 'door:principal-test', 'full-house')).toBe(true);
      const ready = await g.devicePoll(knock.deviceCode, 'client');
      if (ready.status !== 'ready') throw new Error(`expected ready, got ${ready.status}`);
      const identity = await g.validateAccess(ready.accessToken);
      expect(identity?.principal).toBe('julian');
    });
  });

  test('entries: before cursor returns only strictly-older rows, newest first', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      const base = Date.now();
      const sql = (g as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      for (let i = 0; i < 5; i++) {
        sql.exec(
          'INSERT INTO ledger (ts, sub, service, verb, detail, allowed) VALUES (?, ?, ?, ?, ?, ?)',
          base + i * 1000, 's', 'mail', 'send', `row${i}`, 1,
        );
      }
      const page = g.entries(2, base + 3000); // rows strictly older than row3
      expect(page.map((r) => r.detail)).toEqual(['row2', 'row1']); // newest-first, limit 2
      expect(g.entries(50, base).length).toBe(0); // nothing strictly older than row0
      expect(g.entries(50).map((r) => r.detail)[0]).toBe('row4'); // no cursor → unchanged
    });
  });

  test('entries: non-finite before values are ignored by the method (face validates)', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      g.reserve('s', 'mail', 'send', 'only', null);
      expect(g.entries(50, Number.NaN).length).toBe(1); // NaN cursor → uncursored read
    });
  });

  test('entries: every row carries a unique numeric id, descending with the sort order', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      g.reserve('s', 'mail', 'send', 'a', null);
      g.reserve('s', 'mail', 'send', 'b', null);
      const rows = g.entries(50);
      expect(rows.every((r) => Number.isFinite(r.id))).toBe(true);
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length); // unique
      expect(rows[0].id).toBeGreaterThan(rows[1].id); // newest-first ⇒ descending id
    });
  });

  test('entries: compound cursor (before + beforeId) pages losslessly through same-ts rows (#38 redirect)', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      const base = Date.now();
      const sql = (g as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      // one older row, three rows sharing one ts (the collision the plain
      // ts-only cursor cannot page through losslessly), then a newer row.
      sql.exec(
        'INSERT INTO ledger (ts, sub, service, verb, detail, allowed) VALUES (?, ?, ?, ?, ?, ?)',
        base, 's', 'mail', 'send', 'older', 1,
      );
      for (const detail of ['tie-a', 'tie-b', 'tie-c']) {
        sql.exec(
          'INSERT INTO ledger (ts, sub, service, verb, detail, allowed) VALUES (?, ?, ?, ?, ?, ?)',
          base + 1000, 's', 'mail', 'send', detail, 1,
        );
      }
      sql.exec(
        'INSERT INTO ledger (ts, sub, service, verb, detail, allowed) VALUES (?, ?, ?, ?, ?, ?)',
        base + 2000, 's', 'mail', 'send', 'newer', 1,
      );

      const tied = g.entries(50, base + 2000); // strictly older than 'newer'
      expect(tied.map((r) => r.detail)).toEqual(['tie-c', 'tie-b', 'tie-a', 'older']);

      const middle = tied[1]; // 'tie-b'
      // Plain ts-only cursor at the tied timestamp cannot land between the
      // tied rows — it either returns all three or none. The compound
      // cursor lands exactly between tie-b and tie-a.
      const page = g.entries(50, middle.ts, middle.id);
      expect(page.map((r) => r.detail)).toEqual(['tie-a', 'older']);
    });
  });
});
