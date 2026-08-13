import { createStreamStore, STORE_PATH } from 'julian-shared/schema';
import { createOpfsPersister } from 'tinybase/persisters/persister-browser';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { getHash } from 'tinybase';
import type { Persister } from 'tinybase/persisters';
import type { Synchronizer } from 'tinybase/synchronizers';
import { ExchangeClient } from './exchange';

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

type SyncPhase = 'idle' | 'connecting' | 'synced' | 'offline' | 'revoked' | 'stale';
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

const PROVIDER_BACKOFF_START_MS = 1000;
const PROVIDER_BACKOFF_CAP_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Builds the async URL provider RWS calls on every (re)connect attempt.
// TOTAL: never rejects, never throws — a rejecting provider holds RWS's
// _connectLock forever (R2-D1, verified against the library source).
// `closeSocket` is invoked from OUTSIDE the provider — RWS has no stop
// channel of its own, so a terminal `revoked` result closes the socket via
// the caller-supplied callback before resolving one more (known-failing)
// URL, so the pending connect attempt itself is never left hanging.
export function createTicketUrlProvider(
  client: ExchangeClient,
  base: string,
  closeSocket: () => void,
): () => Promise<string> {
  let backoffMs = PROVIDER_BACKOFF_START_MS;
  const backoff = (): number => {
    const b = backoffMs;
    backoffMs = Math.min(backoffMs * 2, PROVIDER_BACKOFF_CAP_MS);
    return b;
  };

  return async function provideUrl(): Promise<string> {
    for (;;) {
      try {
        const t = await client.ticket();
        if ('ticket' in t) {
          backoffMs = PROVIDER_BACKOFF_START_MS;
          return `${base}/${STORE_PATH}?ticket=${encodeURIComponent(t.ticket)}`;
        }
        if (t.kind === 'revoked') {
          setPhase('revoked');
          queueMicrotask(closeSocket); // stop from OUTSIDE the provider — RWS has no stop channel of its own
          return `${base}/${STORE_PATH}?ticket=jst_revoked`; // resolve once more with a known-failing URL
        }
        if (t.kind === 'signed-out') {
          setPhase('offline');
          await sleep(backoff());
          continue;
        }
        // Stale bundle: three consecutive non-revoked terminal errors mean
        // the deployed app can no longer complete an exchange — reload gets
        // the fix, retrying here never will.
        if (client.terminalCount() >= 3) setPhase('stale');
        await sleep('after' in t ? t.after : backoff());
      } catch {
        await sleep(backoff()); // belt over braces: nothing escapes
      }
    }
  };
}

export async function startSync(
  getJwt: () => Promise<string | null>,
  client?: ExchangeClient,
): Promise<Synchronizer | null> {
  const base = import.meta.env.VITE_SYNC_URL;
  const gateUrl = import.meta.env.VITE_GATE_URL;
  if (!base || !gateUrl) {
    setPhase('offline');
    return null;
  }
  setPhase('connecting');
  const exchangeClient = client ?? new ExchangeClient({ gateUrl, getJwt });

  let ws: ReconnectingWebSocket;
  const provideUrl = createTicketUrlProvider(exchangeClient, base, () => ws.close());
  ws = new ReconnectingWebSocket(provideUrl, [], { maxReconnectionDelay: 30_000, minReconnectionDelay: 1_000 });
  ws.addEventListener('open', () => setPhase('synced'));
  ws.addEventListener('close', () => {
    // A revoked close is deliberate (triggered by the provider itself) —
    // don't let the resulting close event flicker the phase back to
    // 'offline' and hide the terminal state from the UI.
    if (syncPhase() !== 'revoked') setPhase('offline');
  });
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
