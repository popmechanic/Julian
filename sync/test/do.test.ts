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

  test('oversized cell arriving via sync merge is rejected, rest of merge lands', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { createStreamStore } = await import('julian-shared/schema');
      // A remote replica syncs in one oversized cell and one normal row —
      // the synchronizer delivers this via the mergeable apply path, not setCell.
      const remote = createStreamStore('remote-1');
      remote.setRow('messages', 'big', { sessionId: 's', role: 'user', speakerName: 'M', text: 'x'.repeat(70_000), ts: 2 });
      remote.setRow('messages', 'ok', { sessionId: 's', role: 'user', speakerName: 'M', text: 'fits', ts: 3 });
      instance.store.setMergeableContent(remote.getMergeableContent());
      await Promise.resolve(); // the corrective rewrite lands on a microtask
      // The oversized cell is stripped and replaced by a visible receipt.
      expect(instance.store.getCell('messages', 'big', 'text')).toContain('dropped');
      expect(instance.store.getCell('messages', 'big', 'ts')).toBe(2); // rest of the row landed
      expect(instance.store.getCell('messages', 'ok', 'text')).toBe('fits');

      // The plain store is not the sync surface. Stripping a cell in
      // willApplyChanges leaves it in the CRDT stamp tree, which is what the
      // persister, the export, and every replica actually read — so the guard
      // must be asserted there or it guards nothing.
      const content = JSON.stringify(instance.store.getMergeableContent());
      expect(content).not.toContain('x'.repeat(1_000));
      expect(content.length).toBeLessThan(65_536);

      // And a replica syncing back from the DO must not receive the blob.
      const replica = createStreamStore('replica-1');
      replica.applyMergeableChanges(instance.store.getMergeableContent() as never);
      expect(String(replica.getCell('messages', 'big', 'text') ?? '').length)
        .toBeLessThan(1_000);
    });
  });

  test('oversized array cell (messages.content) is converged away, not just number/boolean/string', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { createStreamStore } = await import('julian-shared/schema');
      const remote = createStreamStore('remote-arr');
      remote.setRow('messages', 'bigarr', { sessionId: 's', role: 'assistant', speakerName: 'J', text: 'ok', ts: 4 });
      // content is schema-typed 'array' — the flush sentinel must be type-valid
      // or the schema rejects it, no stamp lands, and the blob stays in the tree.
      remote.setCell('messages', 'bigarr', 'content', [{ type: 'text', text: 'x'.repeat(70_000) }] as never);
      instance.store.setMergeableContent(remote.getMergeableContent());
      await Promise.resolve();
      const content = JSON.stringify(instance.store.getMergeableContent());
      expect(content).not.toContain('x'.repeat(1_000));
      const replica = createStreamStore('replica-arr');
      replica.applyMergeableChanges(instance.store.getMergeableContent() as never);
      expect(JSON.stringify(replica.getCell('messages', 'bigarr', 'content') ?? '')).not.toContain('x'.repeat(1_000));
    });
  });

  test('a second oversized value on an already-dropped cell is also converged away', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const { createStreamStore } = await import('julian-shared/schema');
      const remote = createStreamStore('remote-2x');
      remote.setRow('messages', 'big2', { sessionId: 's', role: 'user', speakerName: 'M', text: 'y'.repeat(70_000), ts: 5 });
      instance.store.setMergeableContent(remote.getMergeableContent());
      await Promise.resolve();
      expect(JSON.stringify(instance.store.getMergeableContent())).not.toContain('y'.repeat(1_000));
      // The replica syncs back (sees the receipt), then overflows the same cell
      // again. The corrective rewrite must differ from the sentinel already in
      // place, or it is a stampless no-op and the second blob survives.
      remote.applyMergeableChanges(instance.store.getMergeableContent() as never);
      remote.setCell('messages', 'big2', 'text', 'z'.repeat(70_000));
      instance.store.applyMergeableChanges(remote.getMergeableContent() as never);
      await Promise.resolve();
      const content = JSON.stringify(instance.store.getMergeableContent());
      expect(content).not.toContain('z'.repeat(1_000));
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
