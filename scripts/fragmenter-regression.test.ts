import { afterAll, describe, expect, test } from 'bun:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createWsServer } from 'tinybase/synchronizers/synchronizer-ws-server';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { createStreamStore } from 'julian-shared/schema';

const FRAGMENT_SIZE = 262144; // must match app/src/lib/store.ts and sync/src/do.ts

const wss = new WebSocketServer({ port: 0 });
// port: 0 binds asynchronously — address() is null until 'listening' fires, so
// reading it synchronously would throw under load. Same guard as the sibling
// loopback suites (reconnect.test.ts, fireproof-write.test.ts).
await new Promise((resolve) => wss.once('listening', resolve));
const port = (wss.address() as { port: number }).port;
const srv = createWsServer(wss);
const url = `ws://127.0.0.1:${port}/julian/chat`;
afterAll(() => srv.destroy());

async function connect(store: ReturnType<typeof createStreamStore>) {
  const sync = await createWsSynchronizer(
    store,
    new WebSocket(url) as unknown as globalThis.WebSocket,
    5,
    undefined,
    undefined,
    undefined,
    FRAGMENT_SIZE,
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

describe('fragmenter (9.5.1): separators survive fragmentation', () => {
  test('a >FRAGMENT_SIZE cell carrying U+2028/U+2029 arrives byte-identical', async () => {
    const a = createStreamStore('frag-a');
    const b = createStreamStore('frag-b');
    const sa = await connect(a);
    const sb = await connect(b);

    // Larger than one fragment, separators placed either side of the boundary.
    const text = 'x'.repeat(FRAGMENT_SIZE - 4) + '\u2028 mid \u2029' + 'y'.repeat(4096); // escapes, never literals: the defect under test is these code points vanishing silently
    a.setRow('messages', 'frag-1', {
      sessionId: 's', role: 'user', speakerName: 'test', text, ts: 1, kind: 'chat',
    });

    await until(() => b.getCell('messages', 'frag-1', 'text') === text);
    const received = b.getCell('messages', 'frag-1', 'text') as string;
    expect(received.length).toBe(text.length); // 9.2.0 deleted the separators: length shrank by 2
    expect(received.includes('\u2028')).toBe(true);
    expect(received.includes('\u2029')).toBe(true);

    sa.destroy();
    sb.destroy();
    // sync.destroy() closes the client socket, but the close handshake is
    // async even on loopback: the server's per-channel teardown must observe
    // it before it can settle. Without this wait, afterAll's srv.destroy()
    // races an in-flight close and hangs indefinitely (observed empirically).
    await until(() => wss.clients.size === 0, 5_000);
  }, 15_000); // a >FRAGMENT_SIZE payload needs more than bun's 5s default; must exceed until()'s 10s bound
});
