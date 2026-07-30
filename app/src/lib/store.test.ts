import { describe, expect, test } from 'vitest';
import { createMergeableStore } from 'tinybase';
import { createOpfsPersister } from 'tinybase/persisters/persister-browser';
import { createStreamStore } from 'julian-shared/schema';
import { store, startPersistence, writeMessage, FRAGMENT_SIZE } from './store';

// In-memory FileSystemFileHandle implementing exactly the surface the OPFS
// persister uses: getFile().text() and createWritable().write()/close().
function memHandle(): FileSystemFileHandle {
  let data = '';
  return {
    getFile: async () => ({ text: async () => data }),
    createWritable: async () => ({
      write: async (s: string) => {
        data = s;
      },
      close: async () => {},
    }),
  } as unknown as FileSystemFileHandle;
}

describe('client store', () => {
  test('fragment size is set for Cloudflare WS limits', () => {
    expect(FRAGMENT_SIZE).toBe(262144);
  });

  test('writeMessage is idempotent by row id', () => {
    writeMessage('evt-1', { sessionId: 's', role: 'user', speakerName: 'Marcus', text: 'hi', ts: 1 });
    writeMessage('evt-1', { sessionId: 's', role: 'user', speakerName: 'Marcus', text: 'hi', ts: 1 });
    expect(store.getRowIds('messages')).toEqual(['evt-1']);
  });

  test('persistence round-trips into a FRESH store (real reload semantics)', async () => {
    const handle = memHandle();
    const persister = await startPersistence(handle);
    expect(persister).not.toBeNull();
    writeMessage('evt-2', { sessionId: 's', role: 'assistant', speakerName: 'Julian', text: 'hello', ts: 2 });
    await persister!.save();
    await persister!.destroy();

    // A fresh store loading the same file — this is what a browser reload does.
    const reloaded = createStreamStore('reloaded');
    const p2 = createOpfsPersister(reloaded, handle);
    await p2.load();
    expect(reloaded.getCell('messages', 'evt-2', 'text')).toBe('hello');
    await p2.destroy();
  });

  test('reload preserves CRDT stamps: stale cache cannot beat newer server state', async () => {
    // t0: device and server agree
    const server = createMergeableStore('server');
    const device = createMergeableStore('device');
    server.setCell('m', 'r', 'text', 'old');
    device.merge(server as never);

    // device persists to OPFS (full mergeable content, stamps included)
    const handle = memHandle();
    const devicePersister = createOpfsPersister(device, handle);
    await devicePersister.save();
    await devicePersister.destroy();

    // t1: another device updates the server
    await new Promise((r) => setTimeout(r, 10));
    server.setCell('m', 'r', 'text', 'new');

    // t2: stale device reloads from OPFS and syncs
    await new Promise((r) => setTimeout(r, 10));
    const rebooted = createMergeableStore('device');
    const rebootPersister = createOpfsPersister(rebooted, handle);
    await rebootPersister.load();
    server.merge(rebooted as never);

    // With content-only persistence (IndexedDB) this was 'old' — the bug.
    expect(server.getCell('m', 'r', 'text')).toBe('new');
    await rebootPersister.destroy();
  });
});
