// The register: `POST /introspect` for julian-sync, `/leases*` for the
// operator's console. Proven the same way the other faces are — a hand-built
// GOVERNOR stub behind `worker.fetch(req, env)` — since wrangler [vars] never
// propagate through `SELF` (same seam lease-auth.test.ts and approve.test.ts
// use).
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { KeyLike } from 'jose';
import worker from '../src/index';
import type { Env } from '../src/env';
import type {
  ConsumeTicketResult, HandleVerdict, LeaseExport, LeaseIdentity, LeaseSummary, ReinstateResult,
} from '../src/governor';
import { mintSession } from '../src/as/session';
import { PIN_KEY } from '../src/package-types';

const BASE = 'https://gate.test';
const INTROSPECT_SECRET = 'test-introspect-secret';
const BREAKGLASS_SECRET = 'test-breakglass-secret';
const SESSION_SECRET = 'test-session-secret';
const APPROVER = 'user_marcus';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

// Pocket ID fixtures — kept after the sunset so the suite can prove that even
// a perfectly valid bearer is nobody at /introspect now.
const ISSUER = 'https://soul.test';
const AUDIENCE = 'julian-app';
const JWKS_URL = 'https://soul.test/.well-known/jwks.json';
const SUB = 'sub-marcus';
const STREAM_SUBS = `${SUB}=julian`;

let jwks = '';
let privateKey: KeyLike;

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as KeyLike;
  jwks = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function sessionJwt(
  { sub = SUB, audience = AUDIENCE, issuer = ISSUER, expiresIn = 3600 }: {
    sub?: string; audience?: string; issuer?: string; expiresIn?: number;
  } = {},
): Promise<string> {
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer).setAudience(audience).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(privateKey);
}

interface Script {
  validateAccess?: (token: string) => LeaseIdentity | null;
  validateByHandle?: (leaseId: string, tokenId: string) => HandleVerdict;
  consumeTicket?: (ticket: string) => ConsumeTicketResult;
  reinstate?: (doorNameOrId: string, by: string, reason: string) => ReinstateResult;
  leaseList?: () => LeaseSummary[];
  leaseRevoke?: (doorNameOrId: string, by: string) => boolean;
  leaseExport?: () => LeaseExport;
  entries?: (limit: number) => unknown[];
  governorDown?: boolean;
}

interface Calls {
  validateAccess: string[];
  validateByHandle: Array<[string, string]>;
  consumeTicket: string[];
  reinstate: Array<[string, string, string]>;
  recordAllowed: Array<[string, string, string, string, string]>;
  leaseRevoke: Array<[string, string]>;
  reserveLease: Array<[string, string, string, string, string, number | null, number | null]>;
}

function gateEnv(script: Script = {}, overrides: Partial<Env> = {}): { env: Env; calls: Calls } {
  const calls: Calls = {
    validateAccess: [], validateByHandle: [], consumeTicket: [],
    reinstate: [], recordAllowed: [], leaseRevoke: [], reserveLease: [],
  };
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
    async validateByHandle(leaseId: string, tokenId: string): Promise<HandleVerdict> {
      calls.validateByHandle.push([leaseId, tokenId]);
      if (script.governorDown) throw new Error('governor down');
      return script.validateByHandle ? script.validateByHandle(leaseId, tokenId) : { status: 'dead' };
    },
    async consumeTicket(ticket: string): Promise<ConsumeTicketResult> {
      calls.consumeTicket.push(ticket);
      if (script.governorDown) throw new Error('governor down');
      return script.consumeTicket ? script.consumeTicket(ticket) : { ok: false, error: 'unknown' };
    },
    async reinstate(doorNameOrId: string, by: string, reason: string): Promise<ReinstateResult> {
      calls.reinstate.push([doorNameOrId, by, reason]);
      if (script.governorDown) throw new Error('governor down');
      return script.reinstate ? script.reinstate(doorNameOrId, by, reason) : { ok: true };
    },
    async recordAllowed(
      leaseId: string, doorName: string, service: string, verb: string, detail: string,
    ): Promise<void> {
      calls.recordAllowed.push([leaseId, doorName, service, verb, detail]);
      if (script.governorDown) throw new Error('governor down');
      ledgerRows.push({
        ts: Date.now(), sub: `lease:${leaseId}`, service, verb, detail, allowed: 1,
      });
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
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_URL: JWKS_URL,
    // The local-JWKS seam: no network in the common case, so a test that wants
    // an *unreachable* key set says so by deleting this and letting
    // disableNetConnect() do the honours.
    OIDC_JWKS_JSON: jwks,
    STREAM_SUBS,
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

function introspectForm(secret: string | null, form: Record<string, string>): Request {
  const headers: Record<string, string> = { ...FORM };
  if (secret !== null) headers['X-Introspect-Secret'] = secret;
  return new Request(`${BASE}/introspect`, {
    method: 'POST', headers, body: new URLSearchParams(form).toString(),
  });
}

function introspectReq(secret: string | null, token: string): Request {
  return introspectForm(secret, { token });
}

/** The access token's own expiry, in the seconds the wire speaks. */
const TOKEN_EXP = 1893456000;

/** A living lease's identity, with the B3 columns filled in. */
function identity(over: Partial<LeaseIdentity> = {}): LeaseIdentity {
  return {
    leaseId: 'lease-1', doorName: 'door:aurora', scope: 'full-house', principal: 'julian',
    subject: null, flow: 'device', tokenId: 'tok-1', sittingPin: null, latched: null,
    exp: TOKEN_EXP,
    ...over,
  };
}

/** The by-handle verdict for a lease that is alive and whose token has not aged out. */
function alive(id: LeaseIdentity): HandleVerdict {
  return { status: 'active', identity: id };
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

  test('good secret + a non-lease token never reaches validateAccess (inactive by shape)', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, 'some.jwt.here'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
    expect(calls.validateAccess).toEqual([]);
  });

  test('a socket ticket is never introspected — it is consumed', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, `jst_${'t'.repeat(43)}`), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
    expect(calls.validateAccess).toEqual([]);
    expect(calls.consumeTicket).toEqual([]);
  });

  test('living lease token → active:true with door_name, subject, flow, token_id and exp', async () => {
    const live = identity({ subject: SUB, flow: 'exchange', doorName: `browser:${SUB}`, scope: 'stream' });
    const { env, calls } = gateEnv({ validateAccess: (token) => (token === 'jla_good' ? live : null) });
    const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, 'jla_good'), env);
    expect(res.status).toBe(200);
    // `exp` is the whole reason a socket can tell an aged token (4004) from a
    // revoked lease (4001): sync carries it into the attachment, so an answer
    // without it silently disarms the distinction.
    expect(await res.json()).toEqual({
      active: true, lease_id: 'lease-1', door_name: `browser:${SUB}`, scope: 'stream',
      principal: 'julian', subject: SUB, flow: 'exchange', token_id: 'tok-1', exp: TOKEN_EXP,
    });
    expect(calls.validateAccess).toEqual(['jla_good']);
  });

  test('a pre-B3 lease answers without inventing a subject or a handle', async () => {
    const old = identity({ subject: null, tokenId: null });
    const { env } = gateEnv({ validateAccess: () => old });
    const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, 'jla_old'), env);
    expect(await res.json()).toEqual({
      active: true, lease_id: 'lease-1', door_name: 'door:aurora', scope: 'full-house',
      principal: 'julian', flow: 'device', exp: TOKEN_EXP,
    });
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

describe('POST /introspect — the JWT arm is gone (the sunset, §6.6 step 6, 2026-08-25)', () => {
  // The strongest probe is the *valid* bearer: correctly signed, right issuer,
  // right audience, sub listed and mapped in STREAM_SUBS, window date in the
  // future — everything that once opened the legacy window. It is nobody now,
  // definitively, with no key fetch and no governor round trip. (Any real
  // fetch would throw under disableNetConnect, and no interceptor is armed.)
  test('a verified, listed Pocket ID bearer is definitively inactive — no JWKS fetch, no register call', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, await sessionJwt()), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
    expect(calls.validateAccess).toEqual([]);
  });

  test('so is every broken variant — the arm is not conditionally closed, it does not exist', async () => {
    const { env } = gateEnv();
    const tokens = [
      await sessionJwt({ audience: 'some-other-app' }),
      await sessionJwt({ issuer: 'https://evil.test' }),
      await sessionJwt({ expiresIn: -7200 }),
      'some.jwt.here',
    ];
    for (const token of tokens) {
      const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, token), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active: false });
    }
  });

  test('a missing OIDC config no longer buys a 503 — a bearer is inactive, not indefinite', async () => {
    // Before the deletion, an unset audience or unreachable JWKS answered 503
    // ("ask again"). There is nothing to ask about any more: the definitive no.
    const { env } = gateEnv({}, { OIDC_AUDIENCE: undefined, OIDC_JWKS_JSON: undefined });
    const res = await worker.fetch(introspectReq(INTROSPECT_SECRET, await sessionJwt()), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
  });

  test('jla_ leases keep working beside the dead arm', async () => {
    const { env } = gateEnv({ validateAccess: () => identity() });
    const jwt = await worker.fetch(introspectReq(INTROSPECT_SECRET, await sessionJwt()), env);
    expect(await jwt.json()).toEqual({ active: false });

    const lease = await worker.fetch(introspectReq(INTROSPECT_SECRET, 'jla_good'), env);
    expect(lease.status).toBe(200);
    expect(await lease.json()).toMatchObject({ active: true, lease_id: 'lease-1' });
  });
});

describe('POST /introspect — by handle (a hibernating socket re-auths)', () => {
  test('a live handle answers with the same identity shape', async () => {
    const live = identity({ leaseId: 'L1', tokenId: 'T1', subject: SUB, flow: 'exchange', scope: 'stream' });
    const { env, calls } = gateEnv({ validateByHandle: () => alive(live) });
    const res = await worker.fetch(
      introspectForm(INTROSPECT_SECRET, { lease_id: 'L1', token_id: 'T1' }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      active: true, lease_id: 'L1', door_name: 'door:aurora', scope: 'stream',
      principal: 'julian', subject: SUB, flow: 'exchange', token_id: 'T1', exp: TOKEN_EXP,
    });
    expect(calls.validateByHandle).toEqual([['L1', 'T1']]);
    expect(calls.validateAccess).toEqual([]);
  });

  test('a dead handle is inactive, and says nothing more than that', async () => {
    const { env } = gateEnv({ validateByHandle: () => ({ status: 'dead' }) });
    const res = await worker.fetch(
      introspectForm(INTROSPECT_SECRET, { lease_id: 'L1', token_id: 'T1' }), env);
    expect(await res.json()).toEqual({ active: false });
  });

  // The one sub-reason on the wire, and the by-handle form is the only place it
  // may appear: a socket told "token-expired" closes 4004 and the browser
  // re-exchanges; a socket told the bare no closes 4001 and the app stops.
  test('an expired token on a living lease answers reason:token-expired', async () => {
    const { env } = gateEnv({ validateByHandle: () => ({ status: 'token-expired' }) });
    const res = await worker.fetch(
      introspectForm(INTROSPECT_SECRET, { lease_id: 'L1', token_id: 'T1' }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false, reason: 'token-expired' });
  });

  test('an exchange lease whose sub left STREAM_SUBS is inactive — the account kill switch (§6.2)', async () => {
    const live = identity({ leaseId: 'L1', tokenId: 'T1', subject: SUB, flow: 'exchange', scope: 'stream' });
    const { env } = gateEnv({ validateByHandle: () => alive(live) }, { STREAM_SUBS: 'someone-else=julian' });
    const res = await worker.fetch(
      introspectForm(INTROSPECT_SECRET, { lease_id: 'L1', token_id: 'T1' }), env);
    // Struck from the map is struck, not merely stale: no `reason`, so the
    // socket closes terminal rather than re-exchanging into the same refusal.
    expect(await res.json()).toEqual({ active: false });
  });

  test('a device lease is not re-judged against STREAM_SUBS', async () => {
    const live = identity({ leaseId: 'L1', tokenId: 'T1' });
    const { env } = gateEnv({ validateByHandle: () => alive(live) }, { STREAM_SUBS: '' });
    const res = await worker.fetch(
      introspectForm(INTROSPECT_SECRET, { lease_id: 'L1', token_id: 'T1' }), env);
    expect(await res.json()).toMatchObject({ active: true, lease_id: 'L1', flow: 'device' });
  });

  test('an unreachable governor is 503, not a revocation', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(
      introspectForm(INTROSPECT_SECRET, { lease_id: 'L1', token_id: 'T1' }), env);
    expect(res.status).toBe(503);
  });

  test('a form with neither token nor a usable handle is inactive, and asks the register nothing', async () => {
    const { env, calls } = gateEnv();
    const forms: Array<Record<string, string>> = [{}, { lease_id: 'L1' }, { token_id: 'T1' }, { token: '' }];
    for (const form of forms) {
      const res = await worker.fetch(introspectForm(INTROSPECT_SECRET, form), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active: false });
    }
    expect(calls.validateByHandle).toEqual([]);
    expect(calls.validateAccess).toEqual([]);
  });
});

describe('POST /introspect — the legacy handle (sub + exp + kind=legacy) is gone with the arm', () => {
  test('a well-formed legacy handle is definitively inactive, and asks the register nothing', async () => {
    const { env, calls } = gateEnv();
    const form = { sub: SUB, exp: String(Math.floor(Date.now() / 1000) + 600), kind: 'legacy' };
    const res = await worker.fetch(introspectForm(INTROSPECT_SECRET, form), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
    expect(calls.validateByHandle).toEqual([]);
    expect(calls.validateAccess).toEqual([]);
  });
});

describe('POST /consume-ticket', () => {
  const TICKET = `jst_${'k'.repeat(43)}`;

  function consumeReq(ticket: string, secret?: string): Request {
    const headers: Record<string, string> = { ...FORM };
    if (secret !== undefined) headers['X-Introspect-Secret'] = secret;
    return new Request(`${BASE}/consume-ticket`, {
      method: 'POST', headers, body: new URLSearchParams({ ticket }).toString(),
    });
  }

  test('without the machine credential is refused, and no ticket is spent', async () => {
    const { env, calls } = gateEnv();
    for (const secret of [undefined, 'wrong']) {
      const res = await worker.fetch(consumeReq(TICKET, secret), env);
      expect(res.status).toBe(401);
    }
    expect(calls.consumeTicket).toEqual([]);
  });

  test('a good ticket returns the whole identity the socket needs, expiry included', async () => {
    const { env, calls } = gateEnv({
      consumeTicket: () => ({
        ok: true, leaseId: 'L1', tokenId: 'T1', subject: SUB,
        scope: 'stream', flow: 'exchange', principal: 'julian', exp: TOKEN_EXP,
      }),
    });
    const res = await worker.fetch(consumeReq(TICKET, INTROSPECT_SECRET), env);
    expect(res.status).toBe(200);
    // The ticket is spent by the time anyone reads this, so everything the
    // socket will ever know has to be in this one body — including when the
    // access token behind it dies, which is what a 4004 is measured against.
    expect(await res.json()).toEqual({
      ok: true, lease_id: 'L1', token_id: 'T1', subject: SUB,
      scope: 'stream', flow: 'exchange', principal: 'julian', exp: TOKEN_EXP,
    });
    expect(calls.consumeTicket).toEqual([TICKET]);
  });

  test('a register that gives no expiry sends none, rather than inventing one', async () => {
    const { env } = gateEnv({
      consumeTicket: () => ({
        ok: true, leaseId: 'L1', tokenId: 'T1', subject: null,
        scope: 'stream', flow: 'exchange', principal: 'julian',
      }),
    });
    const res = await worker.fetch(consumeReq(TICKET, INTROSPECT_SECRET), env);
    expect(await res.json()).toEqual({
      ok: true, lease_id: 'L1', token_id: 'T1', scope: 'stream', flow: 'exchange', principal: 'julian',
    });
  });

  test('the governor verdicts pass through verbatim', async () => {
    for (const error of ['unknown', 'expired', 'reused'] as const) {
      const { env } = gateEnv({ consumeTicket: () => ({ ok: false, error }) });
      const res = await worker.fetch(consumeReq(TICKET, INTROSPECT_SECRET), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, error });
    }
  });

  test('a credential that is not a ticket is unknown, and never spends a governor call', async () => {
    const { env, calls } = gateEnv();
    for (const wrong of ['jla_notaticket', '', 'some.jwt.here']) {
      const res = await worker.fetch(consumeReq(wrong, INTROSPECT_SECRET), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, error: 'unknown' });
    }
    expect(calls.consumeTicket).toEqual([]);
  });

  test('an unreachable governor is 503, never a refused ticket', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(consumeReq(TICKET, INTROSPECT_SECRET), env);
    expect(res.status).toBe(503);
  });

  test('wrong method → 405', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/consume-ticket`, { method: 'GET' }), env);
    expect(res.status).toBe(405);
  });
});

describe('POST /allowed (the positive pen)', () => {
  const goodBody = {
    lease_id: 'L1', door_name: 'browser:sub-marcus', service: 'stream', verb: 'socket',
    detail: 'open token_id=T1',
  };

  function allowedReq(body: unknown, secret?: string): Request {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret !== undefined) headers['X-Introspect-Secret'] = secret;
    return new Request(`${BASE}/allowed`, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  test('without the introspect secret, and with a wrong one, is refused 401', async () => {
    const { env, calls } = gateEnv();
    for (const secret of [undefined, 'wrong']) {
      const res = await worker.fetch(allowedReq(goodBody, secret), env);
      expect(res.status).toBe(401);
    }
    expect(calls.recordAllowed).toEqual([]);
  });

  test('writes one allowed:1 ledger row and spends no quota', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(allowedReq(goodBody, INTROSPECT_SECRET), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    expect(calls.recordAllowed).toEqual([['L1', 'browser:sub-marcus', 'stream', 'socket', 'open token_id=T1']]);
    expect(calls.reserveLease).toEqual([]);

    const ledger = await worker.fetch(
      new Request(`${BASE}/ledger?limit=5`, { headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET } }), env,
    );
    const { entries } = await ledger.json() as { entries: Array<{ sub: string; verb: string; allowed: number }> };
    expect(entries.find((e) => e.sub === 'lease:L1' && e.verb === 'socket')?.allowed).toBe(1);
  });

  test('a missing field is 400, nothing ledgered', async () => {
    const { env, calls } = gateEnv();
    const { detail: _detail, ...missingDetail } = goodBody;
    for (const body of [missingDetail, { lease_id: 42 }, 'not an object']) {
      const res = await worker.fetch(allowedReq(body, INTROSPECT_SECRET), env);
      expect(res.status).toBe(400);
    }
    expect(calls.recordAllowed).toEqual([]);
  });

  test('a door_name the caller does not know is allowed through — the register owns the name', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(allowedReq({ ...goodBody, door_name: '' }, INTROSPECT_SECRET), env);
    expect(res.status).toBe(200);
    expect(calls.recordAllowed).toEqual([['L1', '', 'stream', 'socket', 'open token_id=T1']]);
  });

  test('a lease_id, service or verb that is empty is 400 — a row must name an act', async () => {
    const { env, calls } = gateEnv();
    for (const field of ['lease_id', 'service', 'verb']) {
      const res = await worker.fetch(allowedReq({ ...goodBody, [field]: '' }, INTROSPECT_SECRET), env);
      expect(res.status, field).toBe(400);
    }
    expect(calls.recordAllowed).toEqual([]);
  });

  test('an unreachable governor is 503', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(allowedReq(goodBody, INTROSPECT_SECRET), env);
    expect(res.status).toBe(503);
  });

  test('wrong method → 405', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/allowed`, { method: 'GET' }), env);
    expect(res.status).toBe(405);
  });
});

describe('POST /leases/reinstate', () => {
  function reinstateReq(
    headers: Record<string, string>, form: Record<string, string> = { door_name: `browser:${SUB}`, reason: 'mistake' },
  ): Request {
    return new Request(`${BASE}/leases/reinstate`, {
      method: 'POST', headers: { ...FORM, ...headers },
      body: new URLSearchParams(form).toString(),
    });
  }

  test('no credential → 401, the register untouched', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(reinstateReq({}), env);
    expect(res.status).toBe(401);
    expect(calls.reinstate).toEqual([]);
  });

  test('a lease token is not a register credential', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(reinstateReq({ Authorization: 'Bearer jla_x' }), env);
    expect(res.status).toBe(401);
    expect(calls.reinstate).toEqual([]);
  });

  test('break-glass reinstate works and is ledgered as breakglass, with the reason', async () => {
    const { env, calls } = gateEnv({ reinstate: () => ({ ok: true }) });
    const res = await worker.fetch(reinstateReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reinstated: true });
    expect(calls.reinstate).toEqual([[`browser:${SUB}`, 'breakglass', 'mistake']]);
  });

  test('an approver session reinstates too, under their own name', async () => {
    const { env, calls } = gateEnv({ reinstate: () => ({ ok: true }) });
    const session = await mintSession(APPROVER, SESSION_SECRET);
    const res = await worker.fetch(reinstateReq({ Cookie: `gate_session=${session}` }), env);
    expect(res.status).toBe(200);
    expect(calls.reinstate).toEqual([[`browser:${SUB}`, `approver:${APPROVER}`, 'mistake']]);
  });

  test('an unknown door → 404', async () => {
    const { env } = gateEnv({ reinstate: () => ({ error: 'not-found' }) });
    const res = await worker.fetch(reinstateReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain(`browser:${SUB}`);
  });

  test('a lease that is not revoked → 409, and the copy names the killed-rotation case', async () => {
    const { env } = gateEnv({ reinstate: () => ({ error: 'not-revoked' }) });
    const res = await worker.fetch(reinstateReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(409);
    const { error } = await res.json() as { error: string };
    expect(error).toContain('not revoked');
    expect(error).toContain('killed-rotation');
  });

  test('a lease that is not a browser session → 409', async () => {
    const { env } = gateEnv({ reinstate: () => ({ error: 'not-exchange' }) });
    const res = await worker.fetch(
      reinstateReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }, { door_name: 'vm-aurora', reason: 'please' }), env);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain('knock');
  });

  test('missing door_name → 400, the register never consulted', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(
      reinstateReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }, { reason: 'mistake' }), env);
    expect(res.status).toBe(400);
    expect(calls.reinstate).toEqual([]);
  });

  test('a missing reason is recorded as unstated rather than refused', async () => {
    const { env, calls } = gateEnv({ reinstate: () => ({ ok: true }) });
    const res = await worker.fetch(
      reinstateReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }, { door_name: `browser:${SUB}` }), env);
    expect(res.status).toBe(200);
    expect(calls.reinstate).toEqual([[`browser:${SUB}`, 'breakglass', 'unstated']]);
  });

  test('governor unreachable → 503, fail closed', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(reinstateReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(503);
  });

  test('wrong method → 404, the same as any other unknown register action', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/leases/reinstate`, {
      method: 'GET', headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET },
    }), env);
    expect(res.status).toBe(404);
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
    expect(await res.json()).toEqual({
      leases: roster, approver_subs: [APPROVER], stream_subs: { [SUB]: 'julian' },
    });
  });

  test('an approver session lists the roster too', async () => {
    const { env } = gateEnv({ leaseList: () => [] });
    const session = await mintSession(APPROVER, SESSION_SECRET);
    const res = await worker.fetch(
      new Request(`${BASE}/leases`, { headers: { Cookie: `gate_session=${session}` } }), env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      leases: [], approver_subs: [APPROVER], stream_subs: { [SUB]: 'julian' },
    });
  });

  test('both membership lists are legible in one readout, gaps included (SEC NEW-16)', async () => {
    const { env } = gateEnv({ leaseList: () => [] }, {
      APPROVER_SUBS: ` ${APPROVER}, user_second ,`,
      STREAM_SUBS: `${SUB}=julian, unmapped-sub ,`,
    });
    const res = await worker.fetch(
      new Request(`${BASE}/leases`, { headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET } }), env,
    );
    expect(await res.json()).toEqual({
      leases: [],
      approver_subs: [APPROVER, 'user_second'],
      // A listed-but-unmapped sub shows as an empty principal rather than
      // vanishing: it is exactly the state that earns a 403 `unmapped`.
      stream_subs: { [SUB]: 'julian', 'unmapped-sub': '' },
    });
  });

  test('empty membership vars read as empty lists, never as absent ones', async () => {
    const { env } = gateEnv({ leaseList: () => [] }, { APPROVER_SUBS: '', STREAM_SUBS: '' });
    const res = await worker.fetch(
      new Request(`${BASE}/leases`, { headers: { 'X-Breakglass-Secret': BREAKGLASS_SECRET } }), env,
    );
    // No approver may act with an empty allowlist — break-glass is the only way in.
    expect(await res.json()).toEqual({ leases: [], approver_subs: [], stream_subs: {} });
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

describe('POST /pin-bump', () => {
  const SHA = 'b'.repeat(40);
  const RAW = 'https://raw.test';
  const GITHUB = 'https://api.github.com';
  const COMPARE_PREFIX = '/repos/popmechanic/Julian/compare/main...';

  function pinKv(initial: string | null = null): KVNamespace {
    const map = new Map<string, string>();
    if (initial) map.set(PIN_KEY, initial);
    return {
      async get(key: string) { return map.get(key) ?? null; },
      async put(key: string, value: string) { map.set(key, value); },
    } as unknown as KVNamespace;
  }

  async function sha256Hex(text: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function pinBumpEnv(kv: KVNamespace = pinKv()): { env: Env } {
    const { env } = gateEnv({}, {
      PIN: kv,
      PACKAGE_RAW_BASE: RAW,
      PIN_COMPARE_BASE: `${GITHUB}${COMPARE_PREFIX}`,
    });
    return { env };
  }

  function bumpReq(headers: Record<string, string> = {}, sha = SHA): Request {
    return new Request(`${BASE}/pin-bump`, {
      method: 'POST', headers: { ...FORM, ...headers },
      body: new URLSearchParams({ sha }).toString(),
    });
  }

  function interceptCompare(sha: string, status: string) {
    fetchMock.get(GITHUB).intercept({ path: `${COMPARE_PREFIX}${sha}` }).reply(200, JSON.stringify({ status }));
  }

  function interceptManifest(sha: string, body: string, status = 200) {
    fetchMock.get(RAW).intercept({ path: `/${sha}/package-manifest.json` }).reply(status, body);
  }

  function interceptFile(sha: string, path: string, body: string, status = 200) {
    fetchMock.get(RAW).intercept({ path: `/${sha}/${path}` }).reply(status, body);
  }

  test('a rate-limited compare is a refusal, not a fact about the repo (#42)', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    fetchMock.get(GITHUB).intercept({ path: `${COMPARE_PREFIX}${SHA}` }).reply(403, 'rate limited');
    const res = await worker.fetch(bumpReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('rate limit');
    expect(body.error).not.toContain('unknown to the repo');
    expect(await kv.get(PIN_KEY)).toBeNull(); // pin untouched
  });

  test('only a 404 earns "unknown to the repo" (#42)', async () => {
    const { env } = pinBumpEnv();
    fetchMock.get(GITHUB).intercept({ path: `${COMPARE_PREFIX}${SHA}` }).reply(404, 'not found');
    const res = await worker.fetch(bumpReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(`sha ${SHA} is unknown to the repo`);
  });

  test('any other compare status is named honestly and changes nothing (#42)', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    fetchMock.get(GITHUB).intercept({ path: `${COMPARE_PREFIX}${SHA}` }).reply(500, 'boom');
    const res = await worker.fetch(bumpReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(`GitHub answered 500 proving ${SHA} — pin unchanged`);
    expect(await kv.get(PIN_KEY)).toBeNull();
  });

  test('GITHUB_TOKEN, when present, rides the compare request — and only the compare request (#42)', async () => {
    const { env } = pinBumpEnv();
    (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN = 'ghp_test_token';
    // The compare intercept MATCHES ONLY when the Authorization header is
    // present: without the token on the request, the mock misses and (with
    // net connections disabled) the flow lands in the could-not-reach arm.
    fetchMock.get(GITHUB)
      .intercept({
        path: `${COMPARE_PREFIX}${SHA}`,
        headers: { authorization: 'Bearer ghp_test_token' },
      })
      .reply(200, JSON.stringify({ status: 'behind' }));
    // The raw manifest fetch must NOT carry the token: this intercept matches
    // the un-authed request; a tokened one would miss and fail the fetch arm
    // differently than asserted below.
    interceptManifest(SHA, 'gone', 404);
    const res = await worker.fetch(bumpReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    const body = (await res.json()) as { error: string };
    // Past the compare (no could-not-reach), into the manifest arm.
    expect(body.error).not.toContain('could not reach GitHub');
    expect(res.status).not.toBe(429);
  });

  test('no credential → 401, KV untouched', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    const res = await worker.fetch(bumpReq(), env);
    expect(res.status).toBe(401);
    expect(await kv.get(PIN_KEY)).toBeNull();
  });

  test('a lease token is not a register credential', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    const res = await worker.fetch(bumpReq({ Authorization: 'Bearer jla_x' }), env);
    expect(res.status).toBe(401);
    expect(await kv.get(PIN_KEY)).toBeNull();
  });

  test('a malformed sha is refused before any fetch', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    const res = await worker.fetch(
      bumpReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }, 'nope'), env,
    );
    expect(res.status).toBe(400);
    expect(await kv.get(PIN_KEY)).toBeNull();
    // No interceptors were registered above and fetchMock.disableNetConnect()
    // is in force: a stray fetch would throw and fail this test.
  });

  test('a sha not on the default branch is refused', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    interceptCompare(SHA, 'diverged');
    const res = await worker.fetch(bumpReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(409);
    expect(await kv.get(PIN_KEY)).toBeNull();
  });

  test('verify-fetch failure refuses the bump (push-then-bump race killed)', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    interceptCompare(SHA, 'behind');
    interceptManifest(SHA, 'gone', 404);
    const res = await worker.fetch(bumpReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain(SHA);
    expect(await kv.get(PIN_KEY)).toBeNull();
  });

  test('a spot-check hash mismatch refuses the bump', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    const FILE_TEXT = '# AGENT\nJulian, lent.\n';
    interceptCompare(SHA, 'behind');
    interceptManifest(SHA, JSON.stringify({
      generatedFrom: SHA, generatedAt: '2026-08-12T00:00:00Z',
      files: [{ path: 'AGENT.md', sha256: await sha256Hex(FILE_TEXT), bytes: FILE_TEXT.length }],
    }));
    interceptFile(SHA, 'AGENT.md', `${FILE_TEXT}TAMPERED`);
    const res = await worker.fetch(bumpReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain(SHA);
    expect(await kv.get(PIN_KEY)).toBeNull();
  });

  test('a clean bump verifies then writes the pin', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    const FILE_TEXT = '# AGENT\nJulian, lent.\n';
    interceptCompare(SHA, 'identical');
    interceptManifest(SHA, JSON.stringify({
      generatedFrom: SHA, generatedAt: '2026-08-12T00:00:00Z',
      files: [{ path: 'AGENT.md', sha256: await sha256Hex(FILE_TEXT), bytes: FILE_TEXT.length }],
    }));
    interceptFile(SHA, 'AGENT.md', FILE_TEXT);
    const res = await worker.fetch(bumpReq({ 'X-Breakglass-Secret': BREAKGLASS_SECRET }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pinned: SHA });
    expect(await kv.get(PIN_KEY)).toBe(SHA);
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
