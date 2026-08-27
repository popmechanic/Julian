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
    // Every production v1 register carries the legacy-window row from the era
    // when the constructor seeded it. The seed is gone (2026-08-27, OPS N-10),
    // so the fixture inserts the historical row itself.
    sql.exec(
      `INSERT INTO leases
         (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb, send_cap_per_day)
       VALUES ('legacy-window', 'legacy-window', '{"issuer":"pocket-id"}', 'full-house', 'living', ?, NULL, NULL, 5)`,
      Date.now(),
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
      // Both rows predate the columns: the historical legacy-window row and
      // the door, both inserted through the v1 column list by rewindToV1.
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
        // The B3 columns read back honestly on a row that predates them.
        subject: null, flow: 'device', tokenId: expect.any(String), sittingPin: null, latched: null,
        exp: expect.any(Number),
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
      // A fresh register seeds nothing, so plant the marker row explicitly.
      state.storage.sql.exec(
        `INSERT INTO leases
           (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb,
            send_cap_per_day, principal, flow)
         VALUES ('door:idem', 'door:idem', '{}', 'full-house', 'living', ?, NULL, NULL, 5, 'not-the-default', 'device')`,
        Date.now(),
      );
      expect((g as unknown as TestSeam).__columnsOf('leases')).toContain('principal');
    });
    await reconstruct(open);

    await runInDurableObject(open(), (g: GovernorDO) => {
      const cols = (g as unknown as TestSeam).__columnsOf('leases');
      expect(cols).toContain('principal');
      expect(cols).toContain('flow');
      expect(g.leaseList().find((l) => l.leaseId === 'door:idem')?.principal).toBe('not-the-default');
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

  test('__columnsOf rejects non-allowlisted table names', async () => {
    await runInDurableObject(register()(), (g: GovernorDO) => {
      const seam = g as unknown as TestSeam;
      expect(() => seam.__columnsOf('leases); DROP TABLE lease_tokens; --' as any)).toThrow('unknown table');
      expect(() => seam.__columnsOf('constructor' as any)).toThrow('unknown table');
      expect(() => seam.__columnsOf('toString' as any)).toThrow('unknown table');
      expect(() => seam.__columnsOf('__proto__' as any)).toThrow('unknown table');
      // Valid tables still work
      expect(seam.__columnsOf('leases')).toBeInstanceOf(Array);
    });
  });
});

// ── B3: subject / sitting_pin / latch / token_id, the ledger indexes, and the
// second legacy window ──────────────────────────────────────────────────────
//
// Same trick as above, one generation later: build the B2-shaped register the
// world is actually running, then force a reconstruction over that storage so
// the constructor's migration runs against a table it did not just create.

const B3_LEASE_COLS = ['subject', 'sitting_pin', 'latch'] as const;
const LEDGER_INDEXES = ['idx_ledger_svc', 'idx_ledger_sub'] as const;
const SYNC_WINDOW = 'legacy-window-sync';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function indexNames(state: DurableObjectState): string[] {
  return (state.storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'index'")
    .toArray() as Array<{ name: string }>).map((r) => r.name);
}

/**
 * Rewind a constructed register to its B2 shape: drop the four columns B3 adds,
 * drop the two ledger indexes, and delete the second legacy window. What is left
 * is indistinguishable from the register a live B2 instance is running today.
 */
async function rewindToB2(open: Open): Promise<void> {
  await runInDurableObject(open(), async (g: GovernorDO, state: DurableObjectState) => {
    const sql = state.storage.sql;
    for (const col of B3_LEASE_COLS) sql.exec(`ALTER TABLE leases DROP COLUMN ${col}`);
    sql.exec('ALTER TABLE lease_tokens DROP COLUMN token_id');
    for (const idx of LEDGER_INDEXES) sql.exec(`DROP INDEX IF EXISTS ${idx}`);
    sql.exec('DELETE FROM leases WHERE lease_id = ?', SYNC_WINDOW);
    // A real B2 register carries the legacy-window row from its seeded era
    // (the seed itself is gone since 2026-08-27 — OPS N-10); insert the
    // historical row the way that register would hold it.
    sql.exec(
      `INSERT OR IGNORE INTO leases
         (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb,
          send_cap_per_day, principal, flow)
       VALUES ('legacy-window', 'legacy-window', '{"issuer":"pocket-id"}', 'full-house', 'living', ?, NULL, NULL, 5, 'julian', 'legacy')`,
      Date.now(),
    );

    const seam = g as unknown as TestSeam;
    for (const col of B3_LEASE_COLS) expect(seam.__columnsOf('leases')).not.toContain(col);
    expect(seam.__columnsOf('lease_tokens')).not.toContain('token_id');
    for (const idx of LEDGER_INDEXES) expect(indexNames(state)).not.toContain(idx);
    expect(g.leaseList().some((l) => l.leaseId === SYNC_WINDOW)).toBe(false);
  });
}

describe('B3 migration: subject, sitting_pin, latch, token_id, ledger indexes', () => {
  test('adds the four columns and both indexes over a pre-B3 register', async () => {
    const open = register();
    await runInDurableObject(open(), () => { /* first construction */ });
    await rewindToB2(open);
    await reconstruct(open);

    await runInDurableObject(open(), (g: GovernorDO, state: DurableObjectState) => {
      const seam = g as unknown as TestSeam;
      const leaseCols = seam.__columnsOf('leases');
      for (const col of B3_LEASE_COLS) expect(leaseCols).toContain(col);
      expect(seam.__columnsOf('lease_tokens')).toContain('token_id');
      const indexes = indexNames(state);
      for (const idx of LEDGER_INDEXES) expect(indexes).toContain(idx);
    });
  });

  test('the new lease columns are nullable and start NULL on rows that predate them', async () => {
    const open = register();
    await runInDurableObject(open(), () => { /* first construction */ });
    await rewindToB2(open);
    await reconstruct(open);

    await runInDurableObject(open(), (_g: GovernorDO, state: DurableObjectState) => {
      const row = state.storage.sql
        .exec('SELECT subject, sitting_pin, latch FROM leases WHERE lease_id = ?', 'legacy-window')
        .one();
      expect(row).toEqual({ subject: null, sitting_pin: null, latch: null });
    });
  });

  test('never seeds legacy-window-sync — the sunset deletion holds on a register that never had one', async () => {
    // Before 2026-08-25 this migration seeded the window living; OPS N-10
    // named that as the revival hazard, and the permanence deploy deleted the
    // seed. A register that never had the row must never grow one.
    const open = register();
    await runInDurableObject(open(), () => { /* first construction */ });
    await rewindToB2(open);
    await reconstruct(open);

    await runInDurableObject(open(), (g: GovernorDO) => {
      expect(g.leaseList().some((l) => l.leaseId === SYNC_WINDOW)).toBe(false);
    });
  });

  test('the production register\'s revoked legacy-window-sync row survives, revoked, untouched', async () => {
    // The live register carries the row Marcus revoked at the sunset. The
    // deletion removed the seed, not the history: a reconstruction must
    // neither delete the row nor revive it.
    const open = register();
    await runInDurableObject(open(), (_g: GovernorDO, state: DurableObjectState) => {
      state.storage.sql.exec(
        `INSERT INTO leases
           (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb,
            send_cap_per_day, flow, principal)
         VALUES (?, ?, ?, 'stream', 'revoked', ?, NULL, NULL, 5, 'legacy', 'julian')`,
        SYNC_WINDOW, SYNC_WINDOW, '{"issuer":"pocket-id"}', Date.now(),
      );
    });
    await reconstruct(open);

    await runInDurableObject(open(), (g: GovernorDO) => {
      expect(g.leaseList().find((l) => l.leaseId === SYNC_WINDOW)?.status).toBe('revoked');
    });
  });

  test('a pre-B3 access token with a NULL token_id still validates after the migration', async () => {
    const open = register();
    const minted = await runInDurableObject(open(), async (g: GovernorDO) => {
      const knock = await g.knockCreate('client', 'host', 'purpose');
      if ('error' in knock) throw new Error('knock refused');
      expect(g.knockDecide(knock.userCode, 'approved', 'door:pre-b3', 'full-house')).toBe(true);
      const ready = await g.devicePoll(knock.deviceCode, 'client');
      if (ready.status !== 'ready') throw new Error(`expected ready, got ${ready.status}`);
      const lease = g.leaseList().find((l) => l.doorName === 'door:pre-b3');
      return { token: ready.accessToken, leaseId: lease?.leaseId ?? '' };
    });
    await rewindToB2(open);   // drops token_id off the row this token lives on
    await reconstruct(open);

    await runInDurableObject(open(), async (g: GovernorDO, state: DurableObjectState) => {
      expect(state.storage.sql.exec(
        "SELECT token_id FROM lease_tokens WHERE lease_id = ? AND kind = 'access'", minted.leaseId,
      ).one()).toEqual({ token_id: null });
      expect(await g.validateAccess(minted.token)).toEqual({
        leaseId: minted.leaseId, doorName: 'door:pre-b3', scope: 'full-house', principal: 'julian',
        // A handle-less token identifies itself as handle-less rather than
        // inventing one: `tokenId` is null, not a fresh UUID.
        subject: null, flow: 'device', tokenId: null, sittingPin: null, latched: null,
        exp: expect.any(Number),
      });
    });
  });

  test('every new access insert stamps its own UUID token_id', async () => {
    await runInDurableObject(register()(), async (g: GovernorDO, state: DurableObjectState) => {
      const first = await g.mintAuthcodeLease('visit:stamp.example', 'reading-room', 'julian', '{}');
      if (first.status !== 'ok') throw new Error('mint failed');
      const leaseId = g.leaseList().find((l) => l.doorName === 'visit:stamp.example')?.leaseId ?? '';
      const idOf = () => String(state.storage.sql.exec(
        "SELECT token_id FROM lease_tokens WHERE lease_id = ? AND kind = 'access'", leaseId,
      ).one().token_id);

      const before = idOf();
      expect(before).toMatch(UUID_RE);
      const rotated = await g.mintFromRefresh(first.refreshToken);
      expect(rotated.status).toBe('ok');
      const after = idOf();
      expect(after).toMatch(UUID_RE);
      expect(after).not.toBe(before);
    });
  });

  test('the B3 migration is idempotent: reconstructing neither throws nor rewrites', async () => {
    const open = register();
    // Values that are not the (NULL) column default: were the PRAGMA guard gone,
    // the re-run ALTER would throw "duplicate column name"; were the columns
    // somehow re-added, these would be gone.
    await runInDurableObject(open(), (_g: GovernorDO, state: DurableObjectState) => {
      // A fresh register seeds nothing, so plant the marker row explicitly.
      state.storage.sql.exec(
        `INSERT INTO leases
           (lease_id, door_name, client_claims, scope, status, born, last_renewal, last_verb,
            send_cap_per_day, principal, flow)
         VALUES ('door:idem-b3', 'door:idem-b3', '{}', 'full-house', 'living', ?, NULL, NULL, 5, 'julian', 'device')`,
        Date.now(),
      );
      state.storage.sql.exec(
        "UPDATE leases SET subject = 'user_marcus', sitting_pin = 'pin-1', latch = '{\"pin\":\"p\",\"path\":\"x\"}'"
        + " WHERE lease_id = 'door:idem-b3'",
      );
    });
    await reconstruct(open);

    await runInDurableObject(open(), (g: GovernorDO, state: DurableObjectState) => {
      const seam = g as unknown as TestSeam;
      for (const col of B3_LEASE_COLS) expect(seam.__columnsOf('leases')).toContain(col);
      expect(state.storage.sql
        .exec('SELECT subject, sitting_pin, latch FROM leases WHERE lease_id = ?', 'door:idem-b3')
        .one()).toEqual({ subject: 'user_marcus', sitting_pin: 'pin-1', latch: '{"pin":"p","path":"x"}' });
      expect(indexNames(state).filter((n) => (LEDGER_INDEXES as readonly string[]).includes(n)).sort())
        .toEqual([...LEDGER_INDEXES].sort());
    });
  });
});
