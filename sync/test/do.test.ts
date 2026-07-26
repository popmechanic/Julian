// sync/test/do.test.ts
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { JulianSyncDO } from '../src/do';

function stub() {
  return env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(`test/do-${crypto.randomUUID().slice(0, 8)}`));
}

describe('JulianSyncDO', () => {
  test('store enforces schema (unknown cell dropped)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.store.setRow('messages', 'm1', {
        sessionId: 's', role: 'user', speakerName: 'M', text: 'hi', ts: 1, bogus: 'x',
      } as never);
      expect(instance.store.getCell('messages', 'm1', 'bogus' as never)).toBeUndefined();
      expect(instance.store.getCell('messages', 'm1', 'text')).toBe('hi');
    });
  });

  test('oversized cell is rejected', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.store.setRow('messages', 'm1', { sessionId: 's', role: 'user', speakerName: 'M', text: 'ok', ts: 1 });
      instance.store.setCell('messages', 'm1', 'text', 'x'.repeat(70_000));
      expect(instance.store.getCell('messages', 'm1', 'text')).toBe('ok');
    });
  });

  test('exportContent returns content + recomputable hash', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.store.setRow('messages', 'm1', { sessionId: 's', role: 'user', speakerName: 'M', text: 'hello', ts: 1 });
      const out = instance.exportContent();
      const { getHash } = await import('tinybase');
      expect(out.contentHash).toBe(getHash(JSON.stringify(out.mergeableContent)));
      expect(out.ledgerId).toBeNull(); // no creation ceremony has run on a test store
      expect(out.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
