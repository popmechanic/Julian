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
          'resource', 'elected_scope', 'approver_sub', 'created', 'expires', 'used']),
      );
    });
  });
});
