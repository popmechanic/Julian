import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { GovernorDO } from '../src/governor';

const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const ACCESS_RE = /^jla_[A-Za-z0-9_-]{43}$/;
const REFRESH_RE = /^jlr_[A-Za-z0-9_-]{43}$/;
const START = Date.UTC(2026, 7, 9, 12, 0, 0);
const CLIENT = 'julian-new-web';
const HOST = 'julian-new.exe.xyz';
const PURPOSE = 'web app subprocess';
const DOOR = 'door:julian-new-web';

interface Clock { t: number; advance(seconds: number): void }

function stub() {
  const ns = (env as { GOVERNOR: DurableObjectNamespace }).GOVERNOR;
  return ns.get(ns.idFromName(`leases-${crypto.randomUUID()}`));
}

// Every case gets its own DO and its own hand-driven clock: no wall time, no
// shared state, no fixed ports — cases may run in any order, concurrently.
async function withGovernor(fn: (g: GovernorDO, clock: Clock) => Promise<void> | void): Promise<void> {
  await runInDurableObject(stub(), async (g: GovernorDO) => {
    const clock: Clock = { t: START, advance(seconds: number) { this.t += seconds * 1000; } };
    (g as unknown as { now: () => number }).now = () => clock.t;
    await fn(g, clock);
  });
}

type Ready = { status: 'ready'; accessToken: string; refreshToken: string; expiresIn: number; scope: string };

async function enroll(
  g: GovernorDO, clock: Clock, door = DOOR, scope: 'full-house' | 'reading-room' = 'full-house',
): Promise<Ready> {
  const knock = await g.knockCreate(CLIENT, HOST, PURPOSE);
  if ('error' in knock) throw new Error('knock refused');
  expect(g.knockDecide(knock.userCode, 'approved', door, scope)).toBe(true);
  clock.advance(5);
  const ready = await g.devicePoll(knock.deviceCode, CLIENT);
  if (ready.status !== 'ready') throw new Error(`expected ready, got ${ready.status}`);
  return ready;
}

describe('knock → approve → poll lifecycle', () => {
  test('happy path mints a working pair', async () => {
    await withGovernor(async (g, clock) => {
      const knock = await g.knockCreate(CLIENT, HOST, PURPOSE);
      if ('error' in knock) throw new Error('knock refused');
      expect(knock.userCode).toMatch(USER_CODE_RE);
      expect(knock.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(knock.expiresIn).toBe(900);
      expect(knock.interval).toBe(5);

      expect(g.knockByUserCode(knock.userCode)).toEqual({
        userCode: knock.userCode, clientId: CLIENT, host: HOST, purpose: PURPOSE, created: START,
      });
      expect(await g.devicePoll(knock.deviceCode, CLIENT)).toEqual({ status: 'pending' });

      expect(g.knockDecide(knock.userCode, 'approved', DOOR, 'full-house')).toBe(true);
      clock.advance(5);
      const ready = await g.devicePoll(knock.deviceCode, CLIENT);
      expect(ready).toEqual({
        status: 'ready',
        accessToken: expect.stringMatching(ACCESS_RE),
        refreshToken: expect.stringMatching(REFRESH_RE),
        expiresIn: 3600,
        scope: 'full-house',
      });
      if (ready.status !== 'ready') throw new Error('unreachable');

      expect(await g.validateAccess(ready.accessToken)).toEqual({
        leaseId: expect.any(String), doorName: DOOR, scope: 'full-house',
      });
    });
  });

  test('user code lookup and decision accept the code unformatted or lowercased', async () => {
    await withGovernor(async (g, clock) => {
      const knock = await g.knockCreate(CLIENT, HOST, PURPOSE);
      if ('error' in knock) throw new Error('knock refused');
      const bare = knock.userCode.replace('-', '').toLowerCase();
      expect(g.knockByUserCode(bare)?.userCode).toBe(knock.userCode);
      expect(g.knockDecide(bare, 'approved', DOOR, 'reading-room')).toBe(true);
      clock.advance(5);
      const ready = await g.devicePoll(knock.deviceCode, CLIENT);
      expect(ready.status).toBe('ready');
      if (ready.status !== 'ready') throw new Error('unreachable');
      expect(ready.scope).toBe('reading-room');
    });
  });

  test('polling faster than the interval → slow_down, then pending again', async () => {
    await withGovernor(async (g, clock) => {
      const knock = await g.knockCreate(CLIENT, HOST, PURPOSE);
      if ('error' in knock) throw new Error('knock refused');
      expect(await g.devicePoll(knock.deviceCode, CLIENT)).toEqual({ status: 'pending' });
      clock.advance(2);
      expect(await g.devicePoll(knock.deviceCode, CLIENT)).toEqual({ status: 'slow_down' });
      clock.advance(5);
      expect(await g.devicePoll(knock.deviceCode, CLIENT)).toEqual({ status: 'pending' });
    });
  });

  test('expired knock → expired; a decision on it is refused', async () => {
    await withGovernor(async (g, clock) => {
      const knock = await g.knockCreate(CLIENT, HOST, PURPOSE);
      if ('error' in knock) throw new Error('knock refused');
      clock.advance(901);
      expect(await g.devicePoll(knock.deviceCode, CLIENT)).toEqual({ status: 'expired' });
      expect(g.knockByUserCode(knock.userCode)).toBeNull();
      expect(g.knockDecide(knock.userCode, 'approved', DOOR, 'full-house')).toBe(false);
    });
  });

  test('refused knock → refused, and no lease is born', async () => {
    await withGovernor(async (g, clock) => {
      const knock = await g.knockCreate(CLIENT, HOST, PURPOSE);
      if ('error' in knock) throw new Error('knock refused');
      expect(g.knockDecide(knock.userCode, 'refused', DOOR, 'full-house')).toBe(true);
      clock.advance(5);
      expect(await g.devicePoll(knock.deviceCode, CLIENT)).toEqual({ status: 'refused' });
      expect(g.leaseList().some((l) => l.doorName === DOOR)).toBe(false);
    });
  });

  test('a claimed device code cannot be claimed twice', async () => {
    await withGovernor(async (g, clock) => {
      const knock = await g.knockCreate(CLIENT, HOST, PURPOSE);
      if ('error' in knock) throw new Error('knock refused');
      expect(g.knockDecide(knock.userCode, 'approved', DOOR, 'full-house')).toBe(true);
      clock.advance(5);
      expect((await g.devicePoll(knock.deviceCode, CLIENT)).status).toBe('ready');
      clock.advance(5);
      expect(await g.devicePoll(knock.deviceCode, CLIENT)).toEqual({ status: 'expired' });
    });
  });

  test('wrong client_id and unknown device codes are told nothing but expired', async () => {
    await withGovernor(async (g) => {
      const knock = await g.knockCreate(CLIENT, HOST, PURPOSE);
      if ('error' in knock) throw new Error('knock refused');
      expect(await g.devicePoll(knock.deviceCode, 'someone-else')).toEqual({ status: 'expired' });
      expect(await g.devicePoll('no-such-device-code', CLIENT)).toEqual({ status: 'expired' });
    });
  });

  test('knock flooding: a seventh pending knock is refused, and expiry clears the jam', async () => {
    await withGovernor(async (g, clock) => {
      for (let i = 0; i < 6; i++) {
        expect(await g.knockCreate(CLIENT, HOST, PURPOSE)).toHaveProperty('deviceCode');
      }
      expect(await g.knockCreate(CLIENT, HOST, PURPOSE)).toEqual({ error: 'slow_down' });
      clock.advance(901);
      expect(await g.knockCreate(CLIENT, HOST, PURPOSE)).toHaveProperty('deviceCode');
    });
  });

  test('knockDecide rejects an unknown code, an unknown decision and an unknown scope', async () => {
    await withGovernor(async (g) => {
      const knock = await g.knockCreate(CLIENT, HOST, PURPOSE);
      if ('error' in knock) throw new Error('knock refused');
      expect(g.knockDecide('BBBB-BBBB', 'approved', DOOR, 'full-house')).toBe(false);
      expect(g.knockDecide(knock.userCode, 'maybe' as 'approved', DOOR, 'full-house')).toBe(false);
      expect(g.knockDecide(knock.userCode, 'approved', DOOR, 'whole-house' as 'full-house')).toBe(false);
      expect(g.knockDecide(knock.userCode, 'approved', DOOR, 'full-house')).toBe(true);
    });
  });

  test('re-knocking a door reuses its lease id and kills the old tokens', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      const before = await g.validateAccess(first.accessToken);
      clock.advance(60);
      const second = await enroll(g, clock);
      const after = await g.validateAccess(second.accessToken);
      expect(after?.leaseId).toBe(before?.leaseId);
      expect(await g.validateAccess(first.accessToken)).toBeNull();
      expect((await g.mintFromRefresh(first.refreshToken)).status).toBe('invalid');
      expect(g.leaseList().filter((l) => l.doorName === DOOR).length).toBe(1);
    });
  });
});

describe('rotation machine', () => {
  test('normal rotation: the old refresh becomes prev and the new pair works', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      clock.advance(60);
      const rotated = await g.mintFromRefresh(first.refreshToken);
      expect(rotated).toEqual({
        status: 'ok',
        accessToken: expect.stringMatching(ACCESS_RE),
        refreshToken: expect.stringMatching(REFRESH_RE),
        expiresIn: 3600,
        scope: 'full-house',
      });
      if (rotated.status !== 'ok') throw new Error('unreachable');
      expect(rotated.refreshToken).not.toBe(first.refreshToken);
      expect(await g.validateAccess(rotated.accessToken)).toMatchObject({ doorName: DOOR, scope: 'full-house' });
      expect(await g.validateAccess(first.accessToken)).toBeNull();
      expect(g.leaseList().find((l) => l.doorName === DOOR)?.lastRenewal).toBe(clock.t);
    });
  });

  test('lost-response retry: a prev refresh with an unused successor mints a fresh pair', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);            // A1, R1
      const second = await g.mintFromRefresh(first.refreshToken);   // A2, R2 — response "lost"
      if (second.status !== 'ok') throw new Error('unreachable');
      const retry = await g.mintFromRefresh(first.refreshToken);    // R1 again
      expect(retry.status).toBe('ok');
      if (retry.status !== 'ok') throw new Error('unreachable');

      // The unreceived successor was revoked in the same breath.
      expect((await g.mintFromRefresh(second.refreshToken)).status).toBe('invalid');
      expect(await g.validateAccess(second.accessToken)).toBeNull();
      expect(await g.validateAccess(retry.accessToken)).toMatchObject({ doorName: DOOR });
      expect(g.leaseList().find((l) => l.doorName === DOOR)?.status).toBe('living');
    });
  });

  test('theft: a prev refresh whose successor was used kills the lease', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      const leaseId = (await g.validateAccess(first.accessToken))?.leaseId;
      const second = await g.mintFromRefresh(first.refreshToken);
      if (second.status !== 'ok') throw new Error('unreachable');
      const third = await g.mintFromRefresh(second.refreshToken);   // R2 is now used
      if (third.status !== 'ok') throw new Error('unreachable');

      expect(await g.mintFromRefresh(first.refreshToken)).toEqual({ status: 'killed' });

      expect(await g.validateAccess(third.accessToken)).toBeNull();
      expect(await g.validateAccess(second.accessToken)).toBeNull();
      expect((await g.mintFromRefresh(third.refreshToken)).status).toBe('invalid');
      expect(g.leaseList().find((l) => l.doorName === DOOR)?.status).toBe('killed-rotation');

      const entry = g.entries(5)[0];
      expect(entry.sub).toBe(`lease:${leaseId}`);
      expect(entry.service).toBe('lease');
      expect(entry.verb).toBe('killed');
      expect(entry.allowed).toBe(0);
      expect(entry.detail).toContain('rotation replay');
    });
  });

  test('unknown refresh → invalid, and nothing is killed or ledgered', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      expect(await g.mintFromRefresh(`jlr_${'A'.repeat(43)}`)).toEqual({ status: 'invalid' });
      expect(await g.mintFromRefresh('')).toEqual({ status: 'invalid' });
      expect(await g.mintFromRefresh(first.accessToken)).toEqual({ status: 'invalid' }); // access is not refresh
      expect(g.leaseList().find((l) => l.doorName === DOOR)?.status).toBe('living');
      expect(await g.validateAccess(first.accessToken)).not.toBeNull();
      expect(g.entries(50).length).toBe(0);
    });
  });

  test('a revoked lease cannot rotate', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      expect(g.leaseRevoke(DOOR, 'marcus')).toBe(true);
      expect(await g.mintFromRefresh(first.refreshToken)).toEqual({ status: 'invalid' });
    });
  });
});

describe('validateAccess', () => {
  test('is non-ledgering: twenty validations add zero ledger rows', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      const before = g.entries(200).length;
      for (let i = 0; i < 20; i++) expect(await g.validateAccess(first.accessToken)).not.toBeNull();
      expect(g.entries(200).length).toBe(before);
      expect(before).toBe(0);
    });
  });

  test('expired access token → null', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      clock.advance(3599);
      expect(await g.validateAccess(first.accessToken)).not.toBeNull();
      clock.advance(2);
      expect(await g.validateAccess(first.accessToken)).toBeNull();
    });
  });

  test('revoked lease → null immediately; unknown token → null', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      expect(await g.validateAccess(`jla_${'A'.repeat(43)}`)).toBeNull();
      expect(g.leaseRevoke(DOOR, 'marcus')).toBe(true);
      expect(await g.validateAccess(first.accessToken)).toBeNull();
    });
  });
});

describe('reserveLease caps', () => {
  test('per-lease cap refuses before the global one and names itself', async () => {
    await withGovernor(async (g) => {
      expect(g.reserveLease('L1', 'door:a', 'mail', 'send', 'to=x', null, 2)).toEqual({ ok: true, count: 1, cap: null });
      expect(g.reserveLease('L1', 'door:a', 'mail', 'send', 'to=x', null, 2)).toEqual({ ok: true, count: 2, cap: null });
      expect(g.reserveLease('L1', 'door:a', 'mail', 'send', 'to=x', null, 2))
        .toEqual({ ok: false, refusedBy: 'lease', count: 2, cap: 2 });
    });
  });

  test('the lease counter is named first when both counters are full', async () => {
    await withGovernor(async (g) => {
      expect(g.reserveLease('L1', 'door:a', 'mail', 'send', 'd', 1, 1)).toEqual({ ok: true, count: 1, cap: 1 });
      expect(g.reserveLease('L1', 'door:a', 'mail', 'send', 'd', 1, 1))
        .toEqual({ ok: false, refusedBy: 'lease', count: 1, cap: 1 });
    });
  });

  test('global cap counts across leases and names itself', async () => {
    await withGovernor(async (g) => {
      expect(g.reserveLease('L1', 'door:a', 'mail', 'send', 'd', 3, null)).toEqual({ ok: true, count: 1, cap: 3 });
      expect(g.reserveLease('L1', 'door:a', 'mail', 'send', 'd', 3, null)).toEqual({ ok: true, count: 2, cap: 3 });
      expect(g.reserveLease('L2', 'door:b', 'mail', 'send', 'd', 3, null)).toEqual({ ok: true, count: 3, cap: 3 });
      expect(g.reserveLease('L2', 'door:b', 'mail', 'send', 'd', 3, null))
        .toEqual({ ok: false, refusedBy: 'global', count: 3, cap: 3 });
      // A different verb has its own bucket.
      expect(g.reserveLease('L2', 'door:b', 'mail', 'list', 'd', 3, null)).toEqual({ ok: true, count: 1, cap: 3 });
    });
  });

  test('caps are per UTC day and refusals never count against tomorrow', async () => {
    await withGovernor(async (g, clock) => {
      expect(g.reserveLease('L1', 'door:a', 'mail', 'send', 'd', 1, null).ok).toBe(true);
      expect(g.reserveLease('L1', 'door:a', 'mail', 'send', 'd', 1, null).ok).toBe(false);
      clock.advance(86_400);
      expect(g.reserveLease('L1', 'door:a', 'mail', 'send', 'd', 1, null)).toEqual({ ok: true, count: 1, cap: 1 });
    });
  });

  test('every act is ledgered under sub lease:<id> with the door from the lease row', async () => {
    await withGovernor(async (g, clock) => {
      await enroll(g, clock);
      const lease = g.leaseList().find((l) => l.doorName === DOOR);
      if (!lease) throw new Error('no lease');
      g.reserveLease(lease.leaseId, lease.doorName, 'mail', 'send', 'to=a@b.c', null, 1);
      const refused = g.reserveLease(lease.leaseId, lease.doorName, 'mail', 'send', 'to=a@b.c', null, 1);
      expect(refused.ok).toBe(false);
      expect(g.entries(10)[0]).toEqual({
        ts: clock.t, sub: `lease:${lease.leaseId}`, service: 'mail', verb: 'send',
        detail: `door=${DOOR} to=a@b.c`, allowed: 0,
      });
      expect(g.entries(10)[1].allowed).toBe(1);
      expect(g.leaseList().find((l) => l.doorName === DOOR)?.lastVerb).toBe('mail.send');
    });
  });
});

describe('admin', () => {
  test('leaseRevoke works by door name or lease id, and only once', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      const identity = await g.validateAccess(first.accessToken);
      if (!identity) throw new Error('no identity');
      expect(g.leaseRevoke('door:nobody', 'marcus')).toBe(false);
      expect(g.leaseRevoke(identity.leaseId, 'marcus')).toBe(true);
      expect(g.leaseRevoke(DOOR, 'marcus')).toBe(false); // already revoked
      expect(await g.validateAccess(first.accessToken)).toBeNull();
      const entry = g.entries(5)[0];
      expect(entry.sub).toBe(`lease:${identity.leaseId}`);
      expect(entry.service).toBe('lease');
      expect(entry.verb).toBe('revoked');
      expect(entry.detail).toBe(`door=${DOOR} by=marcus`);
    });
  });

  test('leaseList shows name, scope, status and birth', async () => {
    await withGovernor(async (g, clock) => {
      await enroll(g, clock, 'door:one', 'full-house');
      clock.advance(30);
      await enroll(g, clock, 'door:two', 'reading-room');
      const list = g.leaseList();
      expect(list.find((l) => l.doorName === 'door:one')).toEqual({
        leaseId: expect.any(String), doorName: 'door:one', scope: 'full-house',
        status: 'living', born: START + 5000, lastRenewal: null, lastVerb: null,
      });
      expect(list.find((l) => l.doorName === 'door:two')?.scope).toBe('reading-room');
      expect(list.find((l) => l.doorName === 'legacy-window')?.status).toBe('living');
    });
  });

  test('leaseExport carries hashes and never a plaintext token', async () => {
    await withGovernor(async (g, clock) => {
      await enroll(g, clock);
      const dump = g.leaseExport();
      expect(JSON.stringify(dump)).not.toMatch(/jla_|jlr_/);
      expect(dump.leases.length).toBe(2); // the door plus the legacy pseudo-lease
      expect(dump.tokens.length).toBe(2); // one access, one refresh
      for (const token of dump.tokens as Array<{ hash: string; kind: string }>) {
        expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(['access', 'refresh']).toContain(token.kind);
      }
      expect(dump.knocks.length).toBe(1);
      expect(dump.knocks[0]).not.toHaveProperty('device_code');
    });
  });

  test('legacyAllowed is seeded living and revoking legacy-window flips it false', async () => {
    await withGovernor(async (g) => {
      expect(g.legacyAllowed()).toBe(true);
      expect(g.leaseRevoke('legacy-window', 'marcus')).toBe(true);
      expect(g.legacyAllowed()).toBe(false);
    });
  });
});

describe('the existing ledger faces are untouched', () => {
  test('reserve and entries keep their shape beside the lease tables', async () => {
    await withGovernor(async (g) => {
      expect(g.reserve('user_marcus', 'mail', 'send', 'to=a@b.c', 2)).toEqual({ ok: true, count: 1, cap: 2 });
      expect(g.reserve('user_marcus', 'mail', 'send', 'to=a@b.c', 2)).toEqual({ ok: true, count: 2, cap: 2 });
      expect(g.reserve('user_marcus', 'mail', 'send', 'to=a@b.c', 2).ok).toBe(false);
      expect(g.entries(10).length).toBe(3);
    });
  });
});
