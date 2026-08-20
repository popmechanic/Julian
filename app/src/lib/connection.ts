// One owner for every connection resource (#4): what startConnection
// acquires, stop() releases — and nothing else holds a reference.
import { OPFS_RECORD_FILE, startPersistence, startSync, type SyncHandle } from './store';
import { connectEvents, type ServerEvent } from './events';
import type { Persister } from 'tinybase/persisters';

export interface ConnectionHandle {
  stop(): Promise<void>;
}

let current: ConnectionHandle | null = null;

// A start is a sequence of awaits, and anything landing between them — a
// logout, a component remount — must win. Each start claims a generation;
// a later start or any stopConnection bumps it, and a start that finds its
// own generation stale releases what it took and installs nothing. Without
// this, a stop landing mid-start no-ops (nothing is installed yet) and the
// in-flight start then installs itself over the top: a live socket, reader
// and persister that no handle can ever stop.
let generation = 0;

// Handed back by a superseded start. Its work is already released, so stop()
// has nothing to do — and callers keep a uniform, awaitable handle. This is
// deliberately not a failure: a benign remount must not read as a broken
// connection at the call site.
const INERT: ConnectionHandle = { async stop() {} };

export async function startConnection(
  getJwt: () => Promise<string | null>,
  opts: { onEphemeral?: (e: ServerEvent) => void } = {},
): Promise<ConnectionHandle> {
  const mine = ++generation; // supersede any start still in flight
  await current?.stop(); // never two live connections
  const superseded = (): boolean => generation !== mine;

  let persister: Persister | null = null;
  let events: { stop(): void } | null = null;
  let sync: SyncHandle | null = null;

  // Release exactly what was acquired — used by stop(), by the failure path,
  // and by supersession, so there is one release order and no way to grow a
  // second one that forgets a leg.
  //
  // Known race, recorded not fixed: destroy() does not drain an OPFS save the
  // persister has already started, so a browser may land that write after
  // logout deletes the file and resurrect the local record. TinyBase's
  // Persister exposes no drain to await, so ordering here cannot close it;
  // pretending otherwise would be worse than naming it.
  const release = (): void => {
    events?.stop();
    if (sync) {
      sync.sync.destroy();
      sync.ws.close();
      sync.client.reset(); // drop the cached access token: no minting past logout
    }
    persister?.destroy();
  };

  if (superseded()) return INERT;

  // Acquire under a guard: a leg that fails AFTER an earlier one succeeded
  // would otherwise leave a live reader or persister running with no handle
  // to stop it — the exact orphan this module exists to make impossible.
  try {
    persister = await startPersistence();
    if (superseded()) {
      release();
      return INERT;
    }
    events = connectEvents({ onEphemeral: opts.onEphemeral });
    sync = await startSync(getJwt); // may reject with SyncStaleError, same as any other sync-leg failure
  } catch (e) {
    release();
    // A start that has ALREADY been superseded owns nothing the caller can
    // observe — installing nothing is correct, but so is settling quietly.
    // Rethrowing here would reject the losing promise, and App.svelte's
    // per-call `.catch` flips the pill to 'stale' — over a healthy, newer
    // connection that superseded this one. Only a failure in the CURRENT
    // attempt is worth surfacing.
    if (superseded()) return INERT;
    throw e;
  }
  if (superseded()) {
    release();
    return INERT;
  }

  let stopped = false;
  const handle: ConnectionHandle = {
    async stop() {
      if (stopped) return;
      stopped = true;
      release();
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}

/** Stop whatever connection is live, and supersede any start in flight. */
export async function stopConnection(): Promise<void> {
  generation += 1;
  await current?.stop();
}

/**
 * Delete the local OPFS cache file. Logout-only; the in-memory store is NEVER
 * wiped (MergeableStore deletions are tombstones that would sync as mass
 * deletions of the record) — the caller hard-reloads the page instead, so the
 * in-memory copy dies without ever syncing again.
 */
export async function clearLocalRecord(dir?: FileSystemDirectoryHandle): Promise<void> {
  if (!dir) {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return;
    dir = await navigator.storage.getDirectory();
  }
  try {
    await dir.removeEntry(OPFS_RECORD_FILE);
  } catch (e) {
    // Absence is success — but a real failure (permission, lock) must be loud:
    // a silently-uncleared record outlives the logout that meant to end it.
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  }
}
