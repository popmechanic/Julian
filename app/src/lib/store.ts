import { createStreamStore, STORE_PATH } from 'julian-shared/schema';
import { createOpfsPersister } from 'tinybase/persisters/persister-browser';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { getHash } from 'tinybase';
import type { Persister } from 'tinybase/persisters';
import type { Synchronizer } from 'tinybase/synchronizers';

export const FRAGMENT_SIZE = 262144; // 256 KiB — Cloudflare WS messages cap at ~1 MiB

function clientId(): string {
  const KEY = 'julian-client-id';
  let id = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  if (!id) {
    id = crypto.randomUUID();
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, id);
  }
  return id;
}

export const store = createStreamStore(clientId());

export interface MessageRow {
  sessionId: string;
  role: string;
  speakerName: string;
  content?: unknown[];
  text: string;
  ts: number;
  kind?: string;
}

export function writeMessage(id: string, row: MessageRow): void {
  store.setRow('messages', id, { kind: 'chat', ...row });
}

type SyncPhase = 'idle' | 'connecting' | 'synced' | 'offline';
let phase: SyncPhase = 'idle';
const phaseListeners = new Set<(p: SyncPhase) => void>();
function setPhase(p: SyncPhase): void {
  phase = p;
  phaseListeners.forEach((fn) => fn(p));
}
export function syncPhase(): SyncPhase {
  return phase;
}
export function onSyncPhase(fn: (p: SyncPhase) => void): () => void {
  phaseListeners.add(fn);
  return () => phaseListeners.delete(fn);
}

// OPFS, not IndexedDB: TinyBase's IndexedDB persister supports plain Stores
// only — it saves content without CRDT stamps, so a reload re-stamps stale
// data as fresh writes that beat newer server state on the next sync. The
// OPFS persister persists the full MergeableStore, stamps included.
// (`handle` is injectable for tests; the app default lives in OPFS.)
export async function startPersistence(handle?: FileSystemFileHandle): Promise<Persister | null> {
  if (!handle) {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
      return null; // no OPFS (old browser): sync-only, no local cache — degraded, never wrong
    }
    const dir = await navigator.storage.getDirectory();
    handle = await dir.getFileHandle('julian-chat.json', { create: true });
  }
  const persister = createOpfsPersister(store, handle);
  // load() BEFORE startAutoSave(), or boot content overwrites the cache.
  // Deliberately not startAutoPersisting(): its file-change listener needs
  // FileSystemObserver (Chrome-only); cross-device consistency is sync's job.
  await persister.load();
  await persister.startAutoSave();
  return persister;
}

export function streamDebug(): { contentHash: number; messageCount: number } {
  return {
    contentHash: getHash(JSON.stringify(store.getMergeableContent())),
    messageCount: store.getRowIds('messages').length,
  };
}

export async function startSync(getToken: () => Promise<string | null>): Promise<Synchronizer | null> {
  const token = await getToken();
  if (!token) return null;
  setPhase('connecting');
  const base = import.meta.env.VITE_SYNC_URL;
  if (!base) {
    setPhase('offline');
    return null;
  }
  const ws = new ReconnectingWebSocket(
    `${base}/${STORE_PATH}?token=${encodeURIComponent(token)}`,
    [],
    { maxReconnectionDelay: 30_000, minReconnectionDelay: 1_000 },
  );
  ws.addEventListener('open', () => setPhase('synced'));
  ws.addEventListener('close', () => setPhase('offline'));
  const sync = await createWsSynchronizer(
    store,
    ws as unknown as WebSocket,
    5,
    undefined,
    undefined,
    undefined,
    FRAGMENT_SIZE,
  );
  await sync.startSync();
  return sync;
}
