// The exchange machinery: browser-session leases that hold an access token and
// nothing else.
//
// Three things are proven here that no other suite can see. First, an exchange
// lease is *access-only* — the Pocket ID session is the renewal root, so no
// refresh row is ever minted and `insertPair`'s delete-then-insert is never
// reached (SEC NEW-9/NEW-10). Second, the session cap **refuses** rather than
// evicting: a sixth tab does not silently log out the first five. Third,
// `reinstate` is the one verb that undoes a revoke, and it undoes nothing else
// — a rotation kill stays killed.
//
// Every case drives the DO directly, on its own hand-driven clock.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { EXCHANGE_SCOPES } from 'julian-shared/scopes';
import { EXCHANGE_SESSION_CAP } from '../src/governor';
import type { GovernorDO, LeaseIdentity } from '../src/governor';

const START = Date.UTC(2026, 7, 13, 12, 0, 0);
const ACCESS_RE = /^jla_[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT = 'julian-new-web';
const HOST = 'julian-new.exe.xyz';
const PURPOSE = 'web app subprocess';
const DEVICE_DOOR = 'door:julian-new-web';
const EXCHANGE_SCOPE = EXCHANGE_SCOPES[0];

interface Clock { t: number; advance(seconds: number): void }

function stub(): DurableObjectStub {
  const ns = (env as { GOVERNOR: DurableObjectNamespace }).GOVERNOR;
  return ns.get(ns.idFromName(`exchange-${crypto.randomUUID()}`));
}

/** One DO per case, one hand-driven clock: no wall time, no shared state. */
async function withGovernor(fn: (g: GovernorDO, clock: Clock) => Promise<void> | void): Promise<void> {
  await runInDurableObject(stub(), async (g: GovernorDO) => {
    const clock: Clock = { t: START, advance(seconds: number) { this.t += seconds * 1000; } };
    (g as unknown as { now: () => number }).now = () => clock.t;
    await fn(g, clock);
  });
}

/** The register's own storage, for the facts no RPC exposes: token kinds, pin/latch columns. */
function sqlOf(g: GovernorDO): SqlStorage {
  return (g as unknown as { sql: SqlStorage }).sql;
}

type ExchangeOk = { status: 'ok'; leaseId: string; accessToken: string; tokenId: string; expiresIn: number };

async function mint(g: GovernorDO, sub: string, principal = 'julian'): Promise<ExchangeOk> {
  const result = await g.mintExchangeAccess(sub, principal);
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
  return result;
}

type Ready = { status: 'ready'; accessToken: string; refreshToken: string; expiresIn: number; scope: string };

async function enroll(g: GovernorDO, clock: Clock, door = DEVICE_DOOR): Promise<Ready> {
  const knock = await g.knockCreate(CLIENT, HOST, PURPOSE);
  if ('error' in knock) throw new Error('knock refused');
  expect(g.knockDecide(knock.userCode, 'approved', door, 'full-house')).toBe(true);
  clock.advance(5);
  const ready = await g.devicePoll(knock.deviceCode, CLIENT);
  if (ready.status !== 'ready') throw new Error(`expected ready, got ${ready.status}`);
  return ready;
}

function tokensOf(g: GovernorDO, leaseId: string): Array<{ kind: string; generation: number; token_id: string | null }> {
  return sqlOf(g).exec(
    'SELECT kind, generation, token_id FROM lease_tokens WHERE lease_id = ? ORDER BY rowid',
    leaseId,
  ).toArray() as unknown as Array<{ kind: string; generation: number; token_id: string | null }>;
}

describe('mintExchangeAccess', () => {
  test('mints an access-only lease: scope stream, flow exchange, subject set, zero refresh rows', async () => {
    await withGovernor(async (g) => {
      const m = await g.mintExchangeAccess('sub-marcus', 'julian');
      expect(m.status).toBe('ok');
      if (m.status !== 'ok') throw new Error('unreachable');
      expect(m.accessToken).toMatch(ACCESS_RE);
      expect(m.tokenId).toMatch(UUID_RE);
      expect(m.expiresIn).toBe(3600);
      expect(m.leaseId).toMatch(UUID_RE);

      const id = await g.validateAccess(m.accessToken);
      expect(id).toEqual({
        leaseId: m.leaseId,
        doorName: 'browser:sub-marcus',
        scope: EXCHANGE_SCOPE,
        principal: 'julian',
        subject: 'sub-marcus',
        flow: 'exchange',
        tokenId: m.tokenId,
        sittingPin: null,
        latched: null,
        exp: (START + 3600_000) / 1000,
      });
      expect(EXCHANGE_SCOPE).toBe('stream');

      const dump = g.leaseExport();
      const mine = (dump.tokens as Array<{ lease_id: string; kind: string }>)
        .filter((t) => t.lease_id === m.leaseId);
      expect(mine).toHaveLength(1);
      // No refresh row minted for the exchange lease: the Pocket ID session is
      // the renewal root, so there is nothing here to steal and rotate.
      expect(mine.every((t) => t.kind === 'access')).toBe(true);
      expect(tokensOf(g, m.leaseId)).toEqual([
        { kind: 'access', generation: 0, token_id: m.tokenId },
      ]);
      // Ledgering is not this path's business either: minting writes no rows.
      expect(g.entries(50)).toHaveLength(0);
    });
  });

  test('the register carries the lease as flow=exchange on the reserved browser: name', async () => {
    await withGovernor(async (g) => {
      await mint(g, 'sub-marcus');
      const row = g.leaseList().find((l) => l.doorName === 'browser:sub-marcus');
      expect(row).toMatchObject({
        doorName: 'browser:sub-marcus',
        scope: EXCHANGE_SCOPE,
        status: 'living',
        flow: 'exchange',
        principal: 'julian',
      });
    });
  });

  test('a non-julian principal rides the lease through to validateAccess', async () => {
    await withGovernor(async (g) => {
      const m = await mint(g, 'sub-renee', 'renee');
      expect(await g.validateAccess(m.accessToken)).toMatchObject({
        principal: 'renee', subject: 'sub-renee', flow: 'exchange',
      });
    });
  });

  test('two mints for one sub = one lease row, two simultaneously-valid tokens', async () => {
    await withGovernor(async (g) => {
      const a = await mint(g, 's');
      const b = await mint(g, 's');
      expect(a.leaseId).toBe(b.leaseId);
      expect(a.accessToken).not.toBe(b.accessToken);
      expect(a.tokenId).not.toBe(b.tokenId);
      // NOT retired by the second mint — a second tab does not close the first.
      expect(await g.validateAccess(a.accessToken)).not.toBeNull();
      expect(await g.validateAccess(b.accessToken)).not.toBeNull();
      expect(g.leaseList().filter((l) => l.doorName === 'browser:s')).toHaveLength(1);
      expect(tokensOf(g, a.leaseId)).toHaveLength(2);
    });
  });

  test('at cap: refuses typed, never evicts a live token', async () => {
    await withGovernor(async (g) => {
      expect(EXCHANGE_SESSION_CAP).toBe(6);
      const minted: ExchangeOk[] = [];
      for (let i = 0; i < EXCHANGE_SESSION_CAP; i++) minted.push(await mint(g, 's'));
      const over = await g.mintExchangeAccess('s', 'julian');
      expect(over).toEqual({ status: 'session-cap' });
      // Every one of the six is still standing: the refusal spent nothing.
      for (const m of minted) expect(await g.validateAccess(m.accessToken)).not.toBeNull();
      expect(tokensOf(g, minted[0].leaseId)).toHaveLength(EXCHANGE_SESSION_CAP);
    });
  });

  test('expired tokens are pruned at mint, freeing the cap', async () => {
    await withGovernor(async (g, clock) => {
      const minted: ExchangeOk[] = [];
      for (let i = 0; i < EXCHANGE_SESSION_CAP; i++) minted.push(await mint(g, 's'));
      expect((await g.mintExchangeAccess('s', 'julian')).status).toBe('session-cap');

      clock.advance(3601);
      const fresh = await g.mintExchangeAccess('s', 'julian');
      expect(fresh.status).toBe('ok');
      if (fresh.status !== 'ok') throw new Error('unreachable');
      // The six dead rows are gone, not merely ignored.
      expect(tokensOf(g, fresh.leaseId)).toEqual([
        { kind: 'access', generation: 0, token_id: fresh.tokenId },
      ]);
      for (const m of minted) expect(await g.validateAccess(m.accessToken)).toBeNull();
    });
  });

  test('the prune is kind-scoped: a non-access row of the same lease is never touched', async () => {
    await withGovernor(async (g, clock) => {
      const m = await mint(g, 's');
      // A ticket-shaped row, expired, standing beside the access row.
      sqlOf(g).exec(
        `INSERT INTO lease_tokens (hash, lease_id, kind, generation, expires, used, token_id)
         VALUES (?, ?, 'ticket', 0, ?, 0, ?)`,
        'a'.repeat(64), m.leaseId, START + 60_000, crypto.randomUUID(),
      );
      clock.advance(3601);
      await mint(g, 's');
      const kinds = tokensOf(g, m.leaseId).map((t) => t.kind).sort();
      expect(kinds).toEqual(['access', 'ticket']);
    });
  });

  test('a revoked exchange lease refuses the mint (typed)', async () => {
    await withGovernor(async (g) => {
      await mint(g, 's');
      expect(g.leaseRevoke('browser:s', 'test')).toBe(true);
      expect(await g.mintExchangeAccess('s', 'julian')).toEqual({ status: 'revoked' });
      expect(g.leaseList().find((l) => l.doorName === 'browser:s')?.status).toBe('revoked');
      expect(tokensOf(g, g.leaseList().find((l) => l.doorName === 'browser:s')?.leaseId ?? '')).toHaveLength(0);
    });
  });

  test('device flow is untouched: re-knock still purges old tokens', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      const before = await g.validateAccess(first.accessToken);
      expect(before).toMatchObject({ doorName: DEVICE_DOOR, flow: 'device', subject: null });
      clock.advance(60);
      const second = await enroll(g, clock);
      const after = await g.validateAccess(second.accessToken);
      expect(after?.leaseId).toBe(before?.leaseId);
      expect(await g.validateAccess(first.accessToken)).toBeNull();
      expect((await g.mintFromRefresh(first.refreshToken)).status).toBe('invalid');
      expect(g.leaseList().filter((l) => l.doorName === DEVICE_DOOR)).toHaveLength(1);
    });
  });

  test('device flow is untouched: rotation replay still detonates', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      const second = await g.mintFromRefresh(first.refreshToken);
      if (second.status !== 'ok') throw new Error('unreachable');
      const third = await g.mintFromRefresh(second.refreshToken);
      if (third.status !== 'ok') throw new Error('unreachable');
      expect(await g.mintFromRefresh(first.refreshToken)).toEqual({ status: 'killed' });
      expect(g.leaseList().find((l) => l.doorName === DEVICE_DOOR)?.status).toBe('killed-rotation');
      expect(g.entries(5)[0].verb).toBe('killed');
    });
  });

  test('a device lease still mints exactly one access and one refresh row', async () => {
    await withGovernor(async (g, clock) => {
      await enroll(g, clock);
      const leaseId = g.leaseList().find((l) => l.doorName === DEVICE_DOOR)?.leaseId ?? '';
      expect(tokensOf(g, leaseId).map((t) => t.kind).sort()).toEqual(['access', 'refresh']);
    });
  });
});

describe('reinstate (SEC NEW-11, COLD M-9)', () => {
  test('accepts revoked exchange leases only, ledgers the reason, restores no tokens', async () => {
    await withGovernor(async (g) => {
      const m = await mint(g, 's');
      expect(g.leaseRevoke('browser:s', 'test')).toBe(true);
      expect(g.reinstate('browser:s', 'approver:m', 'mistake')).toEqual({ ok: true });
      expect(g.leaseList().find((l) => l.doorName === 'browser:s')?.status).toBe('living');
      // No token resurrection: the revoke burned them and reinstate mints nothing.
      expect(await g.validateAccess(m.accessToken)).toBeNull();
      // The holder simply re-exchanges.
      expect((await g.mintExchangeAccess('s', 'julian')).status).toBe('ok');

      const entry = g.entries(10).find((e) => e.verb === 'reinstated');
      expect(entry).toBeDefined();
      expect(entry?.service).toBe('lease');
      expect(entry?.allowed).toBe(1);
      expect(entry?.detail).toBe('door=browser:s by=approver:m reason=mistake');
      expect(entry?.detail.includes('mistake')).toBe(true);
    });
  });

  test('reinstate also works by lease id', async () => {
    await withGovernor(async (g) => {
      const m = await mint(g, 's');
      expect(g.leaseRevoke('browser:s', 'test')).toBe(true);
      expect(g.reinstate(m.leaseId, 'approver:m', 'by id')).toEqual({ ok: true });
    });
  });

  test('an unknown door is not-found, and nothing is ledgered', async () => {
    await withGovernor(async (g) => {
      expect(g.reinstate('browser:nobody', 'approver:m', 'oops')).toEqual({ error: 'not-found' });
      expect(g.entries(10)).toHaveLength(0);
    });
  });

  test('a living exchange lease is not-revoked: there is nothing to undo', async () => {
    await withGovernor(async (g) => {
      await mint(g, 's');
      expect(g.reinstate('browser:s', 'approver:m', 'why')).toEqual({ error: 'not-revoked' });
    });
  });

  test('killed-rotation is undone by no verb', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      const second = await g.mintFromRefresh(first.refreshToken);
      if (second.status !== 'ok') throw new Error('unreachable');
      const third = await g.mintFromRefresh(second.refreshToken);
      if (third.status !== 'ok') throw new Error('unreachable');
      expect(await g.mintFromRefresh(first.refreshToken)).toEqual({ status: 'killed' });
      expect(g.leaseList().find((l) => l.doorName === DEVICE_DOOR)?.status).toBe('killed-rotation');

      expect(g.reinstate(DEVICE_DOOR, 'approver:m', 'please')).toEqual({ error: 'not-revoked' });
      expect(g.leaseList().find((l) => l.doorName === DEVICE_DOOR)?.status).toBe('killed-rotation');
      expect(g.entries(20).some((e) => e.verb === 'reinstated')).toBe(false);
    });
  });

  test('a revoked device lease is not reinstatable (flow-scoped)', async () => {
    await withGovernor(async (g, clock) => {
      await enroll(g, clock);
      expect(g.leaseRevoke(DEVICE_DOOR, 'test')).toBe(true);
      expect(g.reinstate(DEVICE_DOOR, 'approver:m', 'please')).toEqual({ error: 'not-exchange' });
      expect(g.leaseList().find((l) => l.doorName === DEVICE_DOOR)?.status).toBe('revoked');
    });
  });

  test('a revoked authcode visit lease is not reinstatable either', async () => {
    await withGovernor(async (g) => {
      expect((await g.mintAuthcodeLease('visit:ok.example', 'reading-room', 'julian', '{}')).status).toBe('ok');
      expect(g.leaseRevoke('visit:ok.example', 'test')).toBe(true);
      expect(g.reinstate('visit:ok.example', 'approver:m', 'please')).toEqual({ error: 'not-exchange' });
    });
  });

  test('reinstate clears sitting pin and latch', async () => {
    await withGovernor(async (g) => {
      const m = await mint(g, 's');
      sqlOf(g).exec(
        'UPDATE leases SET sitting_pin = ?, latch = ? WHERE lease_id = ?',
        'pin-abc', JSON.stringify({ pin: 'pin-abc', path: 'soul/01-naming.md' }), m.leaseId,
      );
      expect(g.leaseRevoke('browser:s', 'test')).toBe(true);
      expect(g.reinstate('browser:s', 'approver:m', 'clean slate')).toEqual({ ok: true });
      const row = sqlOf(g).exec(
        'SELECT sitting_pin, latch FROM leases WHERE lease_id = ?', m.leaseId,
      ).toArray()[0] as { sitting_pin: string | null; latch: string | null };
      expect(row).toEqual({ sitting_pin: null, latch: null });
    });
  });
});

describe('validateByHandle (R2-D3)', () => {
  test('answers for a live (lease, token) handle, carrying the token\'s own expiry', async () => {
    await withGovernor(async (g) => {
      const m = await mint(g, 's');
      const expected: LeaseIdentity = {
        leaseId: m.leaseId,
        doorName: 'browser:s',
        scope: EXCHANGE_SCOPE,
        principal: 'julian',
        subject: 's',
        flow: 'exchange',
        tokenId: m.tokenId,
        sittingPin: null,
        latched: null,
        exp: (START + 3600_000) / 1000,
      };
      expect(g.validateByHandle(m.leaseId, m.tokenId)).toEqual({ status: 'active', identity: expected });
    });
  });

  // The whole point of the verdict: a hibernating socket that wakes to a bare
  // "no" cannot tell a revoked lease (WS 4001, terminal — the app stops) from
  // an access token that simply aged out (WS 4004, re-exchange and come back).
  // The register knows which it is, so it says so.
  test('an aged-out token on a living lease is token-expired, not dead', async () => {
    await withGovernor(async (g, clock) => {
      const m = await mint(g, 's');
      clock.advance(3601);
      expect(g.validateByHandle(m.leaseId, m.tokenId)).toEqual({ status: 'token-expired' });
    });
  });

  test('a revoked lease is dead, and stays dead when its token has also aged out', async () => {
    await withGovernor(async (g, clock) => {
      const m = await mint(g, 's');
      expect(g.leaseRevoke('browser:s', 'test')).toBe(true);
      expect(g.validateByHandle(m.leaseId, m.tokenId)).toEqual({ status: 'dead' });

      // Revocation is terminal, and terminal outranks aged: a lease killed
      // while its token was still in date must not later soften into
      // "re-exchange" merely because the clock moved on.
      const second = await mint(g, 'two');
      sqlOf(g).exec("UPDATE leases SET status = 'killed-rotation' WHERE lease_id = ?", second.leaseId);
      clock.advance(3601);
      expect(g.validateByHandle(second.leaseId, second.tokenId)).toEqual({ status: 'dead' });
    });
  });

  test('a wrong handle, an empty one and another lease\'s handle are all dead', async () => {
    await withGovernor(async (g) => {
      const m = await mint(g, 's');
      expect(g.validateByHandle(m.leaseId, 'not-the-handle')).toEqual({ status: 'dead' });
      expect(g.validateByHandle('not-the-lease', m.tokenId)).toEqual({ status: 'dead' });
      expect(g.validateByHandle(m.leaseId, '')).toEqual({ status: 'dead' });
      expect(g.validateByHandle('', '')).toEqual({ status: 'dead' });
      // The handle is scoped to its own lease: another lease's id will not do.
      const other = await mint(g, 'other');
      expect(g.validateByHandle(other.leaseId, m.tokenId)).toEqual({ status: 'dead' });
    });
  });

  test('a device lease answers by handle too, with subject null and flow device', async () => {
    await withGovernor(async (g, clock) => {
      await enroll(g, clock);
      const leaseId = g.leaseList().find((l) => l.doorName === DEVICE_DOOR)?.leaseId ?? '';
      const handle = tokensOf(g, leaseId).find((t) => t.kind === 'access')?.token_id ?? '';
      expect(handle).toMatch(UUID_RE);
      expect(g.validateByHandle(leaseId, handle)).toEqual({
        status: 'active',
        identity: {
          leaseId,
          doorName: DEVICE_DOOR,
          scope: 'full-house',
          principal: 'julian',
          subject: null,
          flow: 'device',
          tokenId: handle,
          sittingPin: null,
          latched: null,
          exp: expect.any(Number),
        },
      });
    });
  });

  test('a refresh row is not a handle: only kind=access answers', async () => {
    await withGovernor(async (g, clock) => {
      await enroll(g, clock);
      const leaseId = g.leaseList().find((l) => l.doorName === DEVICE_DOOR)?.leaseId ?? '';
      // Give the refresh row a handle of its own; it still must not answer.
      const planted = crypto.randomUUID();
      sqlOf(g).exec(
        "UPDATE lease_tokens SET token_id = ? WHERE lease_id = ? AND kind = 'refresh'", planted, leaseId,
      );
      expect(g.validateByHandle(leaseId, planted)).toEqual({ status: 'dead' });
    });
  });

  test('is non-ledgering, like validateAccess', async () => {
    await withGovernor(async (g) => {
      const m = await mint(g, 's');
      for (let i = 0; i < 20; i++) {
        expect(g.validateByHandle(m.leaseId, m.tokenId).status).toBe('active');
        expect(await g.validateAccess(m.accessToken)).not.toBeNull();
      }
      expect(g.entries(200)).toHaveLength(0);
    });
  });
});

describe('the access token\'s expiry rides every answer about it', () => {
  test('validateAccess carries exp in seconds, not the register\'s milliseconds', async () => {
    await withGovernor(async (g) => {
      const m = await mint(g, 's');
      expect((await g.validateAccess(m.accessToken))?.exp).toBe((START + 3600_000) / 1000);
    });
  });

  test('consumeTicket answers with the MINTING token\'s expiry, not the ticket\'s', async () => {
    await withGovernor(async (g, clock) => {
      const m = await mint(g, 's');
      clock.advance(600); // the ticket is minted ten minutes into the token's hour
      const minted = await g.mintTicket(m.leaseId, m.tokenId);
      if (minted.status !== 'ok') throw new Error('expected a ticket');
      const spent = await g.consumeTicket(minted.ticket);
      expect(spent).toEqual({
        ok: true,
        leaseId: m.leaseId,
        tokenId: m.tokenId,
        subject: 's',
        scope: EXCHANGE_SCOPE,
        flow: 'exchange',
        principal: 'julian',
        // The token dies an hour after it was minted; the ticket died 60s after
        // *it* was. A socket that carried the ticket's clock would close 4004
        // within the minute.
        exp: (START + 3600_000) / 1000,
      });
    });
  });
});

describe('recordAllowed never writes a name the register cannot vouch for', () => {
  test('an unknown lease_id gets an empty door name, never the caller\'s string', async () => {
    await withGovernor((g) => {
      g.recordAllowed('no-such-lease', 'door:i-am-someone-else', 'stream', 'socket', 'open token_id=t1');
      const row = g.entries(5).find((e) => e.verb === 'socket');
      expect(row?.detail).toBe('door= open token_id=t1');
      expect(row?.detail).not.toContain('i-am-someone-else');
      expect(row?.sub).toBe('lease:no-such-lease');
      expect(row?.allowed).toBe(1);
    });
  });

  test('with no detail either, the row is still nameless rather than borrowed', async () => {
    await withGovernor((g) => {
      g.recordAllowed('no-such-lease', 'door:borrowed', 'stream', 'socket', '');
      expect(g.entries(5).find((e) => e.verb === 'socket')?.detail).toBe('door=');
    });
  });
});

describe('LeaseIdentity carries the package-state columns', () => {
  test('sitting pin and a well-formed latch are read through both validators', async () => {
    await withGovernor(async (g) => {
      const m = await mint(g, 's');
      sqlOf(g).exec(
        'UPDATE leases SET sitting_pin = ?, latch = ? WHERE lease_id = ?',
        'pin-1', JSON.stringify({ pin: 'pin-1', path: 'soul/02-wager.md' }), m.leaseId,
      );
      const expected = { sittingPin: 'pin-1', latched: { pin: 'pin-1', path: 'soul/02-wager.md' } };
      expect(await g.validateAccess(m.accessToken)).toMatchObject(expected);
      expect(g.validateByHandle(m.leaseId, m.tokenId)).toMatchObject({
        status: 'active', identity: expect.objectContaining(expected),
      });
    });
  });

  test('a latch that is not a well-formed {pin,path} reads as no latch at all', async () => {
    await withGovernor(async (g) => {
      const m = await mint(g, 's');
      for (const bad of ['', 'not json', '{}', '[]', 'null', '{"pin":"p"}', '{"pin":1,"path":2}']) {
        sqlOf(g).exec('UPDATE leases SET latch = ? WHERE lease_id = ?', bad, m.leaseId);
        expect((await g.validateAccess(m.accessToken))?.latched, bad).toBeNull();
      }
    });
  });
});
