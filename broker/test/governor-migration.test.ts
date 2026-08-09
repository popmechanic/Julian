import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { GovernorDO } from '../src/governor';

// A fresh GovernorDO's constructor lays down the leases table without
// principal/flow in its literal CREATE TABLE, then runs a guarded ALTER TABLE
// migration right after — so every construction (fresh object or one that
// inherited an older, unmigrated table) exercises the same migration path,
// and this suite proves both the shape it leaves behind and the values it
// backfills for rows that predate the columns (the legacy pseudo-lease).
function stub() {
  const ns = (env as { GOVERNOR: DurableObjectNamespace }).GOVERNOR;
  return ns.get(ns.idFromName(`migration-${crypto.randomUUID()}`));
}

interface TestSeam { __columnsOf(table: string): string[] }

describe('leases table migration: principal + flow', () => {
  test('migrates a v1 leases table to carry principal and flow', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      const cols = (g as unknown as TestSeam).__columnsOf('leases');
      expect(cols).toContain('principal');
      expect(cols).toContain('flow');
      const legacy = g.leaseList();
      const win = legacy.find((l) => l.leaseId === 'legacy-window');
      expect(win?.principal).toBe('julian');
    });
  });

  test('the migration is idempotent: constructing over an already-migrated table changes nothing', async () => {
    const s = stub();
    await runInDurableObject(s, async (g: GovernorDO) => {
      const cols = (g as unknown as TestSeam).__columnsOf('leases');
      expect(cols).toContain('principal');
      expect(cols).toContain('flow');
    });
    // A second construction over the same durable storage must not throw on
    // re-adding columns that already exist, and must leave the roster intact.
    await runInDurableObject(s, async (g: GovernorDO) => {
      const cols = (g as unknown as TestSeam).__columnsOf('leases');
      expect(cols).toContain('principal');
      expect(cols).toContain('flow');
      expect(g.leaseList().find((l) => l.leaseId === 'legacy-window')?.principal).toBe('julian');
    });
  });

  test('new leases minted after migration default to principal=julian, flow=device', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      const knock = await g.knockCreate('client', 'host', 'purpose');
      if ('error' in knock) throw new Error('knock refused');
      expect(g.knockDecide(knock.userCode, 'approved', 'door:test', 'full-house')).toBe(true);
      await g.devicePoll(knock.deviceCode, 'client');
      const lease = g.leaseList().find((l) => l.doorName === 'door:test');
      expect(lease?.principal).toBe('julian');
      expect(lease?.flow).toBe('device');
    });
  });
});
