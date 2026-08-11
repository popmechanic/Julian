import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import type { GovernorDO } from '../src/index';

function gov(name: string) {
  return env.GOVERNOR.get(env.GOVERNOR.idFromName(name)) as unknown as DurableObjectStub<GovernorDO>;
}

describe('GovernorDO authcode mint', () => {
  test('refuses full-house on the authcode path, server-side', async () => {
    await runInDurableObject(gov('t-ac-full'), async (i: GovernorDO) => {
      const r = await i.mintAuthcodeLease('visit:claude.ai', 'full-house', 'julian', '{}');
      expect(r.status).toBe('invalid');
    });
  });

  test('mints a reading-room authcode lease with flow=authcode', async () => {
    await runInDurableObject(gov('t-ac-ok'), async (i: GovernorDO) => {
      const r = await i.mintAuthcodeLease('visit:claude.ai', 'reading-room', 'julian', '{}');
      expect(r.status).toBe('ok');
      const row = i.leaseList().find((l) => l.doorName === 'visit:claude.ai');
      expect(row?.flow).toBe('authcode');
      expect(row?.scope).toBe('reading-room');
    });
  });

  test('reuse-grace: a repeated refresh within the window returns the same pair (authcode only)', async () => {
    await runInDurableObject(gov('t-ac-grace'), async (i: GovernorDO) => {
      const minted = await i.mintAuthcodeLease('visit:cli', 'reading-room', 'julian', '{}');
      if (minted.status !== 'ok') throw new Error('mint failed');
      const first = await i.mintFromRefresh(minted.refreshToken);
      const second = await i.mintFromRefresh(minted.refreshToken); // same presented token, within window
      expect(first.status).toBe('ok');
      expect(second.status).toBe('ok');
      if (first.status === 'ok' && second.status === 'ok') {
        expect(second.refreshToken).toBe(first.refreshToken); // idempotent, not a kill
      }
    });
  });
});
