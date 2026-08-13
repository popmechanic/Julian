// sync/test/router-scope.test.ts — gate 2A: the router enforces lease
// scope and principal ownership before ever forwarding to the DO stub.
//
// `reading-room` is package-only (identity, not confidentiality) and must
// never reach the stream, at either the /export read or the WS upgrade.
// A lease whose introspected `principal` does not own the requested store
// is refused even when the scope is stream-capable — the private stream
// (`julian/chat`) is bound to one principal and never readable by another.
//
// Testing pattern (matches sync/test/lease-introspect.test.ts): wrangler
// [vars]/[[services]] bindings are resolved by workerd, so mutating the
// `cloudflare:test` `env` facade does not propagate through `SELF` — the
// GATE/INTROSPECT_SECRET-dependent paths are proven by invoking the worker's
// default handler directly with the mutated env passed explicitly as the
// argument. Introspection rides the GATE service binding, never a public
// URL (issue #28), so the gate is injected as a fake `GateFetcher` rather
// than intercepted with `fetchMock`.
import { describe, expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index';
import type { Env, GateFetcher } from '../src/auth';
import { SOCKET_REQUIRED_MSG } from 'julian-shared/scopes';

/** A fake GATE binding: counts /introspect calls, records the two pens. */
function fakeGate(body: {
  active: boolean; leaseId?: string; doorName?: string; scope?: string;
  principal?: string; subject?: string; flow?: string;
}): GateFetcher & { calls: number; refusals: unknown[]; allowed: unknown[] } {
  const gate = {
    calls: 0,
    refusals: [] as unknown[],
    allowed: [] as unknown[],
    fetch: async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      const path = new URL(url).pathname;
      if (path === '/refusals' || path === '/allowed') {
        (path === '/refusals' ? gate.refusals : gate.allowed).push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ recorded: true }), { status: 200 });
      }
      gate.calls += 1;
      return new Response(JSON.stringify(body.active
        ? {
            active: true, lease_id: body.leaseId, door_name: body.doorName ?? 'door:x',
            scope: body.scope, principal: body.principal,
            subject: body.subject ?? 'julian', flow: body.flow ?? 'device',
          }
        : { active: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  return gate;
}

function testEnv(gate: GateFetcher): Env {
  const e = env as unknown as Env;
  e.GATE = gate;
  e.INTROSPECT_SECRET = 'test-secret';
  return e;
}

// A refused lease never reaches the DO stub, so those tests can use the real
// binding. An accepted lease forwards to the real DO — swap in a fake stub
// (matches sync/test/lease-introspect.test.ts) so "accepted" tests assert
// only the router's verdict, not the DO's export/upgrade behavior.
function testEnvWithFakeStub(gate: GateFetcher): Env {
  const e = testEnv(gate);
  const fakeStub = { fetch: async (_req: Request) => new Response(null, { status: 200 }) };
  const fakeNamespace = { idFromName: (name: string) => name, get: (_id: string) => fakeStub };
  return Object.assign(Object.create(null), e, { JULIAN_SYNC: fakeNamespace }) as unknown as Env;
}

function exportReq(token: string): Request {
  return new Request('https://sync.test/julian/chat/export', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function wsUpgradeReq(token: string): Request {
  return new Request('https://sync.test/julian/chat', {
    headers: { Authorization: `Bearer ${token}`, Upgrade: 'websocket' },
  });
}

describe('router: lease scope + principal enforcement', () => {
  test('reading-room lease is refused at export (identity-only never reads the stream)', async () => {
    const gate = fakeGate({ active: true, leaseId: 'L1', scope: 'reading-room', principal: 'julian' });
    const res = await worker.fetch(exportReq('jla_x'), testEnv(gate));
    expect(res.status).toBe(403);
    expect(gate.calls).toBe(1);
  });

  test('reading-room lease is refused at the WS upgrade', async () => {
    // A distinct token from the export test above: introspectLease caches by
    // token hash for 60s, so reusing a token would skip the gate call here
    // and prove nothing about this path.
    const gate = fakeGate({ active: true, leaseId: 'L1b', scope: 'reading-room', principal: 'julian' });
    const res = await worker.fetch(wsUpgradeReq('jla_x_ws'), testEnv(gate));
    expect(res.status).toBe(403);
    expect(gate.calls).toBe(1);
  });

  test('stream-read lease is accepted for export', async () => {
    const gate = fakeGate({ active: true, leaseId: 'L2', scope: 'stream-read', principal: 'julian' });
    const res = await worker.fetch(exportReq('jla_y'), testEnvWithFakeStub(gate));
    expect(res.status).not.toBe(403);
    expect(gate.calls).toBe(1);
  });

  test('full-house lease is accepted for export', async () => {
    const gate = fakeGate({ active: true, leaseId: 'L4', scope: 'full-house', principal: 'julian' });
    const res = await worker.fetch(exportReq('jla_w'), testEnvWithFakeStub(gate));
    expect(res.status).not.toBe(403);
    expect(gate.calls).toBe(1);
  });

  test('a lease whose principal does not own the store is refused', async () => {
    const gate = fakeGate({ active: true, leaseId: 'L3', scope: 'stream-read', principal: 'guest-ada' });
    const res = await worker.fetch(exportReq('jla_z'), testEnv(gate)); // store path julian/chat, owner 'julian'
    expect(res.status).toBe(403);
    expect(gate.calls).toBe(1);
  });

  test('a full-house lease for a different principal is still refused (scope alone is not enough)', async () => {
    const gate = fakeGate({ active: true, leaseId: 'L5', scope: 'full-house', principal: 'guest-ada' });
    const res = await worker.fetch(exportReq('jla_v'), testEnv(gate));
    expect(res.status).toBe(403);
    expect(gate.calls).toBe(1);
  });
});

describe('router: a socket is a write surface — socket-capable scopes only', () => {
  test('stream-read is accepted at export', async () => {
    const gate = fakeGate({ active: true, leaseId: 'L10', doorName: 'door:t', scope: 'stream-read', principal: 'julian' });
    const res = await worker.fetch(exportReq('jla_sockpolicy1'), testEnvWithFakeStub(gate));
    expect(res.status).not.toBe(403);
  });

  test('stream-read is refused at the WS upgrade — reads are not a write surface', async () => {
    const gate = fakeGate({ active: true, leaseId: 'L11', doorName: 'door:t', scope: 'stream-read', principal: 'julian' });
    const res = await worker.fetch(wsUpgradeReq('jla_sockpolicy2'), testEnv(gate));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(SOCKET_REQUIRED_MSG);
    expect(gate.refusals).toHaveLength(1);
    expect(gate.refusals[0]).toMatchObject({ lease_id: 'L11', service: 'stream', verb: 'socket' });
  });

  test('full-house is accepted at the WS upgrade', async () => {
    const gate = fakeGate({ active: true, leaseId: 'L12', doorName: 'door:t', scope: 'full-house', principal: 'julian' });
    const res = await worker.fetch(wsUpgradeReq('jla_sockpolicy3'), testEnvWithFakeStub(gate));
    expect(res.status).not.toBe(403);
  });

  test('the `stream` scope is accepted at the WS upgrade and refused at nothing it owns', async () => {
    const gate = fakeGate({ active: true, leaseId: 'L14', doorName: 'browser:s', scope: 'stream', principal: 'julian', flow: 'exchange' });
    const res = await worker.fetch(wsUpgradeReq('jla_sockpolicy5'), testEnvWithFakeStub(gate));
    expect(res.status).not.toBe(403);
    expect(gate.refusals).toHaveLength(0);
  });

  test('a foreign-principal refusal is reported to the gate ledger', async () => {
    const gate = fakeGate({ active: true, leaseId: 'L13', doorName: 'door:t', scope: 'full-house', principal: 'guest-ada' });
    const res = await worker.fetch(exportReq('jla_sockpolicy4'), testEnv(gate));
    expect(res.status).toBe(403);
    expect(gate.refusals[0]).toMatchObject({ lease_id: 'L13', service: 'stream', verb: 'export' });
  });
});

// The legacy Pocket ID JWT is no longer verified here: sync holds no JWKS and
// no issuer/audience config. A JWT is just a token to sync now, handed to the
// gate's /introspect JWT arm like any other — one authority, one window, one
// place the sunset lands (spec §6.5).
describe('router: the legacy JWT arm is the gate, not a local verifier', () => {
  test('an active legacy-window-sync answer admits the socket at scope `stream`', async () => {
    const gate = fakeGate({
      active: true, leaseId: 'legacy-window-sync', doorName: 'legacy-window-sync',
      scope: 'stream', principal: 'julian', subject: 'user_marcus', flow: 'legacy',
    });
    const res = await worker.fetch(wsUpgradeReq('eyJhbGciOi.legacy1.sig'), testEnvWithFakeStub(gate));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(gate.calls).toBe(1);
  });

  test('an inactive answer drops the legacy token — the window has closed', async () => {
    const gate = fakeGate({ active: false });
    const res = await worker.fetch(wsUpgradeReq('eyJhbGciOi.legacy2.sig'), testEnv(gate));
    expect(res.status).toBe(401);
    expect(gate.calls).toBe(1);
  });

  test('a legacy token in the query string reaches the same arm', async () => {
    const gate = fakeGate({
      active: true, leaseId: 'legacy-window-sync', doorName: 'legacy-window-sync',
      scope: 'stream', principal: 'julian', subject: 'user_marcus', flow: 'legacy',
    });
    const res = await worker.fetch(
      new Request('https://sync.test/julian/chat?token=eyJhbGciOi.legacy3.sig', {
        headers: { Upgrade: 'websocket' },
      }),
      testEnvWithFakeStub(gate));
    expect(res.status).toBe(200);
    expect(gate.calls).toBe(1);
  });

  test('a legacy token whose scope cannot read the stream is refused at export', async () => {
    const gate = fakeGate({
      active: true, leaseId: 'legacy-window-sync', doorName: 'legacy-window-sync',
      scope: 'reading-room', principal: 'julian', subject: 'user_marcus', flow: 'legacy',
    });
    const res = await worker.fetch(
      new Request('https://sync.test/julian/chat/export?token=eyJhbGciOi.legacy4.sig'),
      testEnv(gate));
    expect(res.status).toBe(403);
  });
});
