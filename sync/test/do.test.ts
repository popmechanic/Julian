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
