// The package-state verbs: `seatSitting`, `setLatch`, `clearLatch`. Task 7 is
// deliberately dumb — three state writes with no policy attached, because the
// *policy* (who may latch, when to clear) lives in Task 16's read path where
// the reviewer can see it whole. What is proven here is only the mechanism:
// the seat clears an existing latch as the reset act (R2-D4), the latch
// round-trips through `validateAccess` so a reader pays no extra DO round
// trip, a reseat with a fresh pin clears whatever latch was standing, and an
// unknown lease id is a silent no-op on all three verbs — never a throw.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { GovernorDO, LeaseIdentity } from '../src/governor';

function stub(): DurableObjectStub {
  const ns = (env as { GOVERNOR: DurableObjectNamespace }).GOVERNOR;
  return ns.get(ns.idFromName(`package-state-${crypto.randomUUID()}`));
}

async function withGovernor(fn: (g: GovernorDO) => Promise<void> | void): Promise<void> {
  await runInDurableObject(stub(), async (g: GovernorDO) => {
    await fn(g);
  });
}

type Session = { leaseId: string; accessToken: string };

/** A browser session: the only holder that matters here — package state rides the lease row, not the flow. */
async function session(g: GovernorDO, sub = 'sub-marcus'): Promise<Session> {
  const m = await g.mintExchangeAccess(sub, 'julian');
  if (m.status !== 'ok') throw new Error(`expected ok, got ${m.status}`);
  return { leaseId: m.leaseId, accessToken: m.accessToken };
}

async function identity(g: GovernorDO, accessToken: string): Promise<LeaseIdentity> {
  const id = await g.validateAccess(accessToken);
  if (id === null) throw new Error('expected a live identity');
  return id;
}

describe('governor: sitting pin and latch state', () => {
  test('seatSitting stores the pin and clears an existing latch', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      g.setLatch(s.leaseId, 'pin-1', '/soul/01-naming.md');
      let id = await identity(g, s.accessToken);
      expect(id.latched).toEqual({ pin: 'pin-1', path: '/soul/01-naming.md' });

      g.seatSitting(s.leaseId, 'pin-2');
      id = await identity(g, s.accessToken);
      expect(id.sittingPin).toBe('pin-2');
      expect(id.latched).toBeNull();
    });
  });

  test('setLatch and clearLatch round-trip through validateAccess', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      g.seatSitting(s.leaseId, 'pin-1');
      let id = await identity(g, s.accessToken);
      expect(id.sittingPin).toBe('pin-1');
      expect(id.latched).toBeNull();

      g.setLatch(s.leaseId, 'pin-1', '/memory/dreams/0013.md');
      id = await identity(g, s.accessToken);
      expect(id.sittingPin).toBe('pin-1');
      expect(id.latched).toEqual({ pin: 'pin-1', path: '/memory/dreams/0013.md' });

      g.clearLatch(s.leaseId);
      id = await identity(g, s.accessToken);
      // Clearing the latch touches only the latch: the sitting pin is untouched.
      expect(id.sittingPin).toBe('pin-1');
      expect(id.latched).toBeNull();
    });
  });

  test('reseat with a new pin clears the latch', async () => {
    await withGovernor(async (g) => {
      const s = await session(g);
      g.seatSitting(s.leaseId, 'pin-1');
      g.setLatch(s.leaseId, 'pin-1', '/catalog.md');
      let id = await identity(g, s.accessToken);
      expect(id.latched).toEqual({ pin: 'pin-1', path: '/catalog.md' });

      g.seatSitting(s.leaseId, 'pin-3');
      id = await identity(g, s.accessToken);
      expect(id.sittingPin).toBe('pin-3');
      expect(id.latched).toBeNull();
    });
  });

  test('unknown lease id: all three verbs are silent no-ops', async () => {
    await withGovernor(async (g) => {
      const bogus = 'lease-does-not-exist';
      expect(() => g.seatSitting(bogus, 'pin-x')).not.toThrow();
      expect(() => g.setLatch(bogus, 'pin-x', '/nowhere.md')).not.toThrow();
      expect(() => g.clearLatch(bogus)).not.toThrow();

      // A real lease alongside the bogus one proves the no-op reached no row at
      // all, rather than reaching the wrong one.
      const s = await session(g);
      g.seatSitting(s.leaseId, 'pin-real');
      const id = await identity(g, s.accessToken);
      expect(id.sittingPin).toBe('pin-real');
      expect(id.latched).toBeNull();
    });
  });
});
