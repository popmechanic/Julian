import { createStreamStore, STORE_PATH } from 'julian-shared/schema';
import { createIndexedDbPersister } from 'tinybase/persisters/persister-indexed-db';
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

export async function startPersistence(): Promise<Persister> {
  const persister = createIndexedDbPersister(store, 'julian-chat');
  await persister.startAutoPersisting(); // loads persisted content BEFORE starting autosave
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
