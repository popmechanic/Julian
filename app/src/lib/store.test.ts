// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { createMergeableStore } from 'tinybase';
import { createOpfsPersister } from 'tinybase/persisters/persister-browser';
import { createStreamStore } from 'julian-shared/schema';
import { store, startPersistence, writeMessage, FRAGMENT_SIZE, createTicketUrlProvider, syncPhase, onSyncPhase } from './store';
import { ExchangeClient } from './exchange';

function jsonRes(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

function makeExchangeClient(fetchImpl: ReturnType<typeof vi.fn>): ExchangeClient {
  return new ExchangeClient({
    gateUrl: 'https://gate.example',
    getJwt: async () => 'pocket-id-jwt',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

// In-memory FileSystemFileHandle implementing exactly the surface the OPFS
// persister uses: getFile().text() and createWritable().write()/close().
function memHandle(): FileSystemFileHandle {
  let data = '';
  return {
    getFile: async () => ({ text: async () => data }),
    createWritable: async () => ({
      write: async (s: string) => {
        data = s;
      },
      close: async () => {},
    }),
  } as unknown as FileSystemFileHandle;
}

describe('client store', () => {
  test('fragment size is set for Cloudflare WS limits', () => {
    expect(FRAGMENT_SIZE).toBe(262144);
  });

  test('writeMessage is idempotent by row id', () => {
    writeMessage('evt-1', { sessionId: 's', role: 'user', speakerName: 'Marcus', text: 'hi', ts: 1 });
    writeMessage('evt-1', { sessionId: 's', role: 'user', speakerName: 'Marcus', text: 'hi', ts: 1 });
    expect(store.getRowIds('messages')).toEqual(['evt-1']);
  });

  test('persistence round-trips into a FRESH store (real reload semantics)', async () => {
    const handle = memHandle();
    const persister = await startPersistence(handle);
    expect(persister).not.toBeNull();
    writeMessage('evt-2', { sessionId: 's', role: 'assistant', speakerName: 'Julian', text: 'hello', ts: 2 });
    await persister!.save();
    await persister!.destroy();

    // A fresh store loading the same file — this is what a browser reload does.
    const reloaded = createStreamStore('reloaded');
    const p2 = createOpfsPersister(reloaded, handle);
    await p2.load();
    expect(reloaded.getCell('messages', 'evt-2', 'text')).toBe('hello');
    await p2.destroy();
  });

  test('reload preserves CRDT stamps: stale cache cannot beat newer server state', async () => {
    // t0: device and server agree
    const server = createMergeableStore('server');
    const device = createMergeableStore('device');
    server.setCell('m', 'r', 'text', 'old');
    device.merge(server as never);

    // device persists to OPFS (full mergeable content, stamps included)
    const handle = memHandle();
    const devicePersister = createOpfsPersister(device, handle);
    await devicePersister.save();
    await devicePersister.destroy();

    // t1: another device updates the server
    await new Promise((r) => setTimeout(r, 10));
    server.setCell('m', 'r', 'text', 'new');

    // t2: stale device reloads from OPFS and syncs
    await new Promise((r) => setTimeout(r, 10));
    const rebooted = createMergeableStore('device');
    const rebootPersister = createOpfsPersister(rebooted, handle);
    await rebootPersister.load();
    server.merge(rebooted as never);

    // With content-only persistence (IndexedDB) this was 'old' — the bug.
    expect(server.getCell('m', 'r', 'text')).toBe('new');
    await rebootPersister.destroy();
  });
});

describe('createTicketUrlProvider — the total ticket URL provider (R2-D1)', () => {
  test('resolves a ?ticket= URL from a successful mint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { access_token: 'jla_abc', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonRes(200, { ticket: 'jst_xyz' }));
    const client = makeExchangeClient(fetchImpl);
    const provideUrl = createTicketUrlProvider(client, 'wss://sync.example', () => {});

    const url = await provideUrl();
    expect(url).toBe('wss://sync.example/julian/chat?ticket=jst_xyz');
  });

  // The retry arm: ExchangeClient absorbs fetch rejections into {kind:'retry'},
  // so a dead network drives the `'after' in t` sleep, never the catch belt.
  test('an induced fetch failure (client returns retry twice, then succeeds) does not stop the loop', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(jsonRes(200, { access_token: 'jla_abc', expires_in: 3600 }))
        .mockResolvedValueOnce(jsonRes(200, { ticket: 'jst_ok' }));
      const client = makeExchangeClient(fetchImpl);
      const provideUrl = createTicketUrlProvider(client, 'wss://sync.example', () => {});

      const pending = provideUrl();
      await vi.runAllTimersAsync();
      const url = await pending;
      expect(url).toBe('wss://sync.example/julian/chat?ticket=jst_ok');
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // The catch belt: a client whose ticket() REJECTS (in production, `access()`
  // awaits getJwt() outside any try, so a rejecting getJwt makes ticket()
  // reject for real). If that escaped the provider, RWS's _connectLock would
  // be held forever and the socket would never reconnect — R2-D1.
  test('an induced mint failure (client throws twice, then succeeds) does not stop the loop', async () => {
    vi.useFakeTimers();
    try {
      const ticket = vi
        .fn()
        .mockRejectedValueOnce(new Error('getJwt exploded'))
        .mockRejectedValueOnce(new Error('getJwt exploded'))
        .mockResolvedValueOnce({ ticket: 'jst_ok' });
      const client = { ticket, terminalCount: () => 0 } as unknown as ExchangeClient;
      const provideUrl = createTicketUrlProvider(client, 'wss://sync.example', () => {});

      // Attach the handler synchronously: totality is the claim, so a
      // rejection must be observed as a failed assertion, not as an
      // unhandled-rejection crash somewhere else in the run.
      let rejection: unknown = null;
      const settled = provideUrl().catch((e: unknown) => {
        rejection = e;
        return '<the provider rejected>';
      });
      await vi.runAllTimersAsync();
      const url = await settled;
      expect(rejection).toBeNull();
      expect(url).toBe('wss://sync.example/julian/chat?ticket=jst_ok');
      expect(ticket).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('terminal revoked: phase becomes revoked, the provider resolves (does not hang), and close runs from outside', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(403, { error: 'access revoked', class: 'revoked' }));
    const client = makeExchangeClient(fetchImpl);
    const closeSocket = vi.fn();
    const seen: string[] = [];
    const unsub = onSyncPhase((p) => seen.push(p));
    const provideUrl = createTicketUrlProvider(client, 'wss://sync.example', closeSocket);

    const url = await provideUrl();
    expect(url).toBe('wss://sync.example/julian/chat?ticket=jst_revoked');
    expect(syncPhase()).toBe('revoked');
    expect(seen).toContain('revoked');

    // closeSocket runs from OUTSIDE the provider, via queueMicrotask.
    await Promise.resolve();
    await Promise.resolve();
    expect(closeSocket).toHaveBeenCalledTimes(1);
    unsub();
  });

  test('three consecutive non-revoked terminal errors flip phase to stale', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => jsonRes(401, { error: 'bad session', class: 'bad-session' }));
      const client = makeExchangeClient(fetchImpl);
      const provideUrl = createTicketUrlProvider(client, 'wss://sync.example', () => {});

      void provideUrl(); // never resolves on its own — bad-session is neither ok nor revoked
      await vi.advanceTimersByTimeAsync(0); // iteration 1: terminal=1, sleeps 1000ms
      expect(syncPhase()).not.toBe('stale');
      await vi.advanceTimersByTimeAsync(1000); // iteration 2: terminal=2, sleeps 2000ms
      expect(syncPhase()).not.toBe('stale');
      await vi.advanceTimersByTimeAsync(2000); // iteration 3: terminal=3 -> stale
      expect(syncPhase()).toBe('stale');
    } finally {
      vi.useRealTimers();
    }
  });

  test('no produced URL ever contains token=', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { access_token: 'jla_abc', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonRes(200, { ticket: 'jst_xyz' }));
    const client = makeExchangeClient(fetchImpl);
    const provideUrl = createTicketUrlProvider(client, 'wss://sync.example', () => {});

    const url = await provideUrl();
    expect(url).not.toMatch(/token=/);
  });
});

describe('onSyncPhase — subscription races (the lying pill, 2026-08-13)', () => {
  // A subscriber that attaches after boot-time transitions must not display a
  // stale phase forever: subscribing delivers the current phase immediately.
  test('a late subscriber is called with the current phase at subscribe time', () => {
    const seen: string[] = [];
    const unsub = onSyncPhase((p) => seen.push(p));
    expect(seen).toEqual([syncPhase()]);
    unsub();
  });
});
