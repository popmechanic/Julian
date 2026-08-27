// sync/test/do.test.ts
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { SYNC_AUTH_HEADER, type SyncAuthPayload } from 'julian-shared/gate-contract';
import type { JulianSyncDO, SocketAttachment } from '../src/do';

function stub() {
  return env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(`test/do-${crypto.randomUUID().slice(0, 8)}`));
}

/** A router-shaped upgrade: the handoff header, and a client key to find the socket by. */
function upgradeRequest(payload: SyncAuthPayload | null, clientId: string): Request {
  const headers: Record<string, string> = {
    Upgrade: 'websocket',
    'sec-websocket-key': clientId,
  };
  if (payload !== null) headers[SYNC_AUTH_HEADER] = JSON.stringify(payload);
  return new Request('https://sync.test/julian/chat', { headers });
}

function socketFor(instance: JulianSyncDO, clientId: string): WebSocket | undefined {
  return (instance as unknown as { ctx: DurableObjectState }).ctx.getWebSockets(clientId)[0];
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
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
      instance.store.setRow('messages', 'm1', { sessionId: 's', role: 'user', speakerName: 'M', text: 'ok', ts: 1 });
      instance.store.setCell('messages', 'm1', 'text', 'x'.repeat(70_000));
      expect(instance.store.getCell('messages', 'm1', 'text')).toBe('ok');
    });
  });

  test('oversized cell arriving via sync merge is rejected, rest of merge lands', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
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
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
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
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
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

  test('fetch: the socket attachment is handles only — no bearer is ever serialized', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const clientId = `k-${crypto.randomUUID()}`;
      const res = await instance.fetch(upgradeRequest({
        leaseId: 'L-attach-1', tokenId: 't-attach-1', subject: 'lease:L-attach-1',
        scope: 'stream', flow: 'exchange', principal: 'julian', exp: 1893456000,
      }, clientId));
      expect(res.status).toBe(101);

      const attachment = socketFor(instance, clientId)?.deserializeAttachment() as SocketAttachment;
      expect(attachment.leaseId).toBe('L-attach-1');
      expect(attachment.tokenId).toBe('t-attach-1');
      expect(attachment.subject).toBe('lease:L-attach-1');
      expect(attachment.exp).toBe(1893456000);
      expect(attachment.flow).toBe('exchange');
      expect(attachment.indefiniteSweeps).toBe(0);
      expect(attachment.verifiedAt).toBeGreaterThan(0);

      // The whole point of the handle attachment: a hibernating socket holds
      // no credential anyone could replay. Assert on the serialized form, not
      // on the fields we happened to name above — a token smuggled into any
      // future field has to fail this.
      const serialized = JSON.stringify(attachment);
      expect(serialized).not.toMatch(/jla_|jlr_|jst_/);
      expect(serialized).not.toContain('Bearer');
      expect(Object.keys(attachment).sort()).toEqual(
        ['exp', 'flow', 'indefiniteSweeps', 'leaseId', 'subject', 'tokenId', 'verifiedAt'],
      );
    });
  });

  test('fetch: an upgrade carrying an Authorization bearer still attaches only handles', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const clientId = `k-${crypto.randomUUID()}`;
      const req = new Request(upgradeRequest({
        leaseId: 'L-attach-2', tokenId: 't-attach-2', subject: 'lease:L-attach-2',
        scope: 'full-house', flow: 'device', principal: 'julian',
      }, clientId), { headers: undefined });
      const headers = new Headers(req.headers);
      headers.set('Authorization', 'Bearer jla_ThisMustNeverBeStored');
      expect((await instance.fetch(new Request(req, { headers }))).status).toBe(101);

      const attachment = socketFor(instance, clientId)?.deserializeAttachment() as SocketAttachment;
      expect(JSON.stringify(attachment)).not.toContain('jla_');
      expect(attachment.leaseId).toBe('L-attach-2');
    });
  });

  test('fetch: an upgrade with no handoff header is refused, not accepted unauthenticated', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const clientId = `k-${crypto.randomUUID()}`;
      const res = await instance.fetch(upgradeRequest(null, clientId));
      expect(res.status).toBe(401);
      // Nothing was accepted: an un-introspectable socket is worse than none.
      expect(socketFor(instance, clientId)).toBeUndefined();
    });
  });

  test('fetch: an upgrade with a malformed handoff header is refused', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      const clientId = `k-${crypto.randomUUID()}`;
      const res = await instance.fetch(new Request('https://sync.test/julian/chat', {
        headers: { Upgrade: 'websocket', 'sec-websocket-key': clientId, [SYNC_AUTH_HEADER]: 'not-json' },
      }));
      expect(res.status).toBe(401);
      expect(socketFor(instance, clientId)).toBeUndefined();
    });
  });

  test('lineage: first set passes, overwrite is refused on the local path (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
      instance.store.setValue('ledgerId', 'L1');
      expect(instance.store.getValue('ledgerId')).toBe('L1'); // creation still works
      instance.store.setValue('ledgerId', 'EVIL');
      expect(instance.store.getValue('ledgerId')).toBe('L1'); // once set, immutable
      instance.store.setValue('ledgerId', 'L1'); // equal re-write: harmless no-op
      expect(instance.store.getValue('ledgerId')).toBe('L1');
    });
  });

  test('lineage: every key in the set is guarded; activeSessionId stays mutable (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
      instance.store.setValues({
        ledgerId: 'L1', parentLedgerId: 'P1', lineageNote: 'N1', createdAt: 111, createdBy: 'Julian & Marcus',
        activeSessionId: 's1',
      });
      instance.store.setValues({
        ledgerId: 'X', parentLedgerId: 'X', lineageNote: 'X', createdAt: 999, createdBy: 'X',
        activeSessionId: 's2',
      } as never);
      expect(instance.store.getValue('ledgerId')).toBe('L1');
      expect(instance.store.getValue('parentLedgerId')).toBe('P1');
      expect(instance.store.getValue('lineageNote')).toBe('N1');
      expect(instance.store.getValue('createdAt')).toBe(111);
      expect(instance.store.getValue('createdBy')).toBe('Julian & Marcus');
      expect(instance.store.getValue('activeSessionId')).toBe('s2'); // runtime state, not lineage
    });
  });

  test('lineage: a merge-path overwrite is stripped and converged away (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
      instance.store.setValue('ledgerId', 'L1');
      // The synchronizer path: plain changes with stamps already stripped —
      // exactly what willApplyChanges receives from a foreign socket.
      instance.store.applyChanges([{}, { ledgerId: 'EVIL' }, 1] as never);
      expect(instance.store.getValue('ledgerId')).toBe('L1'); // plain store protected
      // Let the corrective microtask flush run, then confirm the stamp tree
      // converged back: a fresh merge of the store's own content must carry L1.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(instance.store.getValue('ledgerId')).toBe('L1');
      const content = instance.store.getMergeableContent() as unknown as [unknown, [Record<string, unknown>]];
      expect(JSON.stringify(content)).toContain('L1');
      expect(JSON.stringify(instance.store.getMergeableContent())).not.toContain('EVIL');
    });
  });

  test('lineage: a real replica merge cannot overwrite lineage, and re-syncs back to the true value (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
      const { createStreamStore } = await import('julian-shared/schema');
      instance.store.setValue('ledgerId', 'L1');
      // A foreign replica that never saw L1 claims its own lineage and syncs in.
      const remote = createStreamStore('remote-lineage');
      remote.setValue('ledgerId', 'EVIL');
      remote.setValue('activeSessionId', 's-remote');
      instance.store.applyMergeableChanges(remote.getMergeableContent() as never);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(instance.store.getValue('ledgerId')).toBe('L1');
      expect(instance.store.getValue('activeSessionId')).toBe('s-remote'); // rest of the merge lands

      // The stamp tree is the sync surface: a replica syncing back from the DO
      // must receive L1, not EVIL, or the guard guards nothing.
      const replica = createStreamStore('replica-lineage');
      replica.applyMergeableChanges(instance.store.getMergeableContent() as never);
      expect(replica.getValue('ledgerId')).toBe('L1');

      // And the offender, on syncing back, converges too.
      remote.applyMergeableChanges(instance.store.getMergeableContent() as never);
      expect(remote.getValue('ledgerId')).toBe('L1');
    });
  });

  test('lineage: a second merge overwrite after a restore is also converged away (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
      const { createStreamStore } = await import('julian-shared/schema');
      instance.store.setValue('createdAt', 111);
      const remote = createStreamStore('remote-lineage-2x');
      remote.setValue('createdAt', 999);
      instance.store.applyMergeableChanges(remote.getMergeableContent() as never);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(instance.store.getValue('createdAt')).toBe(111);

      remote.applyMergeableChanges(instance.store.getMergeableContent() as never);
      remote.setValue('createdAt', 777);
      instance.store.applyMergeableChanges(remote.getMergeableContent() as never);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(instance.store.getValue('createdAt')).toBe(111);
      const replica = createStreamStore('replica-lineage-2x');
      replica.applyMergeableChanges(instance.store.getMergeableContent() as never);
      expect(replica.getValue('createdAt')).toBe(111);
    });
  });

  test('lineage: a merge that only re-states the existing lineage is left untouched (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
      instance.store.setValue('ledgerId', 'L1');
      const before = JSON.stringify(instance.store.getMergeableContent());
      instance.store.applyChanges([{}, { ledgerId: 'L1', activeSessionId: 's9' }, 1] as never);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(instance.store.getValue('ledgerId')).toBe('L1');
      expect(instance.store.getValue('activeSessionId')).toBe('s9');
      // No restore bounce fired: the receipt marker never entered the tree.
      expect(JSON.stringify(instance.store.getMergeableContent())).not.toContain('lineage-restore');
      expect(before).toContain('L1');
    });
  });

  test('lineage: deletion is refused too, so delete-then-set cannot launder an overwrite (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
      instance.store.setValue('ledgerId', 'L1');
      instance.store.delValue('ledgerId');
      expect(instance.store.getValue('ledgerId')).toBe('L1');
      // Without the deletion guard this second write would look like a first
      // set (existing === undefined) and land — the whole guard laundered.
      instance.store.setValue('ledgerId', 'EVIL');
      expect(instance.store.getValue('ledgerId')).toBe('L1');
      // delValues() would wipe lineage wholesale; refused while lineage is set.
      instance.store.delValues();
      expect(instance.store.getValue('ledgerId')).toBe('L1');
    });
  });

  test('lineage: a merge-path deletion is stripped and converged away (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.ensureGuards(); // guards install lazily now (see createPersister) — this test exercises them
      const { createStreamStore } = await import('julian-shared/schema');
      instance.store.setValue('ledgerId', 'L1');
      instance.store.applyChanges([{}, { ledgerId: undefined }, 1] as never);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(instance.store.getValue('ledgerId')).toBe('L1');
      const replica = createStreamStore('replica-lineage-del');
      replica.applyMergeableChanges(instance.store.getMergeableContent() as never);
      expect(replica.getValue('ledgerId')).toBe('L1');
    });
  });

  test('lineage: an empty store still accepts the creation ceremony wholesale (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.store.setValues({
        ledgerId: 'L-new', parentLedgerId: 'P-old', lineageNote: 'note',
        createdAt: 42, createdBy: 'Julian & Marcus',
      } as never);
      expect(instance.store.getValue('ledgerId')).toBe('L-new');
      expect(instance.store.getValue('parentLedgerId')).toBe('P-old');
      expect(instance.store.getValue('lineageNote')).toBe('note');
      expect(instance.store.getValue('createdAt')).toBe(42);
      expect(instance.store.getValue('createdBy')).toBe('Julian & Marcus');
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
