// Bisection harness for the B3 browser-connect defect (2026-08-13).
// Reproduces startSync's exact wiring with a fake JWT — no sign-in needed.
// If healthy, the chain MUST attempt POST /exchange (a 401/403 is fine);
// zero attempts reproduces the field defect pre-auth.
import ReconnectingWebSocket from 'reconnecting-websocket';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { ExchangeClient } from './lib/exchange';
import { createTicketUrlProvider, onSyncPhase, syncPhase, store } from './lib/store';
import { STORE_PATH } from 'julian-shared/schema';

const logEl = document.getElementById('log')!;
const log = (m: string) => {
  logEl.textContent += `\n${new Date().toISOString().slice(11, 23)} ${m}`;
  console.log('[harness]', m);
};
logEl.textContent = 'harness up';

window.addEventListener('unhandledrejection', (e) =>
  log(`UNHANDLED REJECTION: ${e.reason?.stack?.slice(0, 400) ?? String(e.reason)}`),
);
window.addEventListener('error', (e) => log(`ERROR: ${e.message} @ ${e.filename}:${e.lineno}`));

const origFetch = window.fetch.bind(window);
window.fetch = ((...args: Parameters<typeof fetch>) => {
  log(`fetch → ${String(args[0]).slice(0, 90)}`);
  return origFetch(...args);
}) as typeof fetch;
const OrigWS = window.WebSocket;
// @ts-expect-error deliberate spy shim
window.WebSocket = function (url: string, protocols?: string | string[]) {
  log(`WebSocket → ${String(url).slice(0, 90)}`);
  return new OrigWS(url, protocols);
};
window.WebSocket.prototype = OrigWS.prototype;
Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

log(`initial phase: ${syncPhase()}`);
onSyncPhase((p) => log(`phase → ${p}`));

const gateUrl = 'https://gate.julian.soul.store';
const base = 'wss://sync.julian.soul.store';

(async () => {
  log('constructing ExchangeClient with fake JWT');
  const client = new ExchangeClient({ gateUrl, getJwt: async () => 'fake.jwt.for-wiring-test' });

  let ws: ReconnectingWebSocket;
  const provideUrl = createTicketUrlProvider(client, base, () => ws!.close());
  log('constructing ReconnectingWebSocket');
  ws = new ReconnectingWebSocket(provideUrl, [], {
    maxReconnectionDelay: 30_000,
    minReconnectionDelay: 1_000,
  });
  ws.addEventListener('open', () => log('ws open'));
  ws.addEventListener('close', () => log('ws close'));
  ws.addEventListener('error', () => log('ws error event'));
  log('awaiting createWsSynchronizer');
  const sync = await createWsSynchronizer(store, ws as unknown as WebSocket, 5);
  log('createWsSynchronizer resolved; awaiting startSync');
  await sync.startSync();
  log('startSync resolved');
})().catch((e) => log(`CHAIN REJECTED: ${e?.stack?.slice(0, 500) ?? String(e)}`));
