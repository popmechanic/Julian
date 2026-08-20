import { beforeEach, describe, expect, test, vi } from 'vitest';

const persister = { destroy: vi.fn() };
const syncHandle = {
  sync: { destroy: vi.fn() },
  ws: { close: vi.fn() },
  client: { reset: vi.fn() },
};
const events = { stop: vi.fn() };

vi.mock('./store', async (importOriginal) => {
  // OPFS_RECORD_FILE is threaded through from the REAL module on purpose: a
  // literal here would let store.ts and connection.ts name different files
  // with this test still green — exactly the silent divergence the shared
  // constant exists to prevent. setPhase/syncPhase are threaded through too
  // (real, unmocked) so a test can drive the exact call App.svelte makes
  // (`.catch(() => setPhase('stale'))`) and observe whether it actually ran.
  const actual = await importOriginal<typeof import('./store')>();
  return {
    OPFS_RECORD_FILE: actual.OPFS_RECORD_FILE,
    setPhase: actual.setPhase,
    syncPhase: actual.syncPhase,
    startPersistence: vi.fn(async () => persister),
    startSync: vi.fn(async () => syncHandle),
  };
});
vi.mock('./events', () => ({ connectEvents: vi.fn(() => events) }));

import { OPFS_RECORD_FILE, setPhase, startPersistence, startSync, syncPhase } from './store';
import { clearLocalRecord, startConnection, stopConnection } from './connection';

beforeEach(() => vi.clearAllMocks());

/**
 * Park the sync leg so a start can be superseded mid-flight. `at` resolves
 * when startConnection has reached the sync await; `release` lets it finish.
 */
function parkSync(): { at: Promise<void>; release: () => void } {
  let arrived!: () => void;
  const at = new Promise<void>((r) => {
    arrived = r;
  });
  let release!: () => void;
  const held = new Promise((r) => {
    release = () => r(syncHandle);
  });
  vi.mocked(startSync).mockImplementationOnce(() => {
    arrived();
    return held as never;
  });
  return { at, release };
}

/**
 * Same as parkSync, but `release` REJECTS the parked sync leg instead of
 * resolving it — for proving a superseded start's own failure never escapes.
 */
function parkSyncReject(): { at: Promise<void>; release: (err: unknown) => void } {
  let arrived!: () => void;
  const at = new Promise<void>((r) => {
    arrived = r;
  });
  let release!: (err: unknown) => void;
  const held = new Promise((_resolve, reject) => {
    release = (err: unknown) => reject(err);
  });
  vi.mocked(startSync).mockImplementationOnce(() => {
    arrived();
    return held as never;
  });
  return { at, release };
}

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
    // Asserted through the constant, and the constant comes from store.ts:
    // logout clears the very file startPersistence created.
    expect(OPFS_RECORD_FILE).toBe('julian-chat.json');
    expect(dir.removeEntry).toHaveBeenCalledWith(OPFS_RECORD_FILE);
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

  // A start is a sequence of awaits. Anything that lands between them —
  // a logout, a remount — must not leave the losing start's socket, reader
  // and persister running with no handle able to stop them.
  test('stopConnection during startup: the in-flight start releases and installs nothing', async () => {
    const parked = parkSync();
    const starting = startConnection(async () => null);
    await parked.at; // startConnection is now parked on its sync leg…
    await stopConnection(); // …and superseded before it can install itself
    parked.release();
    const handle = await starting;

    // Every leg it acquired is released.
    expect(events.stop).toHaveBeenCalledTimes(1);
    expect(persister.destroy).toHaveBeenCalledTimes(1);
    expect(syncHandle.sync.destroy).toHaveBeenCalledTimes(1);
    expect(syncHandle.ws.close).toHaveBeenCalledTimes(1);
    expect(syncHandle.client.reset).toHaveBeenCalledTimes(1);

    // And it installed nothing: its handle is inert and no current connection
    // is left for a later stop to find.
    await expect(handle.stop()).resolves.toBeUndefined();
    await stopConnection();
    expect(events.stop).toHaveBeenCalledTimes(1);
    expect(persister.destroy).toHaveBeenCalledTimes(1);
  });

  test('two overlapping starts: exactly one installs, the earlier self-releases', async () => {
    const parked = parkSync();
    const first = startConnection(async () => null);
    await parked.at;
    const second = await startConnection(async () => null); // supersedes the parked one
    parked.release();
    await first;

    // The superseded start released its own legs, exactly once.
    expect(events.stop).toHaveBeenCalledTimes(1);
    expect(persister.destroy).toHaveBeenCalledTimes(1);
    expect(syncHandle.sync.destroy).toHaveBeenCalledTimes(1);

    // Exactly one connection is live: stopping it releases one more set…
    await stopConnection();
    expect(events.stop).toHaveBeenCalledTimes(2);
    expect(persister.destroy).toHaveBeenCalledTimes(2);
    expect(syncHandle.sync.destroy).toHaveBeenCalledTimes(2);
    // …and nothing beyond that remains to release.
    await second.stop();
    await stopConnection();
    expect(events.stop).toHaveBeenCalledTimes(2);
  });

  // App.svelte wires `startConnection(...).catch(connectionFailed('start'))`,
  // and connectionFailed flips the pill to 'stale'. If a SUPERSEDED start's
  // failed sync leg still rethrows, that per-call .catch fires and flips the
  // pill to 'stale' over a healthy, newer connection — the exact bug this
  // test pins. A superseded start's own failure must never escape: it must
  // settle (resolve to an inert handle), so the App.svelte catch never runs.
  test('a superseded start whose sync leg then rejects settles without throwing, and never flips the phase', async () => {
    setPhase('synced'); // simulate: the newer connection is already healthy
    const parked = parkSyncReject();
    const starting = startConnection(async () => null);
    await parked.at; // the losing start is now parked on its sync leg…
    await stopConnection(); // …and superseded before it settles
    const boom = new Error('sync leg down');
    parked.release(boom);

    // The exact call site App.svelte makes on the losing promise:
    const handle = await starting.catch((e) => {
      setPhase('stale');
      throw e;
    });

    // It settled (did not throw), so the .catch body above never ran.
    expect(typeof handle.stop).toBe('function');
    expect(syncPhase()).toBe('synced'); // unchanged — no spurious 'stale'

    // And it installed nothing: everything it acquired was released.
    expect(events.stop).toHaveBeenCalledTimes(1);
    expect(persister.destroy).toHaveBeenCalledTimes(1);
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
