import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import type { RegistrarDO } from '../src/index';

describe('RegistrarDO schema', () => {
  test('creates clients and authcodes tables on fresh storage', async () => {
    const id = env.REGISTRAR.idFromName('t-registrar-fresh');
    const stub = env.REGISTRAR.get(id) as unknown as DurableObjectStub<RegistrarDO>;
    await runInDurableObject(stub, async (instance: RegistrarDO) => {
      expect(instance.__columnsOf('clients')).toEqual(
        expect.arrayContaining(['client_id', 'redirect_uris', 'origin', 'created', 'approved']),
      );
      expect(instance.__columnsOf('authcodes')).toEqual(
        expect.arrayContaining(['code_hash', 'client_id', 'redirect_uri', 'code_challenge',
          'resource', 'elected_scope', 'approver_sub', 'created', 'expires', 'used', 'state']),
      );
    });
  });

  test('an authcodes table that predates the state column gains it (guarded migration)', async () => {
    const id = env.REGISTRAR.idFromName('t-registrar-legacy-state');
    const open = () => env.REGISTRAR.get(id) as unknown as DurableObjectStub<RegistrarDO>;
    // First construction builds the current schema; rewind it to the pre-state
    // shape, evict the instance, and let the constructor migrate on reopen
    // (governor-migration.test.ts idiom).
    await runInDurableObject(open(), async (_i: RegistrarDO, state: DurableObjectState) => {
      state.storage.sql.exec('ALTER TABLE authcodes DROP COLUMN state');
    });
    await runInDurableObject(open(), (_i: RegistrarDO, state: DurableObjectState) => {
      state.abort('test: force reconstruction');
    }).catch(() => { /* aborting rejects the in-flight call, as intended */ });
    await runInDurableObject(open(), async (instance: RegistrarDO) => {
      expect(instance.__columnsOf('authcodes')).toEqual(expect.arrayContaining(['state']));
    });
  });
});
