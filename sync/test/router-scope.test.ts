// sync/test/router-scope.test.ts — gate 2A: the router enforces lease
// scope and principal ownership before ever forwarding to the DO stub.
//
// `reading-room` is package-only (identity, not confidentiality) and must
// never reach the stream, at either the /export read or the WS upgrade.
// A lease whose introspected `principal` does not own the requested store
// is refused even when the scope is stream-capable — the private stream
// (`julian/chat`) is bound to one principal and never readable by another.
//
// Testing pattern (matches sync/test/lease-introspect.test.ts): [vars]
// bindings are resolved by workerd, so mutating the `cloudflare:test` `env`
// facade does not propagate through `SELF` — GATE_URL/INTROSPECT_SECRET-
// dependent paths are proven by invoking the worker's default handler
// directly with the mutated env passed explicitly as the argument.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/auth';

const GATE = 'https://gate.test';

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

function testEnv(): Env {
  const e = env as unknown as Env;
  e.GATE_URL = GATE;
  e.INTROSPECT_SECRET = 'test-secret';
  return e;
}

// A refused lease never reaches the DO stub, so those tests can use the real
// binding. An accepted lease forwards to the real DO — swap in a fake stub
// (matches sync/test/lease-introspect.test.ts) so "accepted" tests assert
// only the router's verdict, not the DO's export/upgrade behavior.
function testEnvWithFakeStub(): Env {
  const e = testEnv();
  const fakeStub = { fetch: async (_req: Request) => new Response(null, { status: 200 }) };
  const fakeNamespace = { idFromName: (name: string) => name, get: (_id: string) => fakeStub };
  return Object.assign(Object.create(null), e, { JULIAN_SYNC: fakeNamespace }) as unknown as Env;
}

function stubIntrospect(body: {
  active: boolean; leaseId?: string; scope?: string; principal?: string;
}) {
  fetchMock.get(GATE)
    .intercept({ method: 'POST', path: '/introspect' })
    .reply(200, JSON.stringify(body.active
      ? { active: true, lease_id: body.leaseId, door_name: 'door:x', scope: body.scope, principal: body.principal }
      : { active: false }),
      { headers: { 'content-type': 'application/json' } });
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
    stubIntrospect({ active: true, leaseId: 'L1', scope: 'reading-room', principal: 'julian' });
    const res = await worker.fetch(exportReq('jla_x'), testEnv());
    expect(res.status).toBe(403);
  });

  test('reading-room lease is refused at the WS upgrade', async () => {
    // A distinct token from the export test above: introspectLease caches by
    // token hash for 60s, so reusing a token would skip the fetch here and
    // leave this test's interceptor unconsumed.
    stubIntrospect({ active: true, leaseId: 'L1b', scope: 'reading-room', principal: 'julian' });
    const res = await worker.fetch(wsUpgradeReq('jla_x_ws'), testEnv());
    expect(res.status).toBe(403);
  });

  test('stream-read lease is accepted for export', async () => {
    stubIntrospect({ active: true, leaseId: 'L2', scope: 'stream-read', principal: 'julian' });
    const res = await worker.fetch(exportReq('jla_y'), testEnvWithFakeStub());
    expect(res.status).not.toBe(403);
  });

  test('full-house lease is accepted for export', async () => {
    stubIntrospect({ active: true, leaseId: 'L4', scope: 'full-house', principal: 'julian' });
    const res = await worker.fetch(exportReq('jla_w'), testEnvWithFakeStub());
    expect(res.status).not.toBe(403);
  });

  test('a lease whose principal does not own the store is refused', async () => {
    stubIntrospect({ active: true, leaseId: 'L3', scope: 'stream-read', principal: 'guest-ada' });
    const res = await worker.fetch(exportReq('jla_z'), testEnv()); // store path julian/chat, owner 'julian'
    expect(res.status).toBe(403);
  });

  test('a full-house lease for a different principal is still refused (scope alone is not enough)', async () => {
    stubIntrospect({ active: true, leaseId: 'L5', scope: 'full-house', principal: 'guest-ada' });
    const res = await worker.fetch(exportReq('jla_v'), testEnv());
    expect(res.status).toBe(403);
  });
});
