// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { createMergeableStore } from 'tinybase';
import { createOpfsPersister } from 'tinybase/persisters/persister-browser';
import { createStreamStore } from 'julian-shared/schema';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import {
  store,
  startPersistence,
  writeMessage,
  FRAGMENT_SIZE,
  createTicketUrlProvider,
  syncPhase,
  onSyncPhase,
  startSync,
  SyncStaleError,
} from './store';
import { ExchangeClient } from './exchange';

// startSync has no injectable seam for the WebSocket constructor (only the
// ExchangeClient is injectable) — mocking the socket layer here gives the
// handle test real behavioral coverage (it fails before the SyncHandle
// change lands, unlike a type-only assertion vitest's esbuild transform
// wouldn't actually check) without opening a live WebSocket inside jsdom.
// No other test in this file constructs a ReconnectingWebSocket or calls
// createWsSynchronizer directly, so this mock cannot affect them.
//
// Each construction is recorded, along with the url provider it was handed.
// The mock deliberately does NOT call that provider on its own — the real
// library calls it from _connect(), and tests that need the provider loop to
// run drive it explicitly, so no test pays for a background retry loop it did
// not ask for.
interface MockSocket {
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  urlProvider: (() => Promise<string>) & { cancel?: () => void };
}
const wsInstances = vi.hoisted(() => [] as unknown[]);
function lastSocket(): MockSocket {
  return wsInstances[wsInstances.length - 1] as MockSocket;
}
vi.mock('reconnecting-websocket', () => ({
  default: vi.fn().mockImplementation((urlProvider: unknown) => {
    const inst = { close: vi.fn(), addEventListener: vi.fn(), urlProvider };
    wsInstances.push(inst);
    return inst;
  }),
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

  // Totality hole (review-confirmed): `setPhase('stale')` in the catch arm
  // synchronously calls every phaseListeners subscriber via forEach — a
  // throwing subscriber is not shielded by the surrounding catch (it IS the
  // catch), so its exception propagates out of provideUrl and rejects the
  // provider's promise. That is the exact violation the module header and
  // the global constraint forbid: a rejecting provider holds RWS's
  // _connectLock forever (R2-D1). The `armed` gate skips the synchronous
  // current-phase delivery call onSyncPhase makes at subscribe time — only
  // calls triggered from INSIDE the provider's own setPhase('stale') should
  // throw.
  test('a throwing onSyncPhase subscriber does not escape the provider on the stale transition (TOTAL)', async () => {
    vi.useFakeTimers();
    let armed = false;
    // Registered outside the try so the finally can always remove it: a
    // failed assertion must not leave an exploding subscriber attached to
    // module-level phaseListeners and cascade into unrelated tests.
    const unsub = onSyncPhase(() => {
      if (armed) throw new Error('subscriber exploded');
    });
    try {
      const client = {
        ticket: vi.fn().mockRejectedValue(new TypeError('Illegal invocation')),
        terminalCount: () => 0,
      } as unknown as ExchangeClient;

      armed = true;

      const provideUrl = createTicketUrlProvider(client, 'wss://sync.example', () => {});

      let rejection: unknown = '<not yet settled>';
      const settled = provideUrl().then(
        () => {
          rejection = null;
          return '<resolved>';
        },
        (e: unknown) => {
          rejection = e;
          return '<rejected>';
        },
      );

      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(31_000); // drive well past three consecutive throws
      expect(rejection).toBe('<not yet settled>'); // TOTAL: never rejects, even with an exploding subscriber
      void settled;
    } finally {
      armed = false;
      unsub();
      vi.useRealTimers();
    }
  });

  // The reset half of the same contract, and it must DISCRIMINATE: a
  // scenario of two throws followed by success proves nothing, because two
  // is already under the limit of three — it passes with or without the
  // reset. The arrangement below spans FOUR throws, with a resolution in the
  // middle that continues the loop rather than returning from it
  // ({kind:'signed-out'} sleeps and loops). With the reset, the counter
  // restarts at that resolution and never reaches three; without it, the
  // throws accumulate 1,2,_,3 and the third flips the pill to 'stale' before
  // the final ticket ever arrives. Deleting `consecutiveThrows = 0` turns
  // this test red.
  test('a resolved ticket() call resets the throw count — throws either side of a resolution do not accumulate into a false stale', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = {
        // throw, throw, resolve (non-terminal: loops on), throw, throw, resolve a ticket
        ticket: vi.fn().mockImplementation(async () => {
          calls += 1;
          if (calls === 3) return { kind: 'signed-out' };
          if (calls <= 5) throw new TypeError('flaky');
          return { ticket: 'jst_ok' };
        }),
        terminalCount: () => 0,
      } as unknown as ExchangeClient;
      const seenPhases: string[] = [];
      const unsub = onSyncPhase((p) => seenPhases.push(p));
      seenPhases.length = 0; // discard the synchronous current-phase delivery — see comment above
      const provideUrl = createTicketUrlProvider(client, 'wss://sync.example', () => {});

      const pending = provideUrl();
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(31_000);
      const url = await pending;
      expect(url).toContain('ticket=jst_ok');
      expect(client.ticket).toHaveBeenCalledTimes(6); // all four throws and both resolutions actually ran
      expect(seenPhases).toContain('offline'); // the mid-run resolution was reached (it is what resets the count)
      expect(seenPhases).not.toContain('stale'); // …and four non-consecutive throws never reach the limit
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

  // The provider is correctly TOTAL, which is exactly what strands startSync
  // under the #43 defect: a forever-throwing ticket() means provideUrl never
  // resolves, ReconnectingWebSocket parks inside _connect() awaiting the URL
  // and so never fires open or error, and createWsSynchronizer never
  // resolves. startSync would then hang forever — connection.ts never
  // installs a handle, and every other leg of the connection is orphaned with
  // nothing able to stop it. The stale phase is the one signal that arrives,
  // so startSync must convert it into a settled rejection.
  test('a forever-throwing ticket client settles startSync (rejects) and closes the socket', async () => {
    vi.stubEnv('VITE_SYNC_URL', 'wss://sync.example');
    vi.stubEnv('VITE_GATE_URL', 'https://gate.example');
    vi.useFakeTimers();
    try {
      // The synchronizer never resolves here, mirroring a socket that never opens.
      vi.mocked(createWsSynchronizer).mockReturnValueOnce(new Promise(() => {}) as never);
      const client = {
        ticket: vi.fn().mockRejectedValue(new TypeError('Illegal invocation')),
        terminalCount: () => 0,
        reset: () => {},
      } as unknown as ExchangeClient;

      const pending = startSync(async () => 'jwt', client);
      let settled: unknown = '<not yet settled>';
      const observed = pending.then(
        (h) => {
          settled = h;
          return '<resolved>';
        },
        (e: unknown) => {
          settled = e;
          return '<rejected>';
        },
      );

      const socket = lastSocket();
      // Drive the url provider exactly as the library's _connect does.
      void (socket.urlProvider as () => Promise<string>)().catch(() => {});
      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(31_000);

      await observed;
      expect(settled).toBeInstanceOf(SyncStaleError);
      expect(socket.close).toHaveBeenCalled(); // the caller never got the handle, so startSync must release the socket itself

      // …and the retry loop is actually stopped, not merely abandoned: a
      // rejected startSync that leaves the provider minting tickets forever
      // is the same orphan in a quieter costume. Deleting provideUrl.cancel()
      // (or its call in the teardown path) turns this assertion red.
      const callsAtTeardown = (client.ticket as ReturnType<typeof vi.fn>).mock.calls.length;
      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(31_000);
      expect((client.ticket as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtTeardown);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  test('a failing createWsSynchronizer closes the socket and propagates the error', async () => {
    vi.stubEnv('VITE_SYNC_URL', 'wss://sync.example');
    vi.stubEnv('VITE_GATE_URL', 'https://gate.example');
    try {
      const boom = new Error('synchronizer refused');
      vi.mocked(createWsSynchronizer).mockRejectedValueOnce(boom);
      const client = makeExchangeClient(vi.fn());

      await expect(startSync(async () => 'jwt', client)).rejects.toBe(boom);
      // Without the wrapper the socket reference dies with the throw — the
      // caller structurally cannot close a socket it never received.
      expect(lastSocket().close).toHaveBeenCalled();
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
