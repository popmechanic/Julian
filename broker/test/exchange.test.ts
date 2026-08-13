// The browser-facing pair, proven against a scripted governor.
//
// Same seam as lease-auth.test.ts: wrangler [vars] do not propagate through
// `SELF`, so every case calls `worker.fetch(req, env)` directly with a
// hand-built env — a local JWKS via the `OIDC_JWKS_JSON` seam, and a GOVERNOR
// stub that records what the face *asked* for. What the DO then decides is
// governor-exchange.test.ts's and governor-tickets.test.ts's half.
import { beforeAll, describe, expect, test } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import type { KeyLike } from 'jose';
import worker from '../src/index';
import { corsHeadersFor, parseStreamSubs } from '../src/exchange';
import type { Env } from '../src/env';
import type { ExchangeMintResult, LeaseIdentity, MintTicketResult } from '../src/governor';

const ISSUER = 'https://soul.test';
const AUDIENCE = 'julian-app';
const BASE = 'https://gate.test';
const APP = 'https://julian.exe.xyz';
const SECOND_APP = 'http://localhost:8000';
const STRANGER = 'https://evil.example';
const SUB = 'sub-marcus';
const ORIGINS = `${APP},${SECOND_APP}`;
const MAPPED = `${SUB}=julian`;

const MINTED_TOKEN = 'jla_MINTEDaccessMINTEDaccessMINTEDaccessMIN';
const SESSION_TOKEN = 'jla_SESSIONaccessSESSIONaccessSESSIONacces';
/** A device door's access token — a real `jla_`, just not a browser session's. */
const DEVICE_TOKEN = 'jla_DEVICEaccessDEVICEaccessDEVICEaccessDE';
const TICKET = 'jst_TICKETticketTICKETticketTICKETticketTIC';

const REVOKED_COPY =
  'exchange refused: lease revoked — a standing act (reinstate) is required; signing in again will not help';

const OK_MINT: ExchangeMintResult = {
  status: 'ok', leaseId: 'lease-browser', accessToken: MINTED_TOKEN, tokenId: 'tok-1', expiresIn: 3600,
};

/** A browser-session lease: the only flow allowed to mint socket tickets. */
const SESSION_LEASE: LeaseIdentity = {
  leaseId: 'lease-browser', doorName: `browser:${SUB}`, scope: 'stream', principal: 'julian',
  subject: SUB, flow: 'exchange', tokenId: 'tok-1', sittingPin: null, latched: null,
};
/** A device door. Full-house, and still refused a ticket (SEC NEW-13). */
const DEVICE_LEASE: LeaseIdentity = {
  leaseId: 'lease-device', doorName: 'vm-aurora', scope: 'full-house', principal: 'julian',
  subject: null, flow: 'device', tokenId: 'tok-9', sittingPin: null, latched: null,
};

interface Script {
  mint?: ExchangeMintResult;
  mintThrows?: boolean;
  recordAllowedThrows?: boolean;
  validateAccess?: (token: string) => LeaseIdentity | null;
  validateThrows?: boolean;
  ticket?: MintTicketResult;
  ticketThrows?: boolean;
  /** `undefined` leaves the binding in place and successful; `null` deletes it. */
  rateLimit?: boolean | null;
}

interface Calls {
  mintExchangeAccess: Array<[string, string]>;
  recordAllowed: unknown[][];
  reserveLease: unknown[][];
  validateAccess: string[];
  mintTicket: Array<[string, string]>;
  rateLimit: string[];
}

let jwks = '';
let privateKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as KeyLike;
  jwks = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
});

function sessionJwt(sub = SUB, audience = AUDIENCE): Promise<string> {
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER).setAudience(audience).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

function gateEnv(script: Script = {}, overrides: Partial<Env> = {}): { env: Env; calls: Calls } {
  const calls: Calls = {
    mintExchangeAccess: [], recordAllowed: [], reserveLease: [],
    validateAccess: [], mintTicket: [], rateLimit: [],
  };
  const stub = {
    async mintExchangeAccess(sub: string, principal: string): Promise<ExchangeMintResult> {
      calls.mintExchangeAccess.push([sub, principal]);
      if (script.mintThrows) throw new Error('governor down');
      return script.mint ?? OK_MINT;
    },
    async recordAllowed(...args: unknown[]): Promise<void> {
      calls.recordAllowed.push(args);
      if (script.recordAllowedThrows) throw new Error('governor down');
    },
    async reserveLease(...args: unknown[]): Promise<unknown> {
      calls.reserveLease.push(args);
      return { ok: false, refusedBy: 'lease', count: 0, cap: 0 };
    },
    async validateAccess(token: string): Promise<LeaseIdentity | null> {
      calls.validateAccess.push(token);
      if (script.validateThrows) throw new Error('governor down');
      return script.validateAccess ? script.validateAccess(token) : SESSION_LEASE;
    },
    async mintTicket(leaseId: string, tokenId: string): Promise<MintTicketResult> {
      calls.mintTicket.push([leaseId, tokenId]);
      if (script.ticketThrows) throw new Error('governor down');
      return script.ticket ?? { status: 'ok', ticket: TICKET, expiresIn: 60 };
    },
  };
  const env = {
    GOVERNOR: { idFromName: () => 'governor-id', get: () => stub },
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_URL: 'https://soul.test/.well-known/jwks.json',
    OIDC_JWKS_JSON: jwks,
    STREAM_SUBS: MAPPED,
    APP_ORIGINS: ORIGINS,
    LEGACY_WINDOW_END: '2099-01-01T00:00:00.000Z',
    APPROVER_SUBS: SUB,
    PUBLIC_URL: BASE,
    SESSION_SECRET: 'test-secret',
    INTROSPECT_SECRET: 'test-secret',
    BREAKGLASS_SECRET: 'test-secret',
    ...(script.rateLimit === null ? {} : {
      EXCHANGE_RL: {
        async limit({ key }: { key: string }): Promise<{ success: boolean }> {
          calls.rateLimit.push(key);
          return { success: script.rateLimit ?? true };
        },
      },
    }),
    ...overrides,
  } as unknown as Env;
  return { env, calls };
}

function req(path: string, init: RequestInit = {}, origin: string | null = APP): Request {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  if (origin !== null) headers.set('Origin', origin);
  return new Request(`${BASE}${path}`, { method: 'POST', ...init, headers });
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

describe('parseStreamSubs', () => {
  test('unset and empty both yield an empty map and an empty list (fail closed)', () => {
    for (const raw of [undefined, '', '   ', ',,']) {
      const { map, listed } = parseStreamSubs(raw);
      expect([...map.entries()], String(raw)).toEqual([]);
      expect([...listed], String(raw)).toEqual([]);
    }
  });

  test('sub=principal populates both; a bare sub populates the list alone', () => {
    const { map, listed } = parseStreamSubs('a=julian,b,c=');
    expect([...map.entries()]).toEqual([['a', 'julian']]);
    expect([...listed]).toEqual(['a', 'b', 'c']);
  });

  test('surrounding whitespace is not part of a sub or a principal', () => {
    const { map, listed } = parseStreamSubs(' a = julian , b ');
    expect([...map.entries()]).toEqual([['a', 'julian']]);
    expect([...listed]).toEqual(['a', 'b']);
  });

  test('only the first = splits an entry, and a nameless entry is dropped', () => {
    const { map, listed } = parseStreamSubs('a=x=y,=orphan');
    expect([...map.entries()]).toEqual([['a', 'x=y']]);
    expect([...listed]).toEqual(['a']);
  });
});

describe('corsHeadersFor', () => {
  const { env } = gateEnv();

  test('an allowed origin is echoed exactly, alongside Vary: Origin', () => {
    expect(corsHeadersFor(req('/exchange', {}, APP), env)).toEqual({
      'Access-Control-Allow-Origin': APP, Vary: 'Origin',
    });
    expect(corsHeadersFor(req('/exchange', {}, SECOND_APP), env)).toEqual({
      'Access-Control-Allow-Origin': SECOND_APP, Vary: 'Origin',
    });
  });

  test('a stranger, and a request with no Origin at all, get Vary and nothing else', () => {
    expect(corsHeadersFor(req('/exchange', {}, STRANGER), env)).toEqual({ Vary: 'Origin' });
    expect(corsHeadersFor(req('/exchange', {}, null), env)).toEqual({ Vary: 'Origin' });
  });

  test('an empty APP_ORIGINS allows nobody — never a wildcard, never credentials', () => {
    const { env: closed } = gateEnv({}, { APP_ORIGINS: '' });
    expect(corsHeadersFor(req('/exchange', {}, APP), closed)).toEqual({ Vary: 'Origin' });
    // A prefix or suffix of an allowed origin is not that origin.
    expect(corsHeadersFor(req('/exchange', {}, `${APP}.evil.example`), env)).toEqual({ Vary: 'Origin' });
    expect(corsHeadersFor(req('/exchange', {}, `${APP}/`), env)).toEqual({ Vary: 'Origin' });
  });
});

describe('POST /exchange', () => {
  test('a mapped sub is traded for one hour-scale access token — and nothing else', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      access_token: MINTED_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'stream',
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(calls.mintExchangeAccess).toEqual([[SUB, 'julian']]);
    // A verified subject never touches the limiter.
    expect(calls.rateLimit).toEqual([]);
    // The success is penned under the lease the mint just named.
    expect(calls.recordAllowed).toEqual([
      ['lease-browser', `browser:${SUB}`, 'exchange', 'mint', 'token=tok-1'],
    ]);
    expect(calls.reserveLease).toEqual([]);
  });

  test('OPTIONS is a preflight: 204, the full CORS answer, and nothing minted', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(req('/exchange', { method: 'OPTIONS' }), env);

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe(null);
    expect(calls.mintExchangeAccess).toEqual([]);
    expect(calls.rateLimit).toEqual([]);
    expect(calls.recordAllowed).toEqual([]);
  });

  test('a refusal carries the CORS answer too (SEC NEW-17)', async () => {
    const { env } = gateEnv({}, { STREAM_SUBS: '' });
    const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), env);

    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  test('a stranger origin is answered, but never told it may read the answer', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }, STRANGER), env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(null);
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  test('no bearer, and a malformed one, are both a dead session', async () => {
    const { env, calls } = gateEnv();
    for (const headers of [undefined, bearer(''), { Authorization: 'Basic hunter2' }]) {
      const res = await worker.fetch(req('/exchange', headers ? { headers } : {}), env);
      expect(res.status).toBe(401);
      expect((await res.json() as { class: string }).class).toBe('bad-session');
    }
    expect(calls.rateLimit).toEqual([]);
    expect(calls.mintExchangeAccess).toEqual([]);
  });

  test('an unset OIDC_AUDIENCE refuses every exchange (fail closed, 503)', async () => {
    for (const audience of [undefined, '']) {
      const { env, calls } = gateEnv({}, { OIDC_AUDIENCE: audience });
      const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), env);
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string; class: string };
      expect(body.class).toBe('no-audience');
      expect(body.error).toContain('OIDC_AUDIENCE');
      expect(calls.mintExchangeAccess).toEqual([]);
      expect(calls.rateLimit).toEqual([]);
    }
  });

  test('a token minted for another audience is a dead session, not an admitted one', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(
      req('/exchange', { headers: bearer(await sessionJwt(SUB, 'some-other-app')) }), env,
    );
    expect(res.status).toBe(401);
    expect((await res.json() as { class: string }).class).toBe('bad-session');
    expect(calls.mintExchangeAccess).toEqual([]);
  });

  test('an empty STREAM_SUBS admits nobody', async () => {
    const { env, calls } = gateEnv({}, { STREAM_SUBS: '' });
    const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), env);

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; class: string };
    expect(body.class).toBe('not-listed');
    expect(body.error).toContain('STREAM_SUBS');
    expect(calls.mintExchangeAccess).toEqual([]);
    expect(calls.reserveLease).toEqual([]);
  });

  test('a listed sub with no principal is refused, never defaulted to julian (SEC NEW-4)', async () => {
    const { env, calls } = gateEnv({}, { STREAM_SUBS: SUB });
    const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), env);

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; class: string };
    expect(body.class).toBe('unmapped');
    expect(body.error).toContain('sub=principal');
    // Nothing was minted — the count is the point of this test.
    expect(calls.mintExchangeAccess).toEqual([]);
  });

  test('an unlisted sub with a perfectly valid token is refused', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt('sub-stranger')) }), env);
    expect(res.status).toBe(403);
    expect((await res.json() as { class: string }).class).toBe('not-listed');
    expect(calls.mintExchangeAccess).toEqual([]);
  });

  test('the limiter judges failed verifications only — a valid token passes the same stub', async () => {
    const { env, calls } = gateEnv({ rateLimit: false });
    const garbage = await worker.fetch(
      req('/exchange', { headers: { ...bearer('not-a-jwt'), 'CF-Connecting-IP': '203.0.113.9' } }), env,
    );
    expect(garbage.status).toBe(429);
    const body = await garbage.json() as { error: string; class: string };
    expect(body.class).toBe('rate');
    expect(body.error).toContain('wait');
    expect(calls.rateLimit).toEqual(['203.0.113.9']);

    const good = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), env);
    expect(good.status).toBe(200);
    // Still one — the verified exchange never consulted the limiter.
    expect(calls.rateLimit).toEqual(['203.0.113.9']);
  });

  test('a request with no CF-Connecting-IP is counted under one honest bucket', async () => {
    const { env, calls } = gateEnv({ rateLimit: true });
    const res = await worker.fetch(req('/exchange', { headers: bearer('not-a-jwt') }), env);
    expect(res.status).toBe(401);
    expect(calls.rateLimit).toEqual(['unknown']);
  });

  test('a missing EXCHANGE_RL binding refuses nobody (the one deliberate fail-open)', async () => {
    const { env: noRl } = gateEnv({ rateLimit: null });
    const garbage = await worker.fetch(req('/exchange', { headers: bearer('not-a-jwt') }), noRl);
    expect(garbage.status).toBe(401);
    expect((await garbage.json() as { class: string }).class).toBe('bad-session');

    const good = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), noRl);
    expect(good.status).toBe(200);
  });

  test('a revoked session is told the terminal truth, and the refusal is penned', async () => {
    const { env, calls } = gateEnv({ mint: { status: 'revoked' } });
    const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: REVOKED_COPY, class: 'revoked' });
    expect(calls.recordAllowed).toEqual([]);
    expect(calls.reserveLease).toHaveLength(1);
    // The denied pen: zero caps, so the row is written and no quota is spent.
    expect(calls.reserveLease[0][5]).toBe(0);
    expect(calls.reserveLease[0][6]).toBe(0);
    expect(String(calls.reserveLease[0][4])).toContain(`browser:${SUB}`);
  });

  test('at the session cap the exchange refuses rather than evicting a live tab', async () => {
    const { env, calls } = gateEnv({ mint: { status: 'session-cap' } });
    const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), env);

    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; class: string };
    expect(body.class).toBe('session-cap');
    expect(body.error).toContain('close a tab');
    expect(calls.reserveLease).toHaveLength(1);
    expect(calls.recordAllowed).toEqual([]);

    // The tab that already holds a token is untouched: it still mints tickets.
    const still = await worker.fetch(req('/socket-ticket', { headers: bearer(SESSION_TOKEN) }), env);
    expect(still.status).toBe(200);
  });

  test('an unreachable governor refuses the exchange (503) and mints nothing', async () => {
    const { env, calls } = gateEnv({ mintThrows: true });
    const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), env);
    expect(res.status).toBe(503);
    expect((await res.json() as { class: string }).class).toBe('governor');
    expect(calls.recordAllowed).toEqual([]);
  });

  test('a lost ledger row withholds the token — no session without a record of it', async () => {
    const { env, calls } = gateEnv({ recordAllowedThrows: true });
    const res = await worker.fetch(req('/exchange', { headers: bearer(await sessionJwt()) }), env);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(MINTED_TOKEN);
    expect(calls.recordAllowed).toHaveLength(1);
  });

  test('GET is refused with the allowed methods, still CORS-wrapped', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(req('/exchange', { method: 'GET' }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(calls.mintExchangeAccess).toEqual([]);
  });
});

describe('POST /socket-ticket', () => {
  test('a browser session buys one sixty-second ticket', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(req('/socket-ticket', { headers: bearer(SESSION_TOKEN) }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: TICKET, expires_in: 60 });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(calls.validateAccess).toEqual([SESSION_TOKEN]);
    expect(calls.mintTicket).toEqual([['lease-browser', 'tok-1']]);
  });

  test('a full-house device lease keeps its header upgrade and is refused a ticket (SEC NEW-13)', async () => {
    const { env, calls } = gateEnv({ validateAccess: () => DEVICE_LEASE });
    const res = await worker.fetch(req('/socket-ticket', { headers: bearer(DEVICE_TOKEN) }), env);

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; class: string };
    expect(body.class).toBe('not-a-session');
    expect(body.error).toContain('Authorization');
    expect(calls.mintTicket).toEqual([]);
    // A living lease refused an act: one denied-pen row under its own id.
    expect(calls.reserveLease).toHaveLength(1);
    expect(calls.reserveLease[0][0]).toBe('lease-device');
    expect(calls.reserveLease[0][5]).toBe(0);
    expect(calls.reserveLease[0][6]).toBe(0);
  });

  test('a session token with no handle cannot be bound to a ticket', async () => {
    const { env, calls } = gateEnv({
      validateAccess: () => ({ ...SESSION_LEASE, tokenId: null }),
    });
    const res = await worker.fetch(req('/socket-ticket', { headers: bearer(SESSION_TOKEN) }), env);
    expect(res.status).toBe(403);
    expect((await res.json() as { class: string }).class).toBe('not-a-session');
    expect(calls.mintTicket).toEqual([]);
  });

  test('an expired or unknown access token → 401, and the app re-exchanges', async () => {
    const { env, calls } = gateEnv({ validateAccess: () => null });
    const res = await worker.fetch(req('/socket-ticket', { headers: bearer(SESSION_TOKEN) }), env);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toContain('re-exchange');
    expect(calls.mintTicket).toEqual([]);
  });

  test('a Pocket ID JWT is not a ticket credential — it never reaches the register', async () => {
    const { env, calls } = gateEnv();
    for (const token of [await sessionJwt(), '', 'jlr_refreshrefreshrefresh']) {
      const res = await worker.fetch(req('/socket-ticket', { headers: bearer(token) }), env);
      expect(res.status).toBe(401);
    }
    expect(calls.validateAccess).toEqual([]);
    expect(calls.mintTicket).toEqual([]);
  });

  test('the mint cap is retryable, not terminal', async () => {
    const { env, calls } = gateEnv({ ticket: { status: 'cap' } });
    const res = await worker.fetch(req('/socket-ticket', { headers: bearer(SESSION_TOKEN) }), env);

    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; class: string };
    expect(body.class).toBe('rate');
    expect(body.error).toContain('retry');
    expect(calls.reserveLease).toHaveLength(1);
    expect(calls.reserveLease[0][0]).toBe('lease-browser');
  });

  test('OPTIONS preflights and never mints', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(req('/socket-ticket', { method: 'OPTIONS' }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(calls.validateAccess).toEqual([]);
    expect(calls.mintTicket).toEqual([]);
  });

  test('a stranger origin gets no ACAO here either', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(req('/socket-ticket', { headers: bearer(SESSION_TOKEN) }, STRANGER), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(null);
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  test('an unreachable governor refuses (503), on both the check and the mint', async () => {
    const { env: dead } = gateEnv({ validateThrows: true });
    expect((await worker.fetch(req('/socket-ticket', { headers: bearer(SESSION_TOKEN) }), dead)).status).toBe(503);

    const { env: deadMint } = gateEnv({ ticketThrows: true });
    expect((await worker.fetch(req('/socket-ticket', { headers: bearer(SESSION_TOKEN) }), deadMint)).status).toBe(503);
  });

  test('GET is refused with the allowed methods', async () => {
    const { env, calls } = gateEnv();
    const res = await worker.fetch(req('/socket-ticket', { method: 'GET' }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
    expect(calls.validateAccess).toEqual([]);
  });
});

describe('routing: the browser pair sits ahead of the lease gate', () => {
  test('/exchange never accepts a lease token as identity', async () => {
    const { env, calls } = gateEnv({ rateLimit: null });
    const res = await worker.fetch(req('/exchange', { headers: bearer(SESSION_TOKEN) }), env);
    expect(res.status).toBe(401);
    // The exchange face's own refusal shape — not the lease gate's.
    expect((await res.json() as { class: string }).class).toBe('bad-session');
    expect(calls.validateAccess).toEqual([]);
  });

  test('neither face is mounted under /leases/', async () => {
    const { env, calls } = gateEnv();
    for (const path of ['/leases/exchange', '/leases/socket-ticket']) {
      const res = await worker.fetch(req(path, { headers: bearer(await sessionJwt()) }), env);
      expect(res.status, path).not.toBe(200);
    }
    expect(calls.mintExchangeAccess).toEqual([]);
    expect(calls.mintTicket).toEqual([]);
  });
});
