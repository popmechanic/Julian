// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { createMergeableStore } from 'tinybase';
import { createOpfsPersister } from 'tinybase/persisters/persister-browser';
import { createStreamStore } from 'julian-shared/schema';
import {
  store,
  startPersistence,
  writeMessage,
  FRAGMENT_SIZE,
  createTicketUrlProvider,
  syncPhase,
  onSyncPhase,
  startSync,
} from './store';
import { ExchangeClient } from './exchange';

// startSync has no injectable seam for the WebSocket constructor (only the
// ExchangeClient is injectable) — mocking the socket layer here gives the
// handle test real behavioral coverage (it fails before the SyncHandle
// change lands, unlike a type-only assertion vitest's esbuild transform
// wouldn't actually check) without opening a live WebSocket inside jsdom.
// No other test in this file constructs a ReconnectingWebSocket or calls
// createWsSynchronizer directly, so this mock cannot affect them.
vi.mock('reconnecting-websocket', () => ({
  default: vi.fn().mockImplementation(() => ({
    close: vi.fn(),
    addEventListener: vi.fn(),
  })),
}));
vi.mock('tinybase/synchronizers/synchronizer-ws-client', () => ({
  createWsSynchronizer: vi.fn().mockResolvedValue({
    startSync: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  }),
}));

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

  // #43: the fetch-binding bug (`this.fetchImpl(...)` on a raw global) looped
  // silently at 'connecting' for a forensic hour — every iteration THREW
  // rather than resolving a terminal state, so the existing terminalCount()
  // stale-detection (which only counts resolved 'error'/'revoked' outcomes)
  // never fired. A deterministic defect must not read as an eternal
  // 'connecting' — three consecutive thrown iterations must flip the pill.
  //
  // Assertions watch phase transitions OBSERVED during this test via
  // onSyncPhase, not the ambient `syncPhase()` value: `phase` is
  // module-level state that leaks across tests in this file (e.g. the
  // preceding terminalCount-based stale test above already leaves it
  // 'stale'), so asserting the ending global would pass or fail on test
  // order rather than on this scenario's own behavior.
  test('three consecutive provider throws reach stale — a deterministic defect is not an eternal connecting (#43)', async () => {
    vi.useFakeTimers();
    try {
      const client = {
        ticket: vi.fn().mockRejectedValue(new TypeError('Illegal invocation')),
        terminalCount: () => 0,
      } as unknown as ExchangeClient;
      const seenPhases: string[] = [];
      const unsub = onSyncPhase((p) => seenPhases.push(p));
      seenPhases.length = 0; // onSyncPhase delivers the current (possibly leftover-stale) phase synchronously at subscribe time — discard it so only transitions from THIS scenario count
      const provideUrl = createTicketUrlProvider(client, 'wss://sync.example', () => {});

      const pending = provideUrl(); // never resolves in this scenario; we watch the phase
      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(31_000); // step through backoff sleeps
      expect(seenPhases).toContain('stale');
      unsub();
      void pending;
    } finally {
      vi.useRealTimers();
    }
  });

  test('a successful ticket resolution resets the throw count — two throws then success is no false stale', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        ticket: vi.fn().mockImplementation(async () => {
          calls += 1;
          if (calls <= 2) throw new TypeError('flaky');
          return { ticket: 'jst_ok' };
        }),
        terminalCount: () => 0,
      } as unknown as ExchangeClient;
      const seenPhases: string[] = [];
      const unsub = onSyncPhase((p) => seenPhases.push(p));
      seenPhases.length = 0; // discard the synchronous current-phase delivery — see comment above
      const provideUrl = createTicketUrlProvider(client, 'wss://sync.example', () => {});

      const pending = provideUrl();
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(31_000);
      const url = await pending;
      expect(url).toContain('ticket=jst_ok');
      expect(seenPhases).not.toContain('stale');
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('startSync — returns a stoppable handle (#4)', () => {
  test('startSync returns a handle carrying sync, ws, and client', async () => {
    vi.stubEnv('VITE_SYNC_URL', 'wss://sync.example');
    vi.stubEnv('VITE_GATE_URL', 'https://gate.example');
    try {
      const client = makeExchangeClient(vi.fn());
      const handle = await startSync(async () => 'jwt', client);
      expect(handle).not.toBeNull();
      expect(typeof handle!.sync.destroy).toBe('function');
      expect(typeof handle!.ws.close).toBe('function');
      expect(typeof handle!.client.reset).toBe('function');
      expect(handle!.client).toBe(client);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('startSync returns null when sync env vars are absent (local mode)', async () => {
    vi.stubEnv('VITE_SYNC_URL', '');
    vi.stubEnv('VITE_GATE_URL', '');
    try {
      const client = makeExchangeClient(vi.fn());
      const handle = await startSync(async () => 'jwt', client);
      expect(handle).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
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
