// One owner for every connection resource (#4): what startConnection
// acquires, stop() releases — and nothing else holds a reference.
import { startPersistence, startSync, type SyncHandle } from './store';
import { connectEvents, type ServerEvent } from './events';
import type { Persister } from 'tinybase/persisters';

export interface ConnectionHandle {
  stop(): Promise<void>;
}

let current: ConnectionHandle | null = null;

export async function startConnection(
  getJwt: () => Promise<string | null>,
  opts: { onEphemeral?: (e: ServerEvent) => void } = {},
): Promise<ConnectionHandle> {
  await stopConnection(); // never two live connections

  const persister: Persister | null = await startPersistence();

  // Acquire the remaining legs under a guard: a leg that fails AFTER an
  // earlier one succeeded would otherwise leave a live reader or persister
  // running with no handle to stop it — the exact orphan this module exists
  // to make impossible.
  let events: { stop(): void } | null = null;
  let sync: SyncHandle | null = null;
  try {
    events = connectEvents({ onEphemeral: opts.onEphemeral });
    sync = await startSync(getJwt);
  } catch (e) {
    events?.stop();
    persister?.destroy();
    throw e;
  }

  let stopped = false;
  const handle: ConnectionHandle = {
    async stop() {
      if (stopped) return;
      stopped = true;
      events.stop();
      if (sync) {
        sync.sync.destroy();
        sync.ws.close();
        sync.client.reset(); // drop the cached access token: no minting past logout
      }
      persister?.destroy();
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}

/** Stop whatever connection is live. Safe with none. */
export async function stopConnection(): Promise<void> {
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
    await dir.removeEntry('julian-chat.json');
  } catch (e) {
    // Absence is success — but a real failure (permission, lock) must be loud:
    // a silently-uncleared record outlives the logout that meant to end it.
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  }
}
