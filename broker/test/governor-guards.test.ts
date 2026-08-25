// The guards that live *below* every mint path: reserved door names, the
// knock's scope allowlist, the second legacy window, and the positive pen.
//
// COLD H-5's requirement is that the reserved-name check is not a property of
// any one face but of `upsertLease` itself, so a caller that reaches the mint
// from below — a knock row edited straight in storage, a future flow nobody has
// written yet — is refused by the same statement. These cases therefore drive
// the DO directly (`runInDurableObject`) rather than through HTTP.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { KNOCK_SCOPES } from 'julian-shared/scopes';
import type { GovernorDO, LeaseScope } from '../src/governor';

const CLIENT = 'julian-new-web';
const HOST = 'julian-new.exe.xyz';
const PURPOSE = 'web app subprocess';
const START = Date.UTC(2026, 7, 13, 12, 0, 0);

// Every reserved identifier the spec names, and the class each belongs to.
const BROWSER_NAME = 'browser:mallory';
const VISIT_NAME = 'visit:evil.example';
const LEGACY_NAMES = ['legacy-window', 'legacy-window-sync'] as const;
const RESERVED_NAMES = [BROWSER_NAME, VISIT_NAME, ...LEGACY_NAMES];

interface Clock { t: number; advance(seconds: number): void }

function stub(): DurableObjectStub {
  const ns = (env as { GOVERNOR: DurableObjectNamespace }).GOVERNOR;
  return ns.get(ns.idFromName(`guards-${crypto.randomUUID()}`));
}

/** One DO per case, one hand-driven clock: no wall time, no shared state. */
async function withGovernor(fn: (g: GovernorDO, clock: Clock) => Promise<void> | void): Promise<void> {
  await runInDurableObject(stub(), async (g: GovernorDO) => {
    const clock: Clock = { t: START, advance(seconds: number) { this.t += seconds * 1000; } };
    (g as unknown as { now: () => number }).now = () => clock.t;
    await fn(g, clock);
  });
}

function sqlOf(g: GovernorDO): SqlStorage {
  return (g as unknown as { sql: SqlStorage }).sql;
}

async function knock(g: GovernorDO): Promise<{ deviceCode: string; userCode: string }> {
  const created = await g.knockCreate(CLIENT, HOST, PURPOSE);
  if ('error' in created) throw new Error('knock refused');
  return { deviceCode: created.deviceCode, userCode: created.userCode };
}

describe('reserved identifiers (COLD H-5)', () => {
  test('a device knock cannot take browser:*, visit:*, or the legacy literals', async () => {
    await withGovernor(async (g) => {
      for (const name of RESERVED_NAMES) {
        const k = await knock(g);
        expect(g.knockDecide(k.userCode, 'approved', name, 'full-house'), name).toBe(false);
      }
      // Nothing was written: no knock was decided, so no lease could be born.
      // (Only legacy-window is still seeded; the sync window's seed was
      // deleted at the sunset, and its NAME stays refused above regardless.)
      expect(g.leaseList().map((l) => l.doorName).sort())
        .toEqual(['legacy-window']);
    });
  });

  test('knockDecide still approves an ordinary door on every knockable scope', async () => {
    await withGovernor(async (g) => {
      for (const scope of KNOCK_SCOPES) {
        const k = await knock(g);
        expect(g.knockDecide(k.userCode, 'approved', `door:${scope}`, scope), scope).toBe(true);
      }
    });
  });

  test('knockDecide refuses scope stream (KNOCK_SCOPES is the gate)', async () => {
    await withGovernor(async (g) => {
      const k = await knock(g);
      expect(g.knockDecide(k.userCode, 'approved', 'door:x', 'stream' as unknown as LeaseScope)).toBe(false);
    });
  });

  test('the guard is in upsertLease: a reserved name approved from below still refuses at the poll', async () => {
    await withGovernor(async (g, clock) => {
      const k = await knock(g);
      // Bypass knockDecide entirely — this is the "from below" caller.
      sqlOf(g).exec(
        "UPDATE knocks SET status = 'approved', door_name = ?, scope = 'full-house' WHERE device_code = ?",
        BROWSER_NAME, k.deviceCode,
      );
      clock.advance(5);
      expect(await g.devicePoll(k.deviceCode, CLIENT)).toEqual({ status: 'refused' });
      expect(g.leaseList().some((l) => l.doorName === BROWSER_NAME)).toBe(false);
    });
  });

  test('authcode may mint visit:* but never browser:* or legacy names', async () => {
    await withGovernor(async (g) => {
      expect((await g.mintAuthcodeLease('visit:ok.example', 'reading-room', 'julian', '{}')).status).toBe('ok');
      expect((await g.mintAuthcodeLease('browser:sub', 'reading-room', 'julian', '{}')).status).toBe('invalid');
      for (const name of LEGACY_NAMES) {
        expect((await g.mintAuthcodeLease(name, 'reading-room', 'julian', '{}')).status, name).toBe('invalid');
      }
      // The refused names left the register exactly as it was — and the
      // unseeded legacy-window-sync was NOT created by the refused mint.
      expect(g.leaseList().map((l) => l.doorName).sort())
        .toEqual(['legacy-window', 'visit:ok.example']);
      // And the surviving legacy row kept its seeded scope: no refused mint rewrote it.
      expect(g.leaseList().find((l) => l.doorName === 'legacy-window')?.scope).toBe('full-house');
    });
  });

  test('a reserved-name row that is not living is never revived by upsert', async () => {
    await withGovernor(async (g) => {
      expect((await g.mintAuthcodeLease('visit:ok.example', 'reading-room', 'julian', '{}')).status).toBe('ok');
      expect(g.leaseRevoke('visit:ok.example', 'test')).toBe(true);
      expect((await g.mintAuthcodeLease('visit:ok.example', 'reading-room', 'julian', '{}')).status).toBe('invalid');
      expect(g.leaseList().find((l) => l.doorName === 'visit:ok.example')?.status).toBe('revoked');
    });
  });

  test('an ordinary door keeps its re-knock revival — the no-revive rule is reserved-only', async () => {
    await withGovernor(async (g, clock) => {
      const first = await knock(g);
      expect(g.knockDecide(first.userCode, 'approved', 'door:ordinary', 'reading-room')).toBe(true);
      clock.advance(5);
      expect((await g.devicePoll(first.deviceCode, CLIENT)).status).toBe('ready');
      expect(g.leaseRevoke('door:ordinary', 'test')).toBe(true);

      const second = await knock(g);
      expect(g.knockDecide(second.userCode, 'approved', 'door:ordinary', 'reading-room')).toBe(true);
      clock.advance(5);
      expect((await g.devicePoll(second.deviceCode, CLIENT)).status).toBe('ready');
      expect(g.leaseList().find((l) => l.doorName === 'door:ordinary')?.status).toBe('living');
    });
  });
});

describe('legacy-window-sync — dead after the sunset (2026-08-25, OPS N-10)', () => {
  test('a fresh register never seeds it — a from-empty rebuild cannot revive the window', async () => {
    await withGovernor((g) => {
      expect(g.leaseList().some((l) => l.leaseId === 'legacy-window-sync')).toBe(false);
      // The mail window's seed is untouched by the deletion.
      expect(g.leaseList().find((l) => l.leaseId === 'legacy-window')?.scope).toBe('full-house');
    });
  });

  test('revoking legacy-window still flips legacyAllowed', async () => {
    await withGovernor((g) => {
      expect(g.legacyAllowed()).toBe(true);
      expect(g.leaseRevoke('legacy-window', 'test')).toBe(true);
      expect(g.legacyAllowed()).toBe(false);
    });
  });
});

describe('recordAllowed — the positive pen (COLD M-8)', () => {
  test('writes exactly one allowed:1 row under lease:<id> and spends no cap', async () => {
    await withGovernor((g) => {
      g.recordAllowed('L1', 'door:x', 'stream', 'socket', 'open token_id=t1');
      const rows = g.entries(5).filter((e) => e.verb === 'socket');
      expect(rows).toHaveLength(1);
      expect(rows[0].allowed).toBe(1);
      expect(rows[0].sub).toBe('lease:L1');
      expect(rows[0].service).toBe('stream');
      expect(rows[0].ts).toBe(START);
    });
  });

  test('never refuses: the pen has no counter of its own to run out of', async () => {
    await withGovernor((g) => {
      for (let i = 0; i < 40; i++) g.recordAllowed('L1', 'door:x', 'stream', 'socket', `open ${i}`);
      const rows = g.entries(200).filter((e) => e.verb === 'socket');
      expect(rows).toHaveLength(40);
      expect(rows.every((r) => r.allowed === 1)).toBe(true);
    });
  });

  test('the door name comes from the register, not the caller, and last_verb advances', async () => {
    await withGovernor(async (g, clock) => {
      const k = await knock(g);
      expect(g.knockDecide(k.userCode, 'approved', 'door:real', 'stream-read')).toBe(true);
      clock.advance(5);
      expect((await g.devicePoll(k.deviceCode, CLIENT)).status).toBe('ready');
      const leaseId = g.leaseList().find((l) => l.doorName === 'door:real')?.leaseId ?? '';
      expect(leaseId).not.toBe('');

      g.recordAllowed(leaseId, 'door:i-am-someone-else', 'stream', 'recent', 'n=20');
      const row = g.entries(5).find((e) => e.verb === 'recent');
      expect(row?.detail).toBe('door=door:real n=20');
      expect(row?.sub).toBe(`lease:${leaseId}`);
      expect(g.leaseList().find((l) => l.doorName === 'door:real')?.lastVerb).toBe('stream.recent');
    });
  });
});
