import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { GovernorDO } from '../src/governor';

// The register that shipped in v1 has no principal/flow columns, and there are
// live ones in the world. These cases build that exact table — a constructed
// register with the two columns dropped back off and rows already in it — then
// force the DO to be reconstructed over that storage, which is the only way the
// constructor's migration runs against a table it did not just create.
function namespace(): DurableObjectNamespace {
  return (env as { GOVERNOR: DurableObjectNamespace }).GOVERNOR;
}

/**
 * One register, addressed by name, re-opened on every call: a stub that
 * witnessed an abort stays broken, so each phase takes a fresh handle to the
 * same durable storage rather than reusing the old one.
 */
function register(): Open {
  const ns = namespace();
  const id = ns.idFromName(`migration-${crypto.randomUUID()}`);
  return () => ns.get(id);
}

type Open = () => DurableObjectStub;

interface TestSeam { __columnsOf(table: string): string[] }

const V1_DOOR = 'door:v1-survivor';

/**
 * Rewind a constructed register to its v1 shape: drop the two columns the
 * migration adds, then seed a row through the v1 column list. What is left on
 * disk is indistinguishable from a register that has never been migrated.
 */
async function rewindToV1(open: Open): Promise<void> {
  await runInDurableObject(open(), async (g: GovernorDO, state: DurableObjectState) => {
    const sql = state.storage.sql;
    sql.exec('ALTER TABLE leases DROP COLUMN principal');
    sql.exec('ALTER TABLE leases DROP COLUMN flow');
    sql.exec(
      `INSERT INTO leases
         (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb, send_cap_per_day)
       VALUES (?, ?, '{"issuer":"pocket-id"}', 'full-house', 'living', ?, NULL, NULL, 5)`,
      V1_DOOR, V1_DOOR, Date.now(),
    );
    const cols = (g as unknown as TestSeam).__columnsOf('leases');
    expect(cols).not.toContain('principal');
    expect(cols).not.toContain('flow');
  });
}

/**
 * Evict the live instance. `runInDurableObject` only swaps the fetch handler of
 * an already-running object, so without this the constructor never runs a
 * second time and nothing here would test the migration.
 */
async function reconstruct(open: Open): Promise<void> {
  await runInDurableObject(open(), (_g: GovernorDO, state: DurableObjectState) => {
    state.abort('test: force reconstruction');
  }).catch(() => { /* aborting the instance rejects the in-flight call, as intended */ });
}

describe('leases table migration: principal + flow', () => {
  test('migrates a pre-existing v1 leases table, backfilling the rows already in it', async () => {
    const open = register();
    await runInDurableObject(open(), () => { /* first construction: the v2 table */ });
    await rewindToV1(open);
    await reconstruct(open);

    await runInDurableObject(open(), (g: GovernorDO) => {
      const cols = (g as unknown as TestSeam).__columnsOf('leases');
      expect(cols).toContain('principal');
      expect(cols).toContain('flow');
      const leases = g.leaseList();
      // Both rows predate the columns: the legacy window seeded by the v1
      // constructor, and the door seeded through the v1 column list.
      const win = leases.find((l) => l.leaseId === 'legacy-window');
      expect(win?.principal).toBe('julian');
      expect(win?.flow).toBe('device');
      const survivor = leases.find((l) => l.leaseId === V1_DOOR);
      expect(survivor?.principal).toBe('julian');
      expect(survivor?.flow).toBe('device');
    });
  });

  test('a v1 access token keeps working across the migration and reports its principal', async () => {
    const open = register();
    const minted = await runInDurableObject(open(), async (g: GovernorDO) => {
      const knock = await g.knockCreate('client', 'host', 'purpose');
      if ('error' in knock) throw new Error('knock refused');
      expect(g.knockDecide(knock.userCode, 'approved', 'door:pre-migration', 'full-house')).toBe(true);
      const ready = await g.devicePoll(knock.deviceCode, 'client');
      if (ready.status !== 'ready') throw new Error(`expected ready, got ${ready.status}`);
      const lease = g.leaseList().find((l) => l.doorName === 'door:pre-migration');
      return { token: ready.accessToken, leaseId: lease?.leaseId ?? '' };
    });
    await rewindToV1(open);
    await reconstruct(open);

    await runInDurableObject(open(), async (g: GovernorDO) => {
      expect(await g.validateAccess(minted.token)).toEqual({
        leaseId: minted.leaseId, doorName: 'door:pre-migration', scope: 'full-house', principal: 'julian',
      });
    });
  });

  test('the migration is idempotent: reconstructing over a migrated table neither throws nor rewrites', async () => {
    const open = register();
    // A principal that is not the column default: were the PRAGMA guard gone,
    // the re-run ALTER would throw "duplicate column name: principal" and the
    // reconstruction below would fail outright; were the column somehow re-added,
    // this value would be gone.
    await runInDurableObject(open(), (g: GovernorDO, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE leases SET principal = 'not-the-default' WHERE lease_id = 'legacy-window'");
      expect((g as unknown as TestSeam).__columnsOf('leases')).toContain('principal');
    });
    await reconstruct(open);

    await runInDurableObject(open(), (g: GovernorDO) => {
      const cols = (g as unknown as TestSeam).__columnsOf('leases');
      expect(cols).toContain('principal');
      expect(cols).toContain('flow');
      expect(g.leaseList().find((l) => l.leaseId === 'legacy-window')?.principal).toBe('not-the-default');
    });
  });

  test('new leases minted after migration default to principal=julian, flow=device', async () => {
    await runInDurableObject(register()(), async (g: GovernorDO) => {
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
