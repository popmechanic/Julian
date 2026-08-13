// @vitest-environment jsdom
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { ExchangeClient } from './exchange';

function jsonRes(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

function makeClient(
  fetchImpl: ReturnType<typeof vi.fn>,
  getJwt: () => Promise<string | null> = async () => 'pocket-id-jwt',
) {
  return new ExchangeClient({
    gateUrl: 'https://gate.example',
    getJwt,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('ExchangeClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('happy mint caches: second access() makes no network call', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes(200, { access_token: 'jla_abc', token_type: 'Bearer', expires_in: 3600, scope: 'stream' }),
    );
    const client = makeClient(fetchImpl);

    const first = await client.access();
    expect(first).toEqual({ kind: 'ok', accessToken: 'jla_abc', expiresAt: expect.any(Number) });

    const second = await client.access();
    expect(second).toEqual({ kind: 'ok', accessToken: 'jla_abc', expiresAt: expect.any(Number) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('expiry-margin re-mint: fewer than 5 minutes left forces a fresh POST /exchange', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => jsonRes(200, { access_token: 'jla_abc', expires_in: 360 })); // 6 min TTL
    const client = makeClient(fetchImpl);

    await client.access();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 356s elapsed of a 360s token → 4s remain, inside the 5-minute margin.
    vi.advanceTimersByTime(356_000);
    await client.access();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('revoked latches: subsequent access() calls return revoked without a network call', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(403, { error: 'access revoked', class: 'revoked' }));
    const client = makeClient(fetchImpl);

    const first = await client.access();
    expect(first).toEqual({ kind: 'revoked' });

    const second = await client.access();
    const third = await client.access();
    expect(second).toEqual({ kind: 'revoked' });
    expect(third).toEqual({ kind: 'revoked' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the app stops — no further calls
  });

  test('reset() unlatches revoked and clears the cache', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(403, { error: 'access revoked', class: 'revoked' }))
      .mockResolvedValueOnce(jsonRes(200, { access_token: 'jla_new', expires_in: 3600 }));
    const client = makeClient(fetchImpl);

    expect(await client.access()).toEqual({ kind: 'revoked' });
    client.reset();

    const after = await client.access();
    expect(after).toEqual({ kind: 'ok', accessToken: 'jla_new', expiresAt: expect.any(Number) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('429 → retry with backoff doubling from 1s to a 30s cap', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(429, { error: 'rate limited', class: 'rate' }));
    const client = makeClient(fetchImpl);

    const afters: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await client.access();
      expect(r.kind).toBe('retry');
      afters.push((r as { kind: 'retry'; after: number }).after);
    }
    expect(afters).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  test('session-cap class also retries (429 family)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(429, { error: 'session cap reached', class: 'session-cap' }));
    const client = makeClient(fetchImpl);
    expect(await client.access()).toEqual({ kind: 'retry', after: 1000 });
  });

  test('network failure and 5xx → retry', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = makeClient(fetchImpl);
    expect(await client.access()).toEqual({ kind: 'retry', after: 1000 });

    const fetchImpl5xx = vi.fn(async () => jsonRes(503, { error: 'no audience configured', class: 'no-audience' }));
    const client5xx = makeClient(fetchImpl5xx);
    expect(await client5xx.access()).toEqual({ kind: 'retry', after: 1000 });
  });

  test('other 4xx → error (not retryable, not revoked)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(401, { error: 'bad session', class: 'bad-session' }));
    const client = makeClient(fetchImpl);
    expect(await client.access()).toEqual({ kind: 'error' });
  });

  test('signed-out when the JWT provider returns null, no network call made', async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl, async () => null);
    expect(await client.access()).toEqual({ kind: 'signed-out' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('ticket() re-exchanges once on a 401 (token died early) then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { access_token: 'jla_first', expires_in: 3600 })) // POST /exchange
      .mockResolvedValueOnce(jsonRes(401, { error: 'token expired early' })) // POST /socket-ticket
      .mockResolvedValueOnce(jsonRes(200, { access_token: 'jla_second', expires_in: 3600 })) // re-exchange
      .mockResolvedValueOnce(jsonRes(200, { ticket: 'jst_xyz' })); // POST /socket-ticket, succeeds
    const client = makeClient(fetchImpl);

    const result = await client.ticket();
    expect(result).toEqual({ ticket: 'jst_xyz' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('ticket() surfaces a non-ok access() outcome directly (e.g. signed-out) without minting', async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl, async () => null);
    expect(await client.ticket()).toEqual({ kind: 'signed-out' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('no token or ticket ever touches localStorage', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { access_token: 'jla_abc', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonRes(200, { ticket: 'jst_abc' }));
    const client = makeClient(fetchImpl);

    await client.access();
    await client.ticket();

    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  test('terminalCount(): consecutive error/revoked count, reset by a successful mint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(401, { error: 'bad session', class: 'bad-session' }))
      .mockResolvedValueOnce(jsonRes(401, { error: 'bad session', class: 'bad-session' }))
      .mockResolvedValueOnce(jsonRes(200, { access_token: 'jla_abc', expires_in: 3600 }));
    const client = makeClient(fetchImpl);

    await client.access();
    expect(client.terminalCount()).toBe(1);
    await client.access();
    expect(client.terminalCount()).toBe(2);
    await client.access();
    expect(client.terminalCount()).toBe(0);
  });
});
