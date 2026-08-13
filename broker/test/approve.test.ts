// The approval: the only door in the gate a human walks through.
//
// Testing pattern (same seam lease-auth.test.ts uses): wrangler [vars] do not
// propagate through `SELF`, so every path is proven by calling
// `worker.fetch(req, env)` directly with a hand-built env whose GOVERNOR is a
// scripted stub. Pocket ID is stood up locally: the ID token is signed with a
// generated key whose JWKS is handed to the worker through `OIDC_JWKS_JSON`,
// and the token exchange is intercepted with `fetchMock` — no network, and the
// verification path under test is the real one.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import type { KeyLike } from 'jose';
import worker from '../src/index';
import type { Env } from '../src/env';
import type { KnockDecision, KnockView, LeaseScope, ReserveResult } from '../src/governor';
import { csrfFor, mintSession } from '../src/as/session';
import { PENDING_COOKIE } from '../src/as/authcode';

const ISSUER = 'https://soul.test';
const BASE = 'https://gate.test';
const CLIENT_ID = 'test-client';
const SECRET = 'test-secret';
const APPROVER = 'user_marcus';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

/** The exact argument tuples the approval face is allowed to send the governor. */
type ReserveArgs = [string, string, string, string, number | null];
type DecideArgs = [string, KnockDecision, string, LeaseScope];

interface Script {
  knock?: KnockView | null;
  reserve?: ReserveResult;
  governorDown?: boolean;
}

interface Calls {
  knockByUserCode: string[];
  knockDecide: DecideArgs[];
  reserve: ReserveArgs[];
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

const KNOCK: KnockView = {
  userCode: 'WXYZ-BCDF',
  clientId: 'aurora-vm',
  host: 'aurora.exe.xyz',
  purpose: 'send mail from the VM door',
  created: 1_754_000_000_000,
};

function gateEnv(script: Script = {}, overrides: Partial<Env> = {}): { env: Env; calls: Calls } {
  const calls: Calls = { knockByUserCode: [], knockDecide: [], reserve: [] };
  const stub = {
    async knockByUserCode(userCode: string): Promise<KnockView | null> {
      calls.knockByUserCode.push(userCode);
      if (script.governorDown) throw new Error('governor down');
      return script.knock ?? null;
    },
    async knockDecide(...args: DecideArgs): Promise<boolean> {
      calls.knockDecide.push(args);
      if (script.governorDown) throw new Error('governor down');
      return true;
    },
    async reserve(...args: ReserveArgs): Promise<ReserveResult> {
      calls.reserve.push(args);
      if (script.governorDown) throw new Error('governor down');
      return script.reserve ?? { ok: true, count: 1, cap: 5 };
    },
  };
  const env = {
    GOVERNOR: { idFromName: () => 'governor-id', get: () => stub },
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: 'julian-app',
    OIDC_JWKS_URL: `${ISSUER}/.well-known/jwks.json`,
    OIDC_JWKS_JSON: jwks,
    AGENTMAIL_API_KEY: 'test-key-abc',
    AGENTMAIL_INBOX_ID: 'julian-marcus@agentmail.to',
    LEGACY_WINDOW_END: '2099-01-01T00:00:00.000Z',
    APPROVER_SUBS: APPROVER,
    GATE_CLIENT_ID: CLIENT_ID,
    GATE_REDIRECT_URI: `${BASE}/auth/callback`,
    PUBLIC_URL: BASE,
    SESSION_SECRET: SECRET,
    INTROSPECT_SECRET: SECRET,
    BREAKGLASS_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
  return { env, calls };
}

// ── small helpers ───────────────────────────────────────────────────────────

function setCookies(res: Response): string[] {
  const all = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (all) return all;
  const single = res.headers.get('Set-Cookie');
  return single ? [single] : [];
}

function cookieNamed(res: Response, name: string): string | null {
  for (const raw of setCookies(res)) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

function b64urlToString(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The flow cookie is signed, not sealed — a browser can read it, and so can this test. */
function flowPayload(value: string): { state: string; nonce: string; verifier: string } {
  return JSON.parse(b64urlToString(value.split('.')[0]));
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function idToken(sub: string, nonce: string, overrides: { aud?: string; iss?: string } = {}): Promise<string> {
  return new SignJWT({ sub, nonce })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);
}

let tokenRequestBody = '';
beforeEach(() => { tokenRequestBody = ''; });

function interceptTokenExchange(token: string | null, status = 200): void {
  fetchMock.get(ISSUER).intercept({ method: 'POST', path: '/api/oidc/token' }).reply((opts: { body?: unknown }) => {
    tokenRequestBody = typeof opts.body === 'string' ? opts.body : String(opts.body ?? '');
    return {
      statusCode: status,
      data: JSON.stringify(token === null ? { error: 'invalid_grant' } : { id_token: token, token_type: 'Bearer' }),
      responseOptions: { headers: { 'content-type': 'application/json' } },
    };
  });
}

/** Walk the login: start it, exchange the code, hand back what the browser now holds. */
async function login(
  env: Env, sub = APPROVER, opts: { aud?: string; iss?: string; nonce?: string } = {},
): Promise<{ start: Response; callback: Response; session: string | null }> {
  const start = await worker.fetch(new Request(`${BASE}/approve`), env);
  const flowCookie = cookieNamed(start, 'gate_flow')!;
  const flow = flowPayload(flowCookie);
  interceptTokenExchange(await idToken(sub, opts.nonce ?? flow.nonce, opts));
  const callback = await worker.fetch(new Request(
    `${BASE}/auth/callback?code=auth-code-1&state=${encodeURIComponent(flow.state)}`,
    { headers: { Cookie: `gate_flow=${flowCookie}` } },
  ), env);
  return { start, callback, session: cookieNamed(callback, 'gate_session') };
}

function sessionCookie(value: string): Record<string, string> {
  return { Cookie: `gate_session=${value}` };
}

function post(path: string, session: string, fields: Record<string, string>): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...FORM, ...sessionCookie(session) },
    body: new URLSearchParams(fields).toString(),
  });
}

// ── the login ───────────────────────────────────────────────────────────────

describe('the approver login', () => {
  test('no session → 302 to the issuer authorize with state, nonce, PKCE S256', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/approve`), env);

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(loc.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(loc.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/callback`);
    expect(loc.searchParams.get('response_type')).toBe('code');
    expect(loc.searchParams.get('scope')).toBe('openid');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');

    const cookie = cookieNamed(res, 'gate_flow')!;
    const raw = setCookies(res).find((c) => c.startsWith('gate_flow='))!;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Path=/');

    const flow = flowPayload(cookie);
    expect(flow.state).toBe(loc.searchParams.get('state'));
    expect(flow.nonce).toBe(loc.searchParams.get('nonce'));
    expect(flow.state).not.toBe(flow.nonce);
    // The challenge is the S256 of the verifier the cookie is carrying — the
    // code alone buys an attacker nothing.
    expect(loc.searchParams.get('code_challenge')).toBe(await s256(flow.verifier));
    expect(loc.searchParams.get('code_challenge')).not.toBe(flow.verifier);
  });

  test('two visits mint different state, nonce and verifier', async () => {
    const { env } = gateEnv();
    const a = flowPayload(cookieNamed(await worker.fetch(new Request(`${BASE}/approve`), env), 'gate_flow')!);
    const b = flowPayload(cookieNamed(await worker.fetch(new Request(`${BASE}/approve`), env), 'gate_flow')!);
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.verifier).not.toBe(b.verifier);
  });

  test('the callback exchanges the code with the PKCE verifier and seats an approver', async () => {
    const { env } = gateEnv();
    const { start, callback, session } = await login(env);

    const flow = flowPayload(cookieNamed(start, 'gate_flow')!);
    const sent = new URLSearchParams(tokenRequestBody);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('auth-code-1');
    expect(sent.get('code_verifier')).toBe(flow.verifier);
    expect(sent.get('redirect_uri')).toBe(`${BASE}/auth/callback`);
    expect(sent.get('client_id')).toBe(CLIENT_ID);

    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get('Location')!).pathname).toBe('/approve');
    expect(session).not.toBeNull();
    const raw = setCookies(callback).find((c) => c.startsWith('gate_session='))!;
    expect(raw).toContain('Secure');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Path=/');
    // The spent flow cookie is cleared on the way out.
    expect(setCookies(callback).some((c) => c.startsWith('gate_flow=;'))).toBe(true);
  });

  test('callback with wrong state → 400; no token exchange, no cookie', async () => {
    const { env } = gateEnv();
    const start = await worker.fetch(new Request(`${BASE}/approve`), env);
    const flowCookie = cookieNamed(start, 'gate_flow')!;
    const res = await worker.fetch(new Request(
      `${BASE}/auth/callback?code=auth-code-1&state=not-the-state`,
      { headers: { Cookie: `gate_flow=${flowCookie}` } },
    ), env);

    expect(res.status).toBe(400);
    expect(cookieNamed(res, 'gate_session')).toBeNull();
    // No interceptor was registered, and none was needed: the exchange never ran.
  });

  test('callback with no flow cookie at all → 400, no cookie', async () => {
    const { env } = gateEnv();
    const res = await worker.fetch(new Request(`${BASE}/auth/callback?code=c&state=s`), env);
    expect(res.status).toBe(400);
    expect(cookieNamed(res, 'gate_session')).toBeNull();
  });

  test('valid exchange but sub not in APPROVER_SUBS → 403 and no cookie', async () => {
    const { env } = gateEnv();
    const { callback, session } = await login(env, 'user_stranger');
    expect(callback.status).toBe(403);
    expect(session).toBeNull();
  });

  test('APPROVER_SUBS unset → 403 for every sub (fail closed)', async () => {
    for (const value of ['', '   ', ',,', undefined]) {
      const { env } = gateEnv({}, { APPROVER_SUBS: value as unknown as string });
      const { callback, session } = await login(env, APPROVER);
      expect(callback.status, JSON.stringify(value)).toBe(403);
      expect(session, JSON.stringify(value)).toBeNull();
    }
  });

  test('APPROVER_SUBS is comma-split and trimmed', async () => {
    const { env } = gateEnv({}, { APPROVER_SUBS: ' user_other , user_marcus ,' });
    const { callback, session } = await login(env, APPROVER);
    expect(callback.status).toBe(302);
    expect(session).not.toBeNull();
  });

  test('an ID token for another audience, or another issuer, or with a stale nonce → no session', async () => {
    for (const opts of [{ aud: 'some-other-client' }, { iss: 'https://evil.test' }, { nonce: 'replayed-nonce' }]) {
      const { env } = gateEnv();
      const { callback, session } = await login(env, APPROVER, opts);
      expect(callback.status, JSON.stringify(opts)).not.toBe(302);
      expect(session, JSON.stringify(opts)).toBeNull();
    }
  });

  test('a failed token exchange never seats a session', async () => {
    const { env } = gateEnv();
    const start = await worker.fetch(new Request(`${BASE}/approve`), env);
    const flowCookie = cookieNamed(start, 'gate_flow')!;
    const flow = flowPayload(flowCookie);
    interceptTokenExchange(null, 400);
    const res = await worker.fetch(new Request(
      `${BASE}/auth/callback?code=bad&state=${encodeURIComponent(flow.state)}`,
      { headers: { Cookie: `gate_flow=${flowCookie}` } },
    ), env);
    expect(res.status).toBe(400);
    expect(cookieNamed(res, 'gate_session')).toBeNull();
  });

  test('a session cookie signed with another secret is no session at all', async () => {
    const { env } = gateEnv();
    const forged = await mintSession(APPROVER, 'not-the-secret');
    const res = await worker.fetch(new Request(`${BASE}/approve`, { headers: sessionCookie(forged) }), env);
    expect(res.status).toBe(302); // back to the login, not into the house
  });
});

// ── the allowlist, at the desk and not only at the door ─────────────────────
//
// The login check alone would let a cookie outlive the trust that minted it:
// sessions last a day, and `APPROVER_SUBS` can be emptied in a second. The
// constraint is that an empty list refuses *approvals*, not merely logins, so
// the list is consulted on every act, and a de-listed browser never reaches
// the governor.

describe('the approver allowlist at the desk', () => {
  const DELISTED = 'no longer on the gate’s approver list';
  /** Every way an operator can shut the desk: emptied, blanked, or the one sub swapped out. */
  const shutOut: Array<string | undefined> = ['', '   ', ',,', undefined, 'user_someone_else'];

  const confirmFields = async (session: string) => ({
    user_code: KNOCK.userCode,
    door_name: 'door:aurora-vm',
    decision: 'open',
    csrf: await csrfFor(session, KNOCK.userCode, SECRET),
  });

  test('code entry from a de-listed session → 403, and the governor is never asked', async () => {
    const session = await mintSession(APPROVER, SECRET);
    for (const value of shutOut) {
      const { env, calls } = gateEnv({ knock: KNOCK }, { APPROVER_SUBS: value as unknown as string });
      const res = await worker.fetch(post('/approve', session, {
        user_code: KNOCK.userCode, csrf: await csrfFor(session, '', SECRET),
      }), env);

      expect(res.status, JSON.stringify(value)).toBe(403);
      expect(await res.text()).toContain(DELISTED);
      expect(calls.knockByUserCode, JSON.stringify(value)).toEqual([]);
      expect(calls.reserve, JSON.stringify(value)).toEqual([]);
    }
  });

  test('confirm from a de-listed session → 403, and knockDecide is never called', async () => {
    const session = await mintSession(APPROVER, SECRET);
    for (const value of shutOut) {
      const { env, calls } = gateEnv({}, { APPROVER_SUBS: value as unknown as string });
      const res = await worker.fetch(post('/approve/confirm', session, await confirmFields(session)), env);

      expect(res.status, JSON.stringify(value)).toBe(403);
      expect(await res.text()).toContain(DELISTED);
      expect(calls.knockDecide, JSON.stringify(value)).toEqual([]);
    }
  });

  test('GET /approve from a de-listed session renders no desk and burns the cookie', async () => {
    const { env } = gateEnv({ knock: KNOCK }, { APPROVER_SUBS: '' });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(new Request(`${BASE}/approve`, { headers: sessionCookie(session) }), env);

    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain(DELISTED);
    expect(html).not.toContain('name="user_code"');
    // The dead session is cleared, not left to be retried for another day.
    expect(setCookies(res).some((c) => c.startsWith('gate_session=;') && c.includes('Max-Age=0'))).toBe(true);
  });

  test('a still-listed approver is untouched by any of this', async () => {
    const { env, calls } = gateEnv({ knock: KNOCK }, { APPROVER_SUBS: ` other , ${APPROVER} ,` });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve', session, {
      user_code: KNOCK.userCode, csrf: await csrfFor(session, '', SECRET),
    }), env);

    expect(res.status).toBe(200);
    expect(calls.knockByUserCode).toEqual([KNOCK.userCode]);
  });
});

// ── the pages ───────────────────────────────────────────────────────────────

describe('the approval pages', () => {
  test('every HTML response denies framing', async () => {
    const { env } = gateEnv({ knock: KNOCK });
    const session = await mintSession(APPROVER, SECRET);
    const entry = await worker.fetch(new Request(`${BASE}/approve`, { headers: sessionCookie(session) }), env);
    const confirmPage = await worker.fetch(post('/approve', session, {
      user_code: KNOCK.userCode, csrf: await csrfFor(session, '', SECRET),
    }), env);

    for (const res of [entry, confirmPage]) {
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Content-Type')).toContain('text/html');
    }
  });

  test('the code-entry page carries a CSRF token bound to the empty code', async () => {
    const { env } = gateEnv();
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(new Request(`${BASE}/approve`, { headers: sessionCookie(session) }), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`value="${await csrfFor(session, '', SECRET)}"`);
    expect(html).toContain('name="user_code"');
  });

  test('the confirm page escapes the door’s claims and separates them from the gate’s own facts', async () => {
    const hostile: KnockView = {
      ...KNOCK,
      clientId: 'aurora-vm',
      purpose: '<script>alert(1)</script>',
      host: '"><img src=x onerror=alert(2)>',
    };
    const { env } = gateEnv({ knock: hostile });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve', session, {
      user_code: KNOCK.userCode, csrf: await csrfFor(session, '', SECRET),
    }), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;');
    // The gate says what the gate knows; the door only ever "claims".
    expect(html).toContain('The door claims:');
    expect(html).toContain('full-house');
    expect(html).toContain(new Date(KNOCK.created).toISOString());
    // An editable name, prefilled from the claimed client_id.
    expect(html).toContain('name="door_name"');
    expect(html).toContain('value="door:aurora-vm"');
    expect(html).toContain(`value="${await csrfFor(session, KNOCK.userCode, SECRET)}"`);
  });

  test('door-name prefill does not double-prefix a client_id that already reads "door:…"', async () => {
    const { env } = gateEnv({ knock: { ...KNOCK, clientId: 'door:julian-new-web' } });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve', session, {
      user_code: KNOCK.userCode, csrf: await csrfFor(session, '', SECRET),
    }), env);
    const html = await res.text();
    expect(html).toContain('value="door:julian-new-web"');
    expect(html).not.toContain('door:door:julian-new-web');
  });

  test('door-name prefill prepends "door:" for a bare client_id', async () => {
    const { env } = gateEnv({ knock: { ...KNOCK, clientId: 'aurora-vm' } });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve', session, {
      user_code: KNOCK.userCode, csrf: await csrfFor(session, '', SECRET),
    }), env);
    const html = await res.text();
    expect(html).toContain('value="door:aurora-vm"');
  });

  test('a claim longer than 120 characters is cut down before it is shown', async () => {
    const { env } = gateEnv({ knock: { ...KNOCK, purpose: 'x'.repeat(500) } });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve', session, {
      user_code: KNOCK.userCode, csrf: await csrfFor(session, '', SECRET),
    }), env);
    const html = await res.text();
    expect(html).toContain('x'.repeat(119));
    expect(html).not.toContain('x'.repeat(121));
  });

  test('code entry without a session is refused and never reaches the governor', async () => {
    const { env, calls } = gateEnv({ knock: KNOCK });
    const res = await worker.fetch(new Request(`${BASE}/approve`, {
      method: 'POST', headers: FORM, body: new URLSearchParams({ user_code: KNOCK.userCode }).toString(),
    }), env);
    expect(res.status).toBe(403);
    expect(calls.knockByUserCode).toEqual([]);
  });

  test('code entry with a stale CSRF token is refused and never reaches the governor', async () => {
    const { env, calls } = gateEnv({ knock: KNOCK });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve', session, {
      user_code: KNOCK.userCode, csrf: 'not-the-token',
    }), env);
    expect(res.status).toBe(403);
    expect(calls.knockByUserCode).toEqual([]);
    expect(calls.reserve).toEqual([]);
  });

  test('a miss is ledgered as one gate.code-attempt under the approver', async () => {
    const { env, calls } = gateEnv({ knock: null });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve', session, {
      user_code: 'ZZZZ-ZZZZ', csrf: await csrfFor(session, '', SECRET),
    }), env);
    expect(res.status).toBe(404);
    expect(calls.knockByUserCode).toEqual(['ZZZZ-ZZZZ']);
    expect(calls.reserve).toEqual([['approve:user_marcus', 'gate', 'code-attempt', 'miss', 5]]);
    // The refusal page still offers a way forward, and never echoes the guess back.
    const html = await res.text();
    expect(html).toContain('name="user_code"');
    expect(html).not.toContain('ZZZZ-ZZZZ');
  });

  test('a hit spends nothing — only misses are counted', async () => {
    const { env, calls } = gateEnv({ knock: KNOCK });
    const session = await mintSession(APPROVER, SECRET);
    await worker.fetch(post('/approve', session, {
      user_code: KNOCK.userCode, csrf: await csrfFor(session, '', SECRET),
    }), env);
    expect(calls.reserve).toEqual([]);
  });

  test('code-entry attempts beyond cap render the wait message', async () => {
    const { env } = gateEnv({ knock: null, reserve: { ok: false, count: 5, cap: 5 } });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve', session, {
      user_code: 'ZZZZ-ZZZZ', csrf: await csrfFor(session, '', SECRET),
    }), env);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('too many attempts, wait 15 minutes');
  });

  test('an unreachable governor refuses the approval face too (fail closed)', async () => {
    const { env } = gateEnv({ governorDown: true });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve', session, {
      user_code: KNOCK.userCode, csrf: await csrfFor(session, '', SECRET),
    }), env);
    expect(res.status).toBe(503);
  });
});

// ── the decision ────────────────────────────────────────────────────────────

describe('the decision', () => {
  const fields = async (session: string, extra: Record<string, string> = {}) => ({
    user_code: KNOCK.userCode,
    door_name: 'door:aurora-vm',
    decision: 'open',
    csrf: await csrfFor(session, KNOCK.userCode, SECRET),
    ...extra,
  });

  test('confirm without CSRF, or with CSRF for a different user_code → 403, knockDecide not called', async () => {
    const session = await mintSession(APPROVER, SECRET);
    const cases: Array<Record<string, string>> = [
      { csrf: '' },
      { csrf: await csrfFor(session, 'BBBB-CCCC', SECRET) },
      { csrf: await csrfFor(session, '', SECRET) },
    ];
    for (const extra of cases) {
      const { env, calls } = gateEnv();
      const res = await worker.fetch(post('/approve/confirm', session, await fields(session, extra)), env);
      expect(res.status, JSON.stringify(extra)).toBe(403);
      expect(calls.knockDecide, JSON.stringify(extra)).toEqual([]);
    }
  });

  test('confirm without a session → 403, knockDecide not called', async () => {
    const { env, calls } = gateEnv();
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(new Request(`${BASE}/approve/confirm`, {
      method: 'POST', headers: FORM, body: new URLSearchParams(await fields(session)).toString(),
    }), env);
    expect(res.status).toBe(403);
    expect(calls.knockDecide).toEqual([]);
  });

  test('confirm with valid session+CSRF calls knockDecide with the edited door_name', async () => {
    const { env, calls } = gateEnv();
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve/confirm', session, await fields(session, {
      door_name: '  aurora-vm  ',
    })), env);

    expect(res.status).toBe(200);
    expect(calls.knockDecide).toEqual([['WXYZ-BCDF', 'approved', 'aurora-vm', 'full-house']]);
  });

  test('Refuse is a decision too, and it is the one that is written', async () => {
    const { env, calls } = gateEnv();
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve/confirm', session, await fields(session, {
      decision: 'refuse',
    })), env);
    expect(res.status).toBe(200);
    expect(calls.knockDecide).toEqual([['WXYZ-BCDF', 'refused', 'door:aurora-vm', 'full-house']]);
  });

  test('an unknown decision, or an empty door name, decides nothing', async () => {
    const session = await mintSession(APPROVER, SECRET);
    const cases: Array<Record<string, string>> = [{ decision: 'maybe' }, { decision: '' }, { door_name: '   ' }];
    for (const extra of cases) {
      const { env, calls } = gateEnv();
      const res = await worker.fetch(post('/approve/confirm', session, await fields(session, extra)), env);
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(calls.knockDecide, JSON.stringify(extra)).toEqual([]);
    }
  });

  test('a decision the governor cannot honour is reported, not swallowed', async () => {
    const { env } = gateEnv({ governorDown: true });
    const session = await mintSession(APPROVER, SECRET);
    const res = await worker.fetch(post('/approve/confirm', session, await fields(session)), env);
    expect(res.status).toBe(503);
  });
});

// ── the session cookie itself ───────────────────────────────────────────────

describe('the session cookie', () => {
  test('round-trips its sub, and refuses a tampered payload', async () => {
    const value = await mintSession('user_marcus', SECRET);
    expect(await readSessionFor(value)).toEqual({ sub: 'user_marcus' });

    const [body, exp, sig] = value.split('.');
    const swapped = `${btoa('user_evil').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${exp}.${sig}`;
    expect(await readSessionFor(swapped)).toBeNull();
    expect(await readSessionFor(`${body}.${Number(exp) + 86_400}.${sig}`)).toBeNull();
    expect(await readSessionFor(`${body}.${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
  });

  test('an empty secret signs nothing and reads nothing (fail closed)', async () => {
    const { readSession } = await import('../src/as/session');
    const value = await mintSession('user_marcus', SECRET);
    expect(await readSession(`gate_session=${value}`, '')).toBeNull();
  });

  test('a CSRF token is bound to both the session and the code', async () => {
    const a = await mintSession('user_marcus', SECRET);
    const b = await mintSession('user_other', SECRET);
    expect(await csrfFor(a, 'WXYZ-BCDF', SECRET)).toBe(await csrfFor(a, 'WXYZ-BCDF', SECRET));
    expect(await csrfFor(a, 'WXYZ-BCDF', SECRET)).not.toBe(await csrfFor(b, 'WXYZ-BCDF', SECRET));
    expect(await csrfFor(a, 'WXYZ-BCDF', SECRET)).not.toBe(await csrfFor(a, 'BBBB-CCCC', SECRET));
    expect(await csrfFor(a, '', SECRET)).not.toBe(await csrfFor(a, '', 'other-secret'));
  });
});

async function readSessionFor(value: string): Promise<{ sub: string } | null> {
  const { readSession } = await import('../src/as/session');
  return readSession(`other=x; gate_session=${value}; trailing=y`, SECRET);
}

// ── RFC 9207: iss on the authcode redirect, advertised at discovery ─────────

describe('RFC 9207 — iss on the authcode redirect, advertised at discovery', () => {
  const PENDING = 'pending-xyz';
  const VIEW = {
    client_id: 'client-abc',
    origin: 'https://claude.ai',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    state: 'cli-state-42',
  };

  function registrarEnv(): Env {
    const registrarStub = {
      async pendingView() { return VIEW; },
      async attachApproval() { return true; },
    };
    const { env } = gateEnv({}, {
      REGISTRAR: { idFromName: () => 'registrar-id', get: () => registrarStub } as unknown as Env['REGISTRAR'],
    });
    return env;
  }

  // Both delivery arms — the code and the refusal — and the discovery
  // document, in one test: `iss` on each redirect must equal `PUBLIC_URL`
  // and be byte-identical to what discovery advertises as `issuer`.
  test('both redirect arms carry iss=PUBLIC_URL, byte-identical to the discovery issuer', async () => {
    const env = registrarEnv();
    const session = await mintSession(APPROVER, SECRET);
    const header = `gate_session=${session}; ${PENDING_COOKIE}=${PENDING}`;
    const csrf = await csrfFor(session, PENDING, SECRET);

    const discoveryRes = await worker.fetch(
      new Request(`${BASE}/.well-known/oauth-authorization-server`), env,
    );
    const discovery = await discoveryRes.json() as {
      issuer: string; authorization_response_iss_parameter_supported: boolean;
    };
    expect(discovery.authorization_response_iss_parameter_supported).toBe(true);
    expect(discovery.issuer).toBe(BASE);

    const opened = await worker.fetch(new Request(`${BASE}/approve/confirm`, {
      method: 'POST',
      headers: { ...FORM, Cookie: header },
      body: new URLSearchParams({ csrf, decision: 'open', scope: 'reading-room' }).toString(),
    }), env);
    expect(opened.status).toBe(302);
    const openedLoc = new URL(opened.headers.get('Location') ?? '');
    expect(openedLoc.searchParams.get('code')).toBe(PENDING);
    expect(openedLoc.searchParams.get('iss')).toBe(BASE);
    expect(openedLoc.searchParams.get('iss')).toBe(discovery.issuer);

    const refused = await worker.fetch(new Request(`${BASE}/approve/confirm`, {
      method: 'POST',
      headers: { ...FORM, Cookie: header },
      body: new URLSearchParams({ csrf, decision: 'refuse', scope: 'reading-room' }).toString(),
    }), env);
    expect(refused.status).toBe(302);
    const refusedLoc = new URL(refused.headers.get('Location') ?? '');
    expect(refusedLoc.searchParams.get('error')).toBe('access_denied');
    expect(refusedLoc.searchParams.get('iss')).toBe(BASE);
    expect(refusedLoc.searchParams.get('iss')).toBe(discovery.issuer);
  });
});
