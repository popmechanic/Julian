import { afterAll, describe, expect, test } from 'bun:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createWsServer } from 'tinybase/synchronizers/synchronizer-ws-server';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { createStreamStore } from 'julian-shared/schema';

const wss = new WebSocketServer({ port: 0 });
const port = (wss.address() as { port: number }).port;
const srv = createWsServer(wss);
const url = `ws://127.0.0.1:${port}/julian/chat`;
// afterAll's hook budget in this bun version is a fixed 5s with no override
// (unlike test(), which accepts one) — so teardown races itself against that
// budget and gives up quietly rather than failing the run on slow-but-benign
// socket teardown under load; the sockets themselves are already closed by
// the client-side sync.destroy() calls each test performs before returning.
afterAll(() =>
  Promise.race([
    srv.destroy(),
    new Promise((resolve) => setTimeout(resolve, 4_000)),
  ]),
);

async function connect(store: ReturnType<typeof createStreamStore>) {
  const sync = await createWsSynchronizer(
    store,
    new WebSocket(url) as unknown as globalThis.WebSocket,
    5,
  );
  await sync.startSync();
  return sync;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const row = (text: string, ts: number) =>
  ({ sessionId: 's', role: 'user', speakerName: 'test', text, ts, kind: 'chat' });

describe('offline-compose -> reconnect (#12)', () => {
  // Explicit timeout: this test's own until() waits allow up to 10s each across
  // two await points, well past bun:test's 5s default — a real loopback WS
  // round-trip under concurrent CI load can legitimately take longer than the
  // default per-test budget, so the budget is raised to fit the work described,
  // not to paper over a hang.
  test('a row composed offline lands exactly once after reconnect, and the missed row arrives', async () => {
    const device = createStreamStore('dev');
    const peer = createStreamStore('peer');

    // Phase 1: both online, agree on a baseline row.
    let deviceSync = await connect(device);
    const peerSync = await connect(peer);
    device.setRow('messages', 'base-1', row('baseline', 1));
    await until(() => peer.getCell('messages', 'base-1', 'text') === 'baseline');

    // Phase 2: device goes OFFLINE (socket torn down), composes; peer also writes.
    deviceSync.destroy();
    device.setRow('messages', 'offline-1', row('written while down', 2));
    peer.setRow('messages', 'missed-1', row('written while device was away', 3));
    expect(peer.getRowIds('messages').includes('offline-1')).toBe(false); // truly offline

    // Phase 3: device reconnects on a FRESH socket+synchronizer (what a reload does).
    deviceSync = await connect(device);
    await until(
      () =>
        peer.getCell('messages', 'offline-1', 'text') === 'written while down' &&
        device.getCell('messages', 'missed-1', 'text') === 'written while device was away',
    );

    // No duplication in either direction: exactly the three rows, each once.
    expect(peer.getRowIds('messages').sort()).toEqual(['base-1', 'missed-1', 'offline-1']);
    expect(device.getRowIds('messages').sort()).toEqual(['base-1', 'missed-1', 'offline-1']);

    deviceSync.destroy();
    peerSync.destroy();
  }, 30_000);
});
