// Socket tickets: the sixty-second, single-use credential a browser hands the
// sync worker in a query string, because a WebSocket upgrade has no header to
// put a bearer in.
//
// Four properties are proven here that nothing else can see. The ticket is a
// secret the register does not keep — only its hash is stored, so the
// break-glass dump never yields a working one. The burn is **atomic**: two
// presentations of the same ticket, raced inside one isolate, produce exactly
// one `ok` and one `reused`, and the loser is written into the ledger as a
// first-class theft signal that the fold may never collapse. The ticket table
// is **kind-scoped in both directions**: minting a ticket never disturbs an
// access row, and minting an access token never disturbs a ticket. And a
// `generation = 0` ticket row is invisible to the rotation arithmetic — a
// device lease with a stray ticket beside it rotates and detonates exactly as
// it did before tickets existed.
//
// Every case drives the DO directly, on its own hand-driven clock.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { TICKET_MINT_CAP, TICKET_PREFIX, TICKET_TTL_SECONDS } from '../src/governor';
import type { GovernorDO } from '../src/governor';

const START = Date.UTC(2026, 7, 13, 12, 0, 0);
const TICKET_RE = /^jst_[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT = 'julian-new-web';
const HOST = 'julian-new.exe.xyz';
const PURPOSE = 'web app subprocess';
const DEVICE_DOOR = 'door:julian-new-web';

interface Clock { t: number; advance(seconds: number): void }

function stub(): DurableObjectStub {
  const ns = (env as { GOVERNOR: DurableObjectNamespace }).GOVERNOR;
  return ns.get(ns.idFromName(`tickets-${crypto.randomUUID()}`));
}

/** One DO per case, one hand-driven clock: no wall time, no shared state. */
async function withGovernor(fn: (g: GovernorDO, clock: Clock) => Promise<void> | void): Promise<void> {
  await runInDurableObject(stub(), async (g: GovernorDO) => {
    const clock: Clock = { t: START, advance(seconds: number) { this.t += seconds * 1000; } };
    (g as unknown as { now: () => number }).now = () => clock.t;
    await fn(g, clock);
  });
}

/** The register's own storage, for the facts no RPC exposes: kinds, expiries, the used flag. */
function sqlOf(g: GovernorDO): SqlStorage {
  return (g as unknown as { sql: SqlStorage }).sql;
}

interface TokenRow {
  hash: string; kind: string; generation: number; expires: number | null;
  used: number; token_id: string | null;
}

function tokensOf(g: GovernorDO, leaseId: string): TokenRow[] {
  return sqlOf(g).exec(
    'SELECT hash, kind, generation, expires, used, token_id FROM lease_tokens WHERE lease_id = ? ORDER BY rowid',
    leaseId,
  ).toArray() as unknown as TokenRow[];
}

function kindsOf(g: GovernorDO, leaseId: string, kind: string): TokenRow[] {
  return tokensOf(g, leaseId).filter((t) => t.kind === kind);
}

type Session = { leaseId: string; tokenId: string; accessToken: string };

/** A browser session: the only holder the ticket face will ever mint for. */
async function session(g: GovernorDO, sub = 'sub-marcus'): Promise<Session> {
  const m = await g.mintExchangeAccess(sub, 'julian');
  if (m.status !== 'ok') throw new Error(`expected ok, got ${m.status}`);
  return { leaseId: m.leaseId, tokenId: m.tokenId, accessToken: m.accessToken };
}

async function ticket(g: GovernorDO, s: Session): Promise<string> {
  const t = await g.mintTicket(s.leaseId, s.tokenId);
  if (t.status !== 'ok') throw new Error(`expected ok, got ${t.status}`);
  return t.ticket;
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

describe('mintTicket', () => {
  test('the constants are the spec\'s: jst_, sixty seconds, ten live', () => {
    expect(TICKET_PREFIX).toBe('jst_');
    expect(TICKET_TTL_SECONDS).toBe(60);
    expect(TICKET_MINT_CAP).toBe(10);
  });

  test('mints a jst_ ticket of 47 characters and stores only its hash', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      const minted = await g.mintTicket(s.leaseId, s.tokenId);
      expect(minted.status).toBe('ok');
      if (minted.status !== 'ok') throw new Error('unreachable');
      expect(minted.ticket).toMatch(TICKET_RE);
      expect(minted.ticket).toHaveLength(47);
      expect(minted.expiresIn).toBe(60);

      // The break-glass dump yields no working credential: not the plaintext,
      // and nothing that looks like one.
      const dump = JSON.stringify(g.leaseExport());
      expect(dump).not.toMatch(/jst_/);
      expect(dump).not.toContain(minted.ticket);

      // Minting is a read-shaped act: the pen belongs to the consume, not here.
      expect(g.entries(50)).toHaveLength(0);
    });
  });

  test('the stored row is the spec\'s row: kind ticket, generation 0, TTL 60s, bound to the token handle', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      await ticket(g, s);
      const rows = kindsOf(g, s.leaseId, 'ticket');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'ticket', generation: 0, used: 0, expires: START + 60_000, token_id: s.tokenId,
      });
      expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].token_id).toMatch(UUID_RE);
    });
  });

  test('two mints are two rows: a retried mint after a lost response is simply a second ticket', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      const a = await ticket(g, s);
      const b = await ticket(g, s);
      expect(a).not.toBe(b);
      expect(kindsOf(g, s.leaseId, 'ticket')).toHaveLength(2);
      expect(await g.consumeTicket(a)).toMatchObject({ ok: true });
      expect(await g.consumeTicket(b)).toMatchObject({ ok: true });
    });
  });

  test('the eleventh live ticket is refused typed, and the prune frees the cap', async () => {
    await withGovernor(async (g, clock) => {
      const s = await session(g);
      const minted: string[] = [];
      for (let i = 0; i < TICKET_MINT_CAP; i++) minted.push(await ticket(g, s));
      expect(await g.mintTicket(s.leaseId, s.tokenId)).toEqual({ status: 'cap' });
      // The refusal spent nothing: all ten are still standing.
      expect(kindsOf(g, s.leaseId, 'ticket')).toHaveLength(TICKET_MINT_CAP);

      clock.advance(TICKET_TTL_SECONDS + 1);
      const fresh = await g.mintTicket(s.leaseId, s.tokenId);
      expect(fresh.status).toBe('ok');
      // The ten dead rows are gone, not merely ignored.
      expect(kindsOf(g, s.leaseId, 'ticket')).toHaveLength(1);
      for (const dead of minted) expect(await g.consumeTicket(dead)).toEqual({ ok: false, error: 'unknown' });
    });
  });
});

describe('consumeTicket', () => {
  test('one presentation answers ok, carrying the (leaseId, tokenId) binding and the whole identity', async () => {
    await withGovernor(async (g) => {
      const s = await session(g, 'sub-marcus');
      const t = await ticket(g, s);
      expect(await g.consumeTicket(t)).toEqual({
        ok: true,
        leaseId: s.leaseId,
        tokenId: s.tokenId,
        subject: 'sub-marcus',
        scope: 'stream',
        flow: 'exchange',
        principal: 'julian',
      });
    });
  });

  test('the success is ledgered under the lease, allowed, naming the token handle', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      await g.consumeTicket(await ticket(g, s));
      const entries = g.entries(10);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        sub: `lease:${s.leaseId}`, service: 'stream', verb: 'ticket.consume', allowed: 1,
      });
      expect(entries[0].detail).toContain('door=browser:sub-marcus');
      expect(entries[0].detail).toContain(`token_id=${s.tokenId}`);
    });
  });

  test('a non-julian principal rides the ticket through', async () => {
    await withGovernor(async (g) => {
      const m = await g.mintExchangeAccess('sub-renee', 'renee');
      if (m.status !== 'ok') throw new Error('unreachable');
      const s = { leaseId: m.leaseId, tokenId: m.tokenId, accessToken: m.accessToken };
      expect(await g.consumeTicket(await ticket(g, s))).toMatchObject({
        principal: 'renee', subject: 'sub-renee', scope: 'stream', flow: 'exchange',
      });
    });
  });

  test('two concurrent presentations: exactly one ok, the other a ledgered theft signal', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      const t = await ticket(g, s);
      const [a, b] = await Promise.all([g.consumeTicket(t), g.consumeTicket(t)]);
      const results = [a, b];
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'reused' }]);

      const theft = g.entries(10).find((e) => e.verb === 'ticket-reused');
      expect(theft).toBeDefined();
      expect(theft).toMatchObject({ sub: `lease:${s.leaseId}`, service: 'stream', allowed: 0 });
      // A theft signal names the credential without naming the credential.
      expect(theft?.detail).toContain(`token_id=${s.tokenId}`);
      expect(theft?.detail).not.toContain(t);
    });
  });

  test('a sequential second presentation is reused too, and the burn is permanent', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      const t = await ticket(g, s);
      expect(await g.consumeTicket(t)).toMatchObject({ ok: true });
      expect(await g.consumeTicket(t)).toEqual({ ok: false, error: 'reused' });
      expect(await g.consumeTicket(t)).toEqual({ ok: false, error: 'reused' });
      expect(kindsOf(g, s.leaseId, 'ticket')[0].used).toBe(1);
      expect(g.entries(10).filter((e) => e.verb === 'ticket-reused')).toHaveLength(2);
    });
  });

  test('an unknown ticket is unknown, and writes nothing', async () => {
    await withGovernor(async (g) => {
      await session(g);
      expect(await g.consumeTicket(`${TICKET_PREFIX}${'A'.repeat(43)}`)).toEqual({ ok: false, error: 'unknown' });
      expect(await g.consumeTicket('')).toEqual({ ok: false, error: 'unknown' });
      expect(g.entries(10)).toHaveLength(0);
    });
  });

  test('a ticket presented one second late is expired — and spent either way', async () => {
    await withGovernor(async (g, clock) => {
      const s = await session(g);
      const t = await ticket(g, s);
      clock.advance(TICKET_TTL_SECONDS - 1);
      // Still inside the window at 59 seconds: the TTL row is honored to its edge.
      const early = await g.mintTicket(s.leaseId, s.tokenId);
      if (early.status !== 'ok') throw new Error('unreachable');
      clock.advance(2);
      expect(await g.consumeTicket(t)).toEqual({ ok: false, error: 'expired' });
      // Burned on presentation: a late ticket is dead, and it is dead once.
      expect(kindsOf(g, s.leaseId, 'ticket').find((r) => r.expires === START + 60_000)?.used).toBe(1);
      // The one minted at 59 seconds is still inside its own window.
      expect(await g.consumeTicket(early.ticket)).toMatchObject({ ok: true });
    });
  });

  test('an access token is not a ticket: only kind=ticket rows answer', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      expect(await g.consumeTicket(s.accessToken)).toEqual({ ok: false, error: 'unknown' });
      // And a ticket is not an access token.
      const t = await ticket(g, s);
      expect(await g.validateAccess(t)).toBeNull();
    });
  });

  test('a ticket on a lease that stopped living refuses unknown-shaped, with its own ledgered detail', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      const t = await ticket(g, s);
      // Set directly: `leaseRevoke` burns the token rows, and the branch under
      // test is the one where the row outlives the lease's standing.
      sqlOf(g).exec("UPDATE leases SET status = 'revoked' WHERE lease_id = ?", s.leaseId);
      expect(await g.consumeTicket(t)).toEqual({ ok: false, error: 'unknown' });
      const entry = g.entries(10)[0];
      expect(entry).toMatchObject({
        sub: `lease:${s.leaseId}`, service: 'stream', verb: 'ticket.consume', allowed: 0,
      });
      expect(entry.detail).toContain('lease not living');
      // Burned all the same, so a later revival cannot make it live again.
      expect(kindsOf(g, s.leaseId, 'ticket')[0].used).toBe(1);
    });
  });
});

describe('the ticket table is kind-scoped in both directions', () => {
  test('the exchange-access prune leaves ticket rows alone', async () => {
    await withGovernor(async (g, clock) => {
      const s = await session(g);
      for (let i = 0; i < 3; i++) await ticket(g, s);
      clock.advance(TICKET_TTL_SECONDS + 1);   // tickets dead, the access token alive
      const again = await g.mintExchangeAccess('sub-marcus', 'julian');
      expect(again.status).toBe('ok');
      expect(kindsOf(g, s.leaseId, 'ticket')).toHaveLength(3);
      expect(kindsOf(g, s.leaseId, 'access')).toHaveLength(2);
    });
  });

  test('the ticket prune leaves access rows alone, even expired ones', async () => {
    await withGovernor(async (g, clock) => {
      const s = await session(g);
      for (let i = 0; i < 3; i++) await ticket(g, s);
      clock.advance(3601);                      // every access row dead too
      const fresh = await g.mintTicket(s.leaseId, s.tokenId);
      expect(fresh.status).toBe('ok');
      expect(kindsOf(g, s.leaseId, 'ticket')).toHaveLength(1);
      // Untouched: reaping expired access rows is the exchange mint's business.
      expect(kindsOf(g, s.leaseId, 'access')).toHaveLength(1);
    });
  });

  test('the ticket cap counts tickets only, and the session cap counts access only', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      for (let i = 0; i < TICKET_MINT_CAP; i++) await ticket(g, s);
      // Ten live tickets do not stand between a second tab and its token.
      expect((await g.mintExchangeAccess('sub-marcus', 'julian')).status).toBe('ok');
      // And a second access row does not free a ticket slot.
      expect(await g.mintTicket(s.leaseId, s.tokenId)).toEqual({ status: 'cap' });
    });
  });
});

describe('rotation arithmetic ignores ticket rows', () => {
  test('a device lease with a stray ticket beside it rotates, keeps its ticket, and still detonates', async () => {
    await withGovernor(async (g, clock) => {
      const first = await enroll(g, clock);
      const leaseId = g.leaseList().find((l) => l.doorName === DEVICE_DOOR)?.leaseId ?? '';
      const handle = kindsOf(g, leaseId, 'access')[0].token_id ?? '';
      const stray = await g.mintTicket(leaseId, handle);
      expect(stray.status).toBe('ok');

      const second = await g.mintFromRefresh(first.refreshToken);
      if (second.status !== 'ok') throw new Error('unreachable');
      // Generation 0 on the ticket row did not reset the chain: the successor
      // pair is generation 2, exactly as it is with no ticket present.
      const refreshGenerations = tokensOf(g, leaseId)
        .filter((t) => t.kind === 'refresh' || t.kind === 'refresh_prev' || t.kind === 'revoked')
        .map((t) => t.generation).sort();
      expect(refreshGenerations).toEqual([1, 2]);
      // The rotation retired the old access row and left the ticket standing.
      expect(kindsOf(g, leaseId, 'ticket')).toHaveLength(1);

      const third = await g.mintFromRefresh(second.refreshToken);
      if (third.status !== 'ok') throw new Error('unreachable');
      expect(await g.mintFromRefresh(first.refreshToken)).toEqual({ status: 'killed' });
      expect(g.leaseList().find((l) => l.doorName === DEVICE_DOOR)?.status).toBe('killed-rotation');
      // The kill burns everything, tickets included.
      expect(tokensOf(g, leaseId)).toHaveLength(0);
    });
  });
});
