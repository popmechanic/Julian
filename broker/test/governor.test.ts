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
});
