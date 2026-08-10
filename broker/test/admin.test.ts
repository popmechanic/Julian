// The register: `POST /introspect` for julian-sync, `/leases*` for the
// operator's console. Proven the same way the other faces are — a hand-built
// GOVERNOR stub behind `worker.fetch(req, env)` — since wrangler [vars] never
// propagate through `SELF` (same seam lease-auth.test.ts and approve.test.ts
// use).
import { describe, expect, test } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import type { LeaseExport, LeaseIdentity, LeaseSummary } from '../src/governor';
import { mintSession } from '../src/as/session';

const BASE = 'https://gate.test';
const INTROSPECT_SECRET = 'test-introspect-secret';
const BREAKGLASS_SECRET = 'test-breakglass-secret';
const SESSION_SECRET = 'test-session-secret';
const APPROVER = 'user_marcus';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

interface Script {
  validateAccess?: (token: string) => LeaseIdentity | null;
  leaseList?: () => LeaseSummary[];
  leaseRevoke?: (doorNameOrId: string, by: string) => boolean;
  leaseExport?: () => LeaseExport;
  entries?: (limit: number) => unknown[];
  governorDown?: boolean;
}

interface Calls {
  validateAccess: string[];
  leaseRevoke: Array<[string, string]>;
  reserveLease: Array<[string, string, string, string, string, number | null, number | null]>;
}

function gateEnv(script: Script = {}, overrides: Partial<Env> = {}): { env: Env; calls: Calls } {
  const calls: Calls = { validateAccess: [], leaseRevoke: [], reserveLease: [] };
  // Recorded by the fake reserveLease below, read back by the fake entries()
  // unless a test scripts its own — mirrors the real governor's denied pen
  // (reserveLease with zero caps writes one disallowed row).
  const ledgerRows: Array<{ ts: number; sub: string; service: string; verb: string; detail: string; allowed: number }> = [];
  const stub = {
    async validateAccess(token: string): Promise<LeaseIdentity | null> {
      calls.validateAccess.push(token);
      if (script.governorDown) throw new Error('governor down');
      return script.validateAccess ? script.validateAccess(token) : null;
    },
    async leaseList(): Promise<LeaseSummary[]> {
      if (script.governorDown) throw new Error('governor down');
      return script.leaseList ? script.leaseList() : [];
    },
    async leaseRevoke(doorNameOrId: string, by: string): Promise<boolean> {
      calls.leaseRevoke.push([doorNameOrId, by]);
      if (script.governorDown) throw new Error('governor down');
      return script.leaseRevoke ? script.leaseRevoke(doorNameOrId, by) : true;
    },
    async leaseExport(): Promise<LeaseExport> {
      if (script.governorDown) throw new Error('governor down');
      return script.leaseExport ? script.leaseExport() : { leases: [], tokens: [], knocks: [] };
    },
    async legacyAllowed(): Promise<boolean> { return false; },
    async reserveLease(
      leaseId: string, doorName: string, service: string, verb: string, detail: string,
      capPerDay: number | null, leaseCap: number | null,
    ): Promise<{ ok: boolean; count: number; cap: number | null }> {
      calls.reserveLease.push([leaseId, doorName, service, verb, detail, capPerDay, leaseCap]);
      if (script.governorDown) throw new Error('governor down');
      ledgerRows.push({
        ts: Date.now(), sub: `lease:${leaseId}`, service, verb, detail, allowed: 0,
      });
      return { ok: false, count: 0, cap: leaseCap };
    },
    async entries(limit = 50): Promise<unknown[]> {
      if (script.governorDown) throw new Error('governor down');
      return script.entries ? script.entries(limit) : ledgerRows.slice(0, limit);
    },
    async knockCreate(): Promise<never> { throw new Error('not used by admin tests'); },
    async knockByUserCode(): Promise<null> { return null; },
    async knockDecide(): Promise<boolean> { return false; },
    async devicePoll(): Promise<never> { throw new Error('not used by admin tests'); },
    async mintFromRefresh(): Promise<never> { throw new Error('not used by admin tests'); },
    async reserve(): Promise<never> { throw new Error('not used by admin tests'); },
  };
  const env = {
    GOVERNOR: { idFromName: () => 'governor-id', get: () => stub },
    OIDC_ISSUER: 'https://soul.test',
    OIDC_AUDIENCE: 'julian-app',
    OIDC_JWKS_URL: 'https://soul.test/.well-known/jwks.json',
    AGENTMAIL_API_KEY: 'test-key-abc',
    AGENTMAIL_INBOX_ID: 'julian-marcus@agentmail.to',
    LEGACY_WINDOW_END: '2099-01-01T00:00:00.000Z',
    APPROVER_SUBS: APPROVER,
    GATE_CLIENT_ID: 'test-client',
    GATE_REDIRECT_URI: `${BASE}/auth/callback`,
    PUBLIC_URL: BASE,
    SESSION_SECRET,
    INTROSPECT_SECRET,
    BREAKGLASS_SECRET,
    ...overrides,
  } as unknown as Env;
  return { env, calls };
}

function introspectReq(secret: string | null, token: string): Request {
  const headers: Record<string, string> = { ...FORM };
  if (secret !== null) headers['X-Introspect-Secret'] = secret;
  return new Request(`${BASE}/introspect`, {
    method: 'POST', headers, body: new URLSearchParams({ token }).toString(),
  });
}

describe('POST /introspect', () => {
  test('bad secret → 401, no body detail', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(introspectReq('wrong', 'jla_whatever'), env);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(calls.validateAccess).toEqual([]);
  });

  test('missing secret header → 401', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(introspectReq(null, 'jla_whatever'), env);
    expect(res.status).toBe(401);
  });

  test('good secret + unknown token → {active:false}', async () => {
    const { env, calls } = gateEnv({ validateAccess: () => null });
    const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, 'jla_unknown'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
    expect(calls.validateAccess).toEqual(['jla_unknown']);
  });

  test('good secret + non-lease token never reaches validateAccess', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, 'some.jwt.here'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
    expect(calls.validateAccess).toEqual([]);
  });

  test('living lease token → active:true with lease_id/door_name/scope/principal snake_case', async () => {
    const identity: LeaseIdentity = {
      leaseId: 'lease-1', doorName: 'door:aurora', scope: 'full-house', principal: 'julian',
    };
    const { env, calls } = gateEnv({ validateAccess: (token) => (token === 'jla_good' ? identity : null) });
    const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, 'jla_good'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      active: true, lease_id: 'lease-1', door_name: 'door:aurora', scope: 'full-house', principal: 'julian',
    });
    expect(calls.validateAccess).toEqual(['jla_good']);
  });

  test('governor unreachable → 503, fail closed', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, 'jla_good'), env);
    expect(res.status).toBe(503);
  });

  test('wrong method → 405', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/introspect`, { method: 'GET' }), env);
    expect(res.status).toBe(405);
  });
});

describe('/leases* refuses without either credential', () => {
  test('list, revoke and export all 401 with no credential', async () => {
    const { env, calls } = gateEnv();
    const cases: Array<[string, RequestInit]> = [
      ['/leases', { method: 'GET' }],
      ['/leases/revoke', { method: 'POST', headers: FORM, body: new URLSearchParams({ door_name: 'door:x' }).toString() }],
      ['/leases/export', { method: 'GET' }],
    ];
    for (const [path, init] of cases) {
      const res = await worker.fetch(new Request(`${BASE}${path}`, init), env);
      expect(res.status, path).toBe(401);
    }
    expect(calls.leaseRevoke).toEqual([]);
  });

  test('a session for a sub off the approver allowlist is refused, same as no session', async () => {
    const { env } = gateEnv();
    const session = await mintSession('someone-else', SESSION_SECRET);
    const res = await worker.fetch(
      new Request(`${BASE}/leases`, { method: 'GET', headers: { Cookie: `gate_session=${session}` } }), env,
    );
    expect(res.status).toBe(401);
  });

  test('the wrong breakglass secret is refused, not merely ignored', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(
      new Request(`${BASE}/leases`, { method: 'GET', headers: { 'X-Breakglass-Secret': 'wrong' } }), env,
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /leases', () => {
  test('break-glass secret lists the roster', async () => {
    const roster: LeaseSummary[] = [{
      leaseId: 'lease-1', doorName: 'door:aurora', scope: 'full-house',
      status: 'living', born: 1_700_000_000_000, lastRenewal: null, lastVerb: null,
      principal: 'julian', flow: 'device',
    }];
    const { env } = gateEnv({ leaseList: () => roster });
    const res = await worker.fetch(
      new Request(`${BASE}/leases`, { headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET } }), env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ leases: roster });
  });

  test('an approver session lists the roster too', async () => {
    const { env } = gateEnv({ leaseList: () => [] });
    const session = await mintSession(APPROVER, SESSION_SECRET);
    const res = await worker.fetch(
      new Request(`${BASE}/leases`, { headers: { Cookie: `gate_session=${session}` } }), env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ leases: [] });
  });
});

describe('POST /leases/revoke', () => {
  function revokeReq(headers: Record<string, string>, doorName = 'door:aurora'): Request {
    return new Request(`${BASE}/leases/revoke`, {
      method: 'POST', headers: { ...FORM, ...headers },
      body: new URLSearchParams({ door_name: doorName }).toString(),
    });
  }

  test('break-glass revoke works and is ledgered as breakglass', async () => {
    const { env, calls } = gateEnv({ leaseRevoke: () => true });
    const res = await worker.fetch(revokeReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true, doorName: 'door:aurora' });
    expect(calls.leaseRevoke).toEqual([['door:aurora', 'breakglass']]);
  });

  test('approver-session revoke works and is ledgered as approver:<sub>', async () => {
    const { env, calls } = gateEnv({ leaseRevoke: () => true });
    const session = await mintSession(APPROVER, SESSION_SECRET);
    const res = await worker.fetch(revokeReq({ Cookie: `gate_session=${session}` }), env);
    expect(res.status).toBe(200);
    expect(calls.leaseRevoke).toEqual([['door:aurora', `approver:${APPROVER}`]]);
  });

  test('unknown door name → 404, still ledgered as an attempt', async () => {
    const { env, calls } = gateEnv({ leaseRevoke: () => false });
    const res = await worker.fetch(revokeReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }, 'door:nobody'), env);
    expect(res.status).toBe(404);
    expect(calls.leaseRevoke).toEqual([['door:nobody', 'breakglass']]);
  });

  test('missing door_name → 400, governor never consulted', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/leases/revoke`, {
      method: 'POST', headers: { ...FORM, 'X-Breakglass-Secret': BREAKGLASS_SECRET }, body: new URLSearchParams().toString(),
    }), env);
    expect(res.status).toBe(400);
    expect(calls.leaseRevoke).toEqual([]);
  });

  test('governor unreachable → 503, fail closed', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(revokeReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(503);
  });
});

describe('GET /leases/export', () => {
  test('export body never contains jla_ or jlr_ plaintext', async () => {
    const dump: LeaseExport = {
      leases: [{ lease_id: 'lease-1', door_name: 'door:aurora', status: 'living' }],
      tokens: [{ hash: 'a1b2c3', lease_id: 'lease-1', kind: 'access', generation: 1, expires: 1, used: 0 }],
      knocks: [],
    };
    const { env } = gateEnv({ leaseExport: () => dump });
    const res = await worker.fetch(
      new Request(`${BASE}/leases/export`, { headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET } }), env,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/jla_|jlr_/);
    expect(JSON.parse(text)).toEqual(dump);
  });
});

describe('GET /ledger', () => {
  test('without a credential is refused', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/ledger`), env);
    expect(res.status).toBe(401);
  });

  test('the wrong breakglass secret is refused, not merely ignored', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(
      new Request(`${BASE}/ledger`, { headers: { 'X-Breakglass-Secret': 'wrong' } }), env,
    );
    expect(res.status).toBe(401);
  });

  test('break-glass secret returns entries', async () => {
    const entries = [{ ts: 1, sub: 'lease:legacy-window', service: 'mail', verb: 'send', detail: '', allowed: 1 }];
    const { env } = gateEnv({ entries: () => entries });
    const res = await worker.fetch(
      new Request(`${BASE}/ledger`, { headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET } }), env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries });
  });

  test('an approver session returns entries too', async () => {
    const { env } = gateEnv({ entries: () => [] });
    const session = await mintSession(APPROVER, SESSION_SECRET);
    const res = await worker.fetch(
      new Request(`${BASE}/ledger`, { headers: { Cookie: `gate_session=${session}` } }), env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [] });
  });

  test('a session for a sub off the approver allowlist is refused, same as no session', async () => {
    const { env } = gateEnv();
    const session = await mintSession('someone-else', SESSION_SECRET);
    const res = await worker.fetch(
      new Request(`${BASE}/ledger`, { headers: { Cookie: `gate_session=${session}` } }), env,
    );
    expect(res.status).toBe(401);
  });

  test('governor unreachable → 503, fail closed', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(
      new Request(`${BASE}/ledger`, { headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET } }), env,
    );
    expect(res.status).toBe(503);
  });

  test('limit query param is forwarded to the governor', async () => {
    let calledLimit: number | undefined;
    const { env } = gateEnv({ entries: (limit) => { calledLimit = limit; return []; } });
    const res = await worker.fetch(
      new Request(`${BASE}/ledger?limit=5`, { headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET } }), env,
    );
    expect(res.status).toBe(200);
    expect(calledLimit).toBe(5);
  });
});

describe('POST /refusals (sync-side refusal ledger)', () => {
  function refusalReq(body: unknown, secret?: string): Request {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret !== undefined) headers['X-Introspect-Secret'] = secret;
    return new Request(`${BASE}/refusals`, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  const goodBody = {
    lease_id: 'L1', door_name: 'door:x', service: 'stream', verb: 'socket',
    detail: 'refused: scope stream-read may not hold a socket',
  };

  test('without the introspect secret is refused 401', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(refusalReq(goodBody), env);
    expect(res.status).toBe(401);
  });

  test('with a wrong secret is refused 401', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(refusalReq(goodBody, 'wrong'), env);
    expect(res.status).toBe(401);
  });

  test('records a disallowed ledger row and returns 200', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(refusalReq(goodBody, INTROSPECT_SECRET), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    expect(calls.reserveLease).toEqual([['L1', 'door:x', 'stream', 'socket', goodBody.detail, 0, 0]]);

    const ledger = await worker.fetch(
      new Request(`${BASE}/ledger?limit=5`, { headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET } }), env,
    );
    const { entries } = await ledger.json() as { entries: Array<{ sub: string; verb: string; service: string; allowed: number }> };
    const row = entries.find((e) => e.sub === 'lease:L1' && e.verb === 'socket');
    expect(row?.allowed).toBe(0);
    expect(row?.service).toBe('stream');
  });

  test('malformed body is 400, nothing ledgered', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(refusalReq({ lease_id: 42 }, INTROSPECT_SECRET), env);
    expect(res.status).toBe(400);
    expect(calls.reserveLease).toEqual([]);
  });

  test('missing field is 400, nothing ledgered', async () => {
    const { env, calls } = gateEnv();
    const { detail: _detail, ...missingDetail } = goodBody;
    const res = await worker.fetch(refusalReq(missingDetail, INTROSPECT_SECRET), env);
    expect(res.status).toBe(400);
    expect(calls.reserveLease).toEqual([]);
  });

  test('wrong method → 405', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/refusals`, { method: 'GET' }), env);
    expect(res.status).toBe(405);
  });

  test('governor unreachable → 503, fail closed', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(refusalReq(goodBody, INTROSPECT_SECRET), env);
    expect(res.status).toBe(503);
  });
});

describe('mounting', () => {
  test('unknown /leases/* path with a valid credential → 404', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(
      new Request(`${BASE}/leases/nope`, { headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET } }), env,
    );
    expect(res.status).toBe(404);
  });
});
