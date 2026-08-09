// The gate's front door, proven against a scripted governor.
//
// Testing pattern (same seam routing.test.ts uses): wrangler [vars] are
// resolved by workerd and do not propagate through `SELF`, so every authed
// path is proven by calling `worker.fetch(req, env)` directly. Here the env
// also carries a hand-built GOVERNOR stub — the point of these tests is what
// the worker *asks* the governor, and with which identity, not what the DO
// then decides (governor-leases.test.ts owns that half).
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import type { KeyLike } from 'jose';
import worker from '../src/index';
import { scopeAllows } from '../src/lease-auth';
import type { Env } from '../src/env';
import type { LeaseIdentity, LeaseReserveResult } from '../src/governor';

const ISSUER = 'https://soul.test';
const AUDIENCE = 'julian-app';
const BASE = 'https://gate.test';
const INBOX_PATH = '/v0/inboxes/julian-marcus%40agentmail.to';
const OPEN_WINDOW = '2099-01-01T00:00:00.000Z';
const CLOSED_WINDOW = '2020-01-01T00:00:00.000Z';
const LEASE_TOKEN = 'jla_TESTaccesstokenTESTaccesstokenTESTaccess';

/** The exact argument tuple `reserveLease` is called with. */
type ReserveArgs = [string, string, string, string, string, number | null, number | null];

interface Script {
  validateAccess?: (token: string) => LeaseIdentity | null;
  legacyAllowed?: boolean;
  reserveLease?: LeaseReserveResult;
  governorDown?: boolean;
}

interface Calls {
  validateAccess: string[];
  legacyAllowed: number;
  reserveLease: ReserveArgs[];
}

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

function legacyJwt(sub = 'user_marcus'): Promise<string> {
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

function gateEnv(script: Script = {}, overrides: Partial<Env> = {}): { env: Env; calls: Calls } {
  const calls: Calls = { validateAccess: [], legacyAllowed: 0, reserveLease: [] };
  const stub = {
    async validateAccess(token: string): Promise<LeaseIdentity | null> {
      calls.validateAccess.push(token);
      if (script.governorDown) throw new Error('governor down');
      return script.validateAccess ? script.validateAccess(token) : null;
    },
    async legacyAllowed(): Promise<boolean> {
      calls.legacyAllowed++;
      if (script.governorDown) throw new Error('governor down');
      return script.legacyAllowed ?? true;
    },
    async reserveLease(...args: ReserveArgs): Promise<LeaseReserveResult> {
      calls.reserveLease.push(args);
      if (script.governorDown) throw new Error('governor down');
      return script.reserveLease ?? { ok: true, count: 1, cap: 20 };
    },
    async entries(): Promise<unknown[]> { return []; },
  };
  const env = {
    GOVERNOR: { idFromName: () => 'governor-id', get: () => stub },
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_URL: 'https://soul.test/.well-known/jwks.json',
    OIDC_JWKS_JSON: jwks,
    AGENTMAIL_API_KEY: 'test-key-abc',
    AGENTMAIL_INBOX_ID: 'julian-marcus@agentmail.to',
    LEGACY_WINDOW_END: OPEN_WINDOW,
    APPROVER_SUBS: 'user_marcus',
    GATE_CLIENT_ID: 'test-client',
    GATE_REDIRECT_URI: `${BASE}/auth/callback`,
    PUBLIC_URL: BASE,
    SESSION_SECRET: 'test-secret',
    INTROSPECT_SECRET: 'test-secret',
    BREAKGLASS_SECRET: 'test-secret',
    ...overrides,
  } as unknown as Env;
  return { env, calls };
}

function bearer(token: string, path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

function sendBody(): RequestInit {
  return { method: 'POST', body: JSON.stringify({ to: ['mike@example.com'], subject: 'hello', text: 'hi' }) };
}

function interceptSend(): void {
  fetchMock.get('https://api.agentmail.to')
    .intercept({ method: 'POST', path: `${INBOX_PATH}/messages/send` })
    .reply(200, JSON.stringify({ message_id: 'msg_42' }), { headers: { 'content-type': 'application/json' } });
}

const FULL_HOUSE: LeaseIdentity = {
  leaseId: 'lease-1', doorName: 'vm-aurora', scope: 'full-house', principal: 'julian',
};
const READING_ROOM: LeaseIdentity = {
  leaseId: 'lease-2', doorName: 'vm-quiet', scope: 'reading-room', principal: 'julian',
};

describe('lease tokens', () => {
  test('jla_ bearer routes to validateAccess and mail.send reserves under lease identity', async () => {
    const { env, calls } = gateEnv({ validateAccess: () => FULL_HOUSE });
    interceptSend();
    const res = await worker.fetch(bearer(LEASE_TOKEN, '/mail/send', sendBody()), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message_id: 'msg_42' });
    expect(calls.validateAccess).toEqual([LEASE_TOKEN]);
    expect(calls.legacyAllowed).toBe(0);
    expect(calls.reserveLease).toEqual([
      ['lease-1', 'vm-aurora', 'mail', 'send', 'to=mike@example.com subject=hello', 20, 5],
    ]);
  });

  test('no token → 401; jla_ unknown → 401 with renew/re-knock copy', async () => {
    const { env: noneEnv } = gateEnv();
    const none = await worker.fetch(new Request(`${BASE}/mail/messages`), noneEnv);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({
      error: 'no lease token — this door needs a lease; run: bun scripts/door-knock.ts',
    });

    const { env, calls } = gateEnv({ validateAccess: () => null });
    const res = await worker.fetch(bearer(LEASE_TOKEN, '/mail/messages'), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'lease token invalid or expired — renew, or re-knock if revoked',
    });
    expect(calls.reserveLease).toEqual([]);
  });

  test('per-lease 429 body carries refusedBy:"lease"', async () => {
    const { env } = gateEnv({
      validateAccess: () => FULL_HOUSE,
      reserveLease: { ok: false, refusedBy: 'lease', count: 5, cap: 5 },
    });
    const res = await worker.fetch(bearer(LEASE_TOKEN, '/mail/send', sendBody()), env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'cap', refusedBy: 'lease', policy: 'mail.send: 5/day', count: 5, cap: 5,
    });
  });

  test('global 429 still names the house counter', async () => {
    const { env } = gateEnv({
      validateAccess: () => FULL_HOUSE,
      reserveLease: { ok: false, refusedBy: 'global', count: 20, cap: 20 },
    });
    const res = await worker.fetch(bearer(LEASE_TOKEN, '/mail/send', sendBody()), env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'cap', refusedBy: 'global', policy: 'mail.send: 20/day', count: 20, cap: 20,
    });
  });

  test('reading-room lease calling mail.send → 403 naming missing scope, ledgered as refusal', async () => {
    const { env, calls } = gateEnv({ validateAccess: () => READING_ROOM });
    const res = await worker.fetch(bearer(LEASE_TOKEN, '/mail/send', sendBody()), env);

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('reading-room');
    expect(body.error).toContain('mail.send');
    // The refusal is an act: one ledger row under this lease, no quota spent.
    expect(calls.reserveLease).toEqual([
      ['lease-2', 'vm-quiet', 'mail', 'send', 'refused: scope reading-room may not mail.send', 0, 0],
    ]);
  });

  // Gate 2A closes the reading-room/mail bug: reading-room is package-only
  // now, so it may no longer read the mailbox either — this test used to
  // assert the old model (reading-room could still list mail) and is updated
  // to the new invariant, matching the reading-room/mail.send refusal above.
  test('reading-room lease may no longer read the mailbox (package-only invariant)', async () => {
    const { env, calls } = gateEnv({ validateAccess: () => READING_ROOM });
    const res = await worker.fetch(bearer(LEASE_TOKEN, '/mail/messages'), env);

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('reading-room');
    expect(body.error).toContain('mail.list');
    expect(calls.reserveLease).toEqual([
      ['lease-2', 'vm-quiet', 'mail', 'list', 'refused: scope reading-room may not mail.list', 0, 0],
    ]);
  });

  test('governor unreachable → 503, nothing reaches upstream (fail closed)', async () => {
    const { env } = gateEnv({ governorDown: true });
    const res = await worker.fetch(bearer(LEASE_TOKEN, '/mail/send', sendBody()), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'governor unavailable — refusing without a ledger entry' });
  });
});

describe('the legacy window', () => {
  test('valid legacy JWT inside window maps to lease:legacy-window', async () => {
    const { env, calls } = gateEnv();
    interceptSend();
    const res = await worker.fetch(bearer(await legacyJwt(), '/mail/send', sendBody()), env);

    expect(res.status).toBe(200);
    expect(calls.validateAccess).toEqual([]);
    expect(calls.legacyAllowed).toBe(1);
    // doorName comes from the pseudo-lease, never from the JWT's own claims.
    expect(calls.reserveLease).toEqual([
      ['legacy-window', 'legacy-window', 'mail', 'send', 'to=mike@example.com subject=hello', 20, null],
    ]);
  });

  test('legacy JWT after LEGACY_WINDOW_END → 401 naming door-knock', async () => {
    const { env, calls } = gateEnv({}, { LEGACY_WINDOW_END: CLOSED_WINDOW });
    const res = await worker.fetch(bearer(await legacyJwt(), '/mail/messages'), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'the legacy-bearer window has closed — this door needs a lease; run: bun scripts/door-knock.ts',
    });
    expect(calls.reserveLease).toEqual([]);
  });

  test('a missing LEGACY_WINDOW_END closes the window (fail closed)', async () => {
    const { env } = gateEnv({}, { LEGACY_WINDOW_END: undefined as unknown as string });
    const res = await worker.fetch(bearer(await legacyJwt(), '/mail/messages'), env);
    expect(res.status).toBe(401);
  });

  test('legacy JWT with legacyAllowed()=false (revoked pseudo-lease) → 401', async () => {
    const { env, calls } = gateEnv({ legacyAllowed: false });
    const res = await worker.fetch(bearer(await legacyJwt(), '/mail/messages'), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'the legacy-bearer window has closed — this door needs a lease; run: bun scripts/door-knock.ts',
    });
    expect(calls.legacyAllowed).toBe(1);
    expect(calls.reserveLease).toEqual([]);
  });

  test('/health requires a living lease — a revoked legacy window refuses it too', async () => {
    const { env } = gateEnv({ legacyAllowed: false });
    const res = await worker.fetch(bearer(await legacyJwt(), '/health'), env);
    expect(res.status).toBe(401);
  });

  test('a forged bearer that is neither jla_ nor a valid JWT → 401', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(bearer('not-a-jwt', '/mail/messages'), env);
    expect(res.status).toBe(401);
    expect(calls.legacyAllowed).toBe(0);
    expect(calls.reserveLease).toEqual([]);
  });
});

describe('the four faces', () => {
  // The knock (device-flow.test.ts), the approval (approve.test.ts) and now
  // the register (admin.test.ts) are all live and owned by their own suites.
  // What this suite still owns is the *mounting*: which paths sit ahead of
  // the lease gate, and with which identity the gate itself is asked.
  test('device, approval and callback need no bearer to reach them', async () => {
    const { env, calls } = gateEnv();
    // Each face answers on its own terms with no Authorization header at all:
    // the knock refuses the empty form, the desk sends the browser to Pocket
    // ID, the callback refuses a flow it never started. None of them is a
    // 401, and none of them consults the lease gate.
    const cases: Array<[string, RequestInit]> = [
      ['/device', { method: 'POST' }],
      ['/token', { method: 'POST' }],
      ['/approve', { method: 'GET' }],
      ['/auth/callback', { method: 'GET' }],
    ];
    for (const [path, init] of cases) {
      const res = await worker.fetch(new Request(`${BASE}${path}`, init), env);
      expect(res.status, path).not.toBe(401);
    }
    expect(calls.validateAccess).toEqual([]);
    expect(calls.legacyAllowed).toBe(0);
    expect(calls.reserveLease).toEqual([]);
  });

  test('the register answers its own credential check, never the lease gate', async () => {
    const { env, calls } = gateEnv();
    // Without an X-Introspect-Secret or an X-Breakglass-Secret/approver
    // session, the register refuses on its own terms (admin.test.ts owns
    // that copy and those cases) — but it never falls through to the
    // Bearer-token lease gate to do it.
    const cases: Array<[string, RequestInit]> = [
      ['/introspect', { method: 'POST' }],
      ['/leases', { method: 'GET' }],
    ];
    for (const [path, init] of cases) {
      const res = await worker.fetch(new Request(`${BASE}${path}`, init), env);
      expect(res.status, path).toBe(401);
    }
    expect(calls.validateAccess).toEqual([]);
    expect(calls.legacyAllowed).toBe(0);
    expect(calls.reserveLease).toEqual([]);
  });

  test('unknown path behind the gate → 404 for a living lease', async () => {
    const { env } = gateEnv({ validateAccess: () => FULL_HOUSE });
    const res = await worker.fetch(bearer(LEASE_TOKEN, '/mail/delete-everything'), env);
    expect(res.status).toBe(404);
  });
});

describe('scope→verb map (phase 2A)', () => {
  test('reading-room grants package reads only — no mail, no stream', () => {
    expect(scopeAllows('reading-room', 'package', 'list')).toBe(true);
    expect(scopeAllows('reading-room', 'package', 'read')).toBe(true);
    expect(scopeAllows('reading-room', 'mail', 'read')).toBe(false);
    expect(scopeAllows('reading-room', 'mail', 'list')).toBe(false);
    expect(scopeAllows('reading-room', 'mail', 'send')).toBe(false);
    expect(scopeAllows('reading-room', 'stream', 'recent')).toBe(false);
  });
  test('stream-read grants package + stream, never mail', () => {
    expect(scopeAllows('stream-read', 'package', 'read')).toBe(true);
    expect(scopeAllows('stream-read', 'stream', 'recent')).toBe(true);
    expect(scopeAllows('stream-read', 'stream', 'session')).toBe(true);
    expect(scopeAllows('stream-read', 'stream', 'search')).toBe(true);
    expect(scopeAllows('stream-read', 'mail', 'send')).toBe(false);
  });
  test('full-house grants everything including mail and stream', () => {
    expect(scopeAllows('full-house', 'mail', 'send')).toBe(true);
    expect(scopeAllows('full-house', 'stream', 'recent')).toBe(true);
    expect(scopeAllows('full-house', 'package', 'read')).toBe(true);
  });
  test('unknown scope buys nothing', () => {
    expect(scopeAllows('nonsense', 'package', 'read')).toBe(false);
  });
  test('prototype-chain keys buy nothing and never throw (fail closed)', () => {
    expect(scopeAllows('constructor', 'package', 'read')).toBe(false);
    expect(scopeAllows('toString', 'package', 'read')).toBe(false);
    expect(scopeAllows('__proto__', 'package', 'read')).toBe(false);
  });
});
