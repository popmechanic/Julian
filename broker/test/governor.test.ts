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
});
