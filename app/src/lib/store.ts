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

// The single source of truth for the local cache file name. startPersistence
// creates it and logout deletes it (connection.ts); two literals could drift
// apart and leave the record un-cleared with no test able to notice.
export const OPFS_RECORD_FILE = 'julian-chat.json';

export type SyncPhase = 'idle' | 'connecting' | 'synced' | 'offline' | 'revoked' | 'stale';
let phase: SyncPhase = 'idle';
const phaseListeners = new Set<(p: SyncPhase) => void>();
// Exported so the app shell can report a connection that never came up on the
// pill the user is already watching — a failure nobody can see is #43 again.
export function setPhase(p: SyncPhase): void {
  phase = p;
  phaseListeners.forEach((fn) => fn(p));
}
export function syncPhase(): SyncPhase {
  return phase;
}
export function onSyncPhase(fn: (p: SyncPhase) => void): () => void {
  phaseListeners.add(fn);
  // Deliver the current phase at subscribe time: transitions that happened
  // before a subscriber attached (boot races the UI) must not leave it
  // showing a stale phase forever.
  fn(phase);
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
    handle = await dir.getFileHandle(OPFS_RECORD_FILE, { create: true });
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

/**
 * The url provider RWS calls on every (re)connect attempt, plus the cancel
 * channel `startSync` needs to quiesce a parked connect attempt. The CALL
 * signature is unchanged — `cancel` is an extra property, so the value is
 * still an ordinary `() => Promise<string>` everywhere RWS expects one.
 */
export interface TicketUrlProvider {
  (): Promise<string>;
  /**
   * Stop the retry loop. TOTAL, like the provider itself: a cancelled loop
   * exits by RESOLVING (never rejecting) with a ticket-less URL, so the
   * library's pending `await` finishes instead of hanging.
   */
  cancel(): void;
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
): TicketUrlProvider {
  let backoffMs = PROVIDER_BACKOFF_START_MS;
  const backoff = (): number => {
    const b = backoffMs;
    backoffMs = Math.min(backoffMs * 2, PROVIDER_BACKOFF_CAP_MS);
    return b;
  };

  // Cancellation. `wake` short-circuits the sleep in flight so a cancel does
  // not have to wait out a 30s backoff before the loop notices.
  let cancelled = false;
  let wake: (() => void) | null = null;
  const sleepInterruptibly = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  // Consecutive *thrown* iterations, tracked separately from
  // client.terminalCount() (which only counts resolved 'error'/'revoked'
  // outcomes). #43: a shipped-bundle defect (the fetch-binding bug) made
  // every ticket() call throw rather than resolve — that loop never touched
  // terminalCount() and sat silently at 'connecting' for a forensic hour.
  const STALE_THROW_LIMIT = 3;
  let consecutiveThrows = 0;

  const provideUrl = async function provideUrl(): Promise<string> {
    for (;;) {
      // Cancelled: resolve, never reject. Verified against
      // reconnecting-websocket's dist source — `close()` sets `_closeCalled`
      // and `_shouldReconnect = false`, but when the socket is parked inside
      // `_connect()` there is no `this._ws` yet, so close() returns early
      // ("close enqueued: no ws instance") and the pending `_getNextUrl`
      // await is untouched. Resolving lets that await finish; the `.then`
      // arm then hits `if (this._closeCalled) return;` and creates NO
      // WebSocket, and `_shouldReconnect === false` makes every later
      // `_connect()` early-return. So a resolved-after-close provider ends
      // the attempt without reconnecting — which a rejection could never do.
      if (cancelled) return `${base}/${STORE_PATH}`;
      try {
        const t = await client.ticket();
        consecutiveThrows = 0; // the client resolved — whatever the outcome, the bundle can run it
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
          await sleepInterruptibly(backoff());
          continue;
        }
        // Stale bundle: three consecutive non-revoked terminal errors mean
        // the deployed app can no longer complete an exchange — reload gets
        // the fix, retrying here never will.
        if (client.terminalCount() >= 3) setPhase('stale');
        await sleepInterruptibly('after' in t ? t.after : backoff());
      } catch {
        // A throw here is exactly the class most likely to be a
        // shipped-bundle defect (#43) — three in a row means say so on the
        // pill, same as the resolved-terminal-error path above.
        consecutiveThrows += 1;
        if (consecutiveThrows >= STALE_THROW_LIMIT) {
          try {
            setPhase('stale');
          } catch {
            // setPhase calls every phaseListeners subscriber synchronously —
            // statements in this catch arm are not themselves protected by
            // it, so a throwing subscriber would otherwise escape here and
            // reject provideUrl's promise, holding RWS's _connectLock
            // forever (the exact TOTAL violation this module exists to
            // prevent). Swallow: a bad subscriber is the subscriber's bug,
            // not a reason to break reconnection.
          }
        }
        await sleepInterruptibly(backoff()); // belt over braces: nothing escapes
      }
    }
  } as TicketUrlProvider;

  provideUrl.cancel = (): void => {
    cancelled = true;
    try {
      wake?.();
    } catch {
      // Same discipline as setPhase above: cancel is called from teardown
      // paths that must not themselves throw.
    }
  };

  return provideUrl;
}

/**
 * Thrown by `startSync` when the phase reaches 'stale' before the
 * synchronizer comes up: the deployed bundle cannot complete an exchange, so
 * waiting longer never helps and the caller needs a settled promise to act
 * on rather than an eternal pending one (#43).
 */
export class SyncStaleError extends Error {
  constructor(message = 'sync went stale before the synchronizer came up') {
    super(message);
    this.name = 'SyncStaleError';
  }
}

export interface SyncHandle {
  sync: Synchronizer;
  ws: ReconnectingWebSocket;
  client: ExchangeClient;
}

export async function startSync(
  getJwt: () => Promise<string | null>,
  client?: ExchangeClient,
): Promise<SyncHandle | null> {
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

  // Arm the stale watch BEFORE the socket exists. Under the #43 defect the
  // provider (correctly TOTAL) never resolves, so RWS parks in _connect(),
  // never fires open or error, and createWsSynchronizer never settles —
  // startSync would hang forever and connection.ts would never receive a
  // handle to stop any of the other legs. 'stale' is the one signal that does
  // arrive; convert it into a rejection so the caller always gets an answer.
  // Subscribing after setPhase('connecting') matters: onSyncPhase delivers the
  // current phase synchronously, and a leftover 'stale' from a previous
  // connection would otherwise reject this attempt before it began.
  let signalStale: ((e: SyncStaleError) => void) | null = null;
  const staleWatch = new Promise<never>((_resolve, reject) => {
    signalStale = reject;
  });
  staleWatch.catch(() => {}); // never an unhandled rejection if the race is already settled
  const unwatchStale = onSyncPhase((p) => {
    if (p === 'stale') signalStale?.(new SyncStaleError());
  });

  ws = new ReconnectingWebSocket(provideUrl, [], { maxReconnectionDelay: 30_000, minReconnectionDelay: 1_000 });
  ws.addEventListener('open', () => setPhase('synced'));
  ws.addEventListener('close', () => {
    // A revoked close is deliberate (triggered by the provider itself) —
    // don't let the resulting close event flicker the phase back to
    // 'offline' and hide the terminal state from the UI.
    if (syncPhase() !== 'revoked') setPhase('offline');
  });

  try {
    // From here on the socket exists but the caller does not hold it yet: any
    // failure has to release it here, because the only reference travels
    // inside the SyncHandle the failure prevents.
    const sync = await Promise.race([
      (async (): Promise<Synchronizer> => {
        const s = await createWsSynchronizer(
          store,
          ws as unknown as WebSocket,
          5,
          undefined,
          undefined,
          undefined,
          FRAGMENT_SIZE,
        );
        await s.startSync();
        return s;
      })(),
      staleWatch,
    ]);
    return { sync, ws, client: exchangeClient };
  } catch (err) {
    // Close first, cancel second: close() sets _closeCalled, so when the
    // cancelled provider then resolves, RWS's connect continuation discards
    // the url and creates no socket (see createTicketUrlProvider). The
    // losing createWsSynchronizer promise stays pending forever on the stale
    // path — the library offers no way to abort it — but it holds only a
    // socket that can never reconnect.
    try {
      ws.close();
    } catch {
      // best-effort: teardown must not mask the original failure
    }
    try {
      provideUrl.cancel();
    } catch {
      // ditto
    }
    throw err;
  } finally {
    unwatchStale();
    signalStale = null;
  }
}
