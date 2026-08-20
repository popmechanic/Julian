import { beforeEach, describe, expect, test, vi } from 'vitest';

const persister = { destroy: vi.fn() };
const syncHandle = {
  sync: { destroy: vi.fn() },
  ws: { close: vi.fn() },
  client: { reset: vi.fn() },
};
const events = { stop: vi.fn() };

vi.mock('./store', () => ({
  startPersistence: vi.fn(async () => persister),
  startSync: vi.fn(async () => syncHandle),
}));
vi.mock('./events', () => ({ connectEvents: vi.fn(() => events) }));

import { startPersistence, startSync } from './store';
import { clearLocalRecord, startConnection, stopConnection } from './connection';

beforeEach(() => vi.clearAllMocks());

describe('connection lifecycle (#4)', () => {
  test('stop releases every acquired resource', async () => {
    const conn = await startConnection(async () => null);
    await conn.stop();
    expect(syncHandle.sync.destroy).toHaveBeenCalled();
    expect(syncHandle.ws.close).toHaveBeenCalled();
    expect(syncHandle.client.reset).toHaveBeenCalled(); // post-logout ticket minting dies here
    expect(events.stop).toHaveBeenCalled();
    expect(persister.destroy).toHaveBeenCalled();
  });

  test('stop is idempotent and stopConnection stops the current handle', async () => {
    await startConnection(async () => null);
    await stopConnection();
    await stopConnection(); // second call: no throw, no double-release
    expect(syncHandle.sync.destroy).toHaveBeenCalledTimes(1);
  });

  test('stopConnection with no live connection is a no-op', async () => {
    await expect(stopConnection()).resolves.toBeUndefined();
    expect(events.stop).not.toHaveBeenCalled();
    expect(persister.destroy).not.toHaveBeenCalled();
  });

  test('a second startConnection stops the first — never two live connections', async () => {
    const first = await startConnection(async () => null);
    expect(events.stop).not.toHaveBeenCalled();
    await startConnection(async () => null);
    expect(events.stop).toHaveBeenCalledTimes(1);
    expect(syncHandle.sync.destroy).toHaveBeenCalledTimes(1);
    // The superseded handle is inert: stopping it must not release the new one.
    await first.stop();
    expect(syncHandle.sync.destroy).toHaveBeenCalledTimes(1);
    await stopConnection();
    expect(syncHandle.sync.destroy).toHaveBeenCalledTimes(2);
  });

  test('local mode: no sync leg (startSync → null) still stops cleanly', async () => {
    vi.mocked(startSync).mockResolvedValueOnce(null);
    const conn = await startConnection(async () => null);
    await expect(conn.stop()).resolves.toBeUndefined();
    expect(events.stop).toHaveBeenCalledTimes(1);
    expect(persister.destroy).toHaveBeenCalledTimes(1);
    expect(syncHandle.sync.destroy).not.toHaveBeenCalled();
  });

  test('no persister (no OPFS) still stops cleanly', async () => {
    vi.mocked(startPersistence).mockResolvedValueOnce(null);
    const conn = await startConnection(async () => null);
    await expect(conn.stop()).resolves.toBeUndefined();
    expect(persister.destroy).not.toHaveBeenCalled();
    expect(events.stop).toHaveBeenCalledTimes(1);
  });

  test('a failing sync leg releases what was already acquired', async () => {
    const boom = new Error('sync leg down');
    vi.mocked(startSync).mockRejectedValueOnce(boom);
    await expect(startConnection(async () => null)).rejects.toBe(boom);
    // Nothing is left running with no owner.
    expect(events.stop).toHaveBeenCalledTimes(1);
    expect(persister.destroy).toHaveBeenCalledTimes(1);
    // …and no half-built handle is installed as the current connection.
    await stopConnection();
    expect(events.stop).toHaveBeenCalledTimes(1);
  });

  test('clearLocalRecord deletes the OPFS cache file and tolerates absence', async () => {
    const dir = { removeEntry: vi.fn(async () => {}) } as unknown as FileSystemDirectoryHandle;
    await clearLocalRecord(dir);
    expect(dir.removeEntry).toHaveBeenCalledWith('julian-chat.json');
    const missing = {
      removeEntry: vi.fn(async () => { throw new DOMException('nope', 'NotFoundError'); }),
    } as unknown as FileSystemDirectoryHandle;
    await expect(clearLocalRecord(missing)).resolves.toBeUndefined();
  });

  test('clearLocalRecord rethrows a real failure — a silent no-clear is worse than a loud one', async () => {
    const denied = new DOMException('locked', 'NoModificationAllowedError');
    const dir = {
      removeEntry: vi.fn(async () => { throw denied; }),
    } as unknown as FileSystemDirectoryHandle;
    await expect(clearLocalRecord(dir)).rejects.toBe(denied);
  });

  test('clearLocalRecord is a no-op where OPFS does not exist', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
    try {
      await expect(clearLocalRecord()).resolves.toBeUndefined();
    } finally {
      if (saved) Object.defineProperty(globalThis, 'navigator', saved);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});
