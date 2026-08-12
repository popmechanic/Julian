// The authcode approval face: the scope-election consent an MCP *visit* walks
// through, distinct from the device-flow desk (which is unchanged and stays
// full-house). Same seam approve.test.ts / authcode.test.ts use: wrangler
// [vars] do not propagate through `SELF`, so `handleApprove(req, env, gov,
// registrar)` is called directly with a hand-built env and scripted
// GOVERNOR/REGISTRAR stubs. The one authority the page may read for the pending
// id is the browser's own `gate_pending` cookie — never a query param — so a
// forged `?pending=…` must be ignored.
import { describe, expect, test } from 'vitest';
import { handleApprove } from '../src/as/approve';
import { PENDING_COOKIE } from '../src/as/authcode';
import { csrfFor, mintSession } from '../src/as/session';
import type { Env } from '../src/env';
import type { GovernorDO, KnockDecision, LeaseScope } from '../src/governor';
import type { RegistrarDO } from '../src/registrar';

const BASE = 'https://gate.test';
const SECRET = 'test-secret';
const APPROVER = 'user_marcus';
const PENDING = 'pending-xyz';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

type PendingView = { client_id: string; origin: string; redirect_uri: string; state: string };
type AttachArgs = [string, string, string];
type DecideArgs = [string, KnockDecision, string, LeaseScope];

interface RegistrarScript { view?: PendingView | null; attach?: boolean; down?: boolean }
interface GovScript { down?: boolean }
interface Calls { pendingView: string[]; attachApproval: AttachArgs[]; knockDecide: DecideArgs[] }

const VIEW: PendingView = {
  client_id: 'client-abc',
  origin: 'https://claude.ai',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  state: 'cli-state-42',
};

function harness(reg: RegistrarScript = {}, gov: GovScript = {}, overrides: Partial<Env> = {}) {
  const calls: Calls = { pendingView: [], attachApproval: [], knockDecide: [] };
  const registrar = {
    async pendingView(id: string): Promise<PendingView | null> {
      calls.pendingView.push(id);
      if (reg.down) throw new Error('registrar down');
      return reg.view === undefined ? VIEW : reg.view;
    },
    async attachApproval(...args: AttachArgs): Promise<boolean> {
      calls.attachApproval.push(args);
      if (reg.down) throw new Error('registrar down');
      return reg.attach ?? true;
    },
  } as unknown as DurableObjectStub<RegistrarDO>;
  const governor = {
    async knockByUserCode(): Promise<null> { return null; },
    async knockDecide(...args: DecideArgs): Promise<boolean> {
      calls.knockDecide.push(args);
      if (gov.down) throw new Error('governor down');
      return true;
    },
  } as unknown as DurableObjectStub<GovernorDO>;
  const env = {
    APPROVER_SUBS: APPROVER,
    SESSION_SECRET: SECRET,
    PUBLIC_URL: BASE,
    OIDC_ISSUER: 'https://soul.test',
    GATE_CLIENT_ID: 'gate-client',
    GATE_REDIRECT_URI: `${BASE}/auth/callback`,
    ...overrides,
  } as unknown as Env;
  return { env, registrar, governor, calls };
}

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** A logged-in approver, with a pending consent cookie already set by /authorize. */
async function consentCookies(pending = PENDING): Promise<{ session: string; header: string }> {
  const session = await mintSession(APPROVER, SECRET);
  return { session, header: cookieHeader({ gate_session: session, [PENDING_COOKIE]: pending }) };
}

function getConsent(env: Env, header: string): Request {
  return new Request(`${BASE}/approve`, { headers: { Cookie: header } });
}

function postConfirm(header: string, fields: Record<string, string>, query = ''): Request {
  return new Request(`${BASE}/approve/confirm${query}`, {
    method: 'POST',
    headers: { ...FORM, Cookie: header },
    body: new URLSearchParams(fields).toString(),
  });
}

// ── the consent page ─────────────────────────────────────────────────────────

describe('the authcode consent page', () => {
  test('renders the decoded origin as primary identity, a NEW ORIGIN banner, and a scope election', async () => {
    const { env, registrar, governor, calls } = harness();
    const { header } = await consentCookies();
    const res = await handleApprove(getConsent(env, header), env, governor, registrar);

    expect(res.status).toBe(200);
    expect(calls.pendingView).toEqual([PENDING]);
    const html = await res.text();
    expect(html).toContain('https://claude.ai');
    expect(html).toContain('NEW ORIGIN');
    // reading-room is pre-selected; stream-read is present but not checked; the
    // house is never offered.
    expect(html).toContain('value="reading-room" checked');
    expect(html).toContain('value="stream-read"');
    expect(html).not.toContain('full-house');
    expect(html).toContain('name="scope"');
  });

  test('the consent page carries the frame-denial headers and a pending-bound CSRF token', async () => {
    const { env, registrar, governor } = harness();
    const { session, header } = await consentCookies();
    const res = await handleApprove(getConsent(env, header), env, governor, registrar);

    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    const html = await res.text();
    expect(html).toContain(`value="${await csrfFor(session, PENDING, SECRET)}"`);
  });

  test('the consent page form-action allows the pending redirect origin (Chrome checks the delivery redirect against it)', async () => {
    const { env, registrar, governor } = harness();
    const { header } = await consentCookies();
    const res = await handleApprove(getConsent(env, header), env, governor, registrar);
    expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self' https://claude.ai");
  });

  test('the bad-election redraw keeps the redirect origin in form-action too', async () => {
    const { env, registrar, governor } = harness();
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'stream-read' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self' https://claude.ai");
  });

  test('a hostile client_id claim is escaped, never rendered as live markup', async () => {
    const hostile: PendingView = { ...VIEW, client_id: '<script>alert(1)</script>' };
    const { env, registrar, governor } = harness({ view: hostile });
    const { header } = await consentCookies();
    const res = await handleApprove(getConsent(env, header), env, governor, registrar);
    const html = await res.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  test('the pending id is read from the cookie, never a query param', async () => {
    const { env, registrar, governor, calls } = harness();
    const { header } = await consentCookies();
    const req = new Request(`${BASE}/approve?pending=FORGED`, { headers: { Cookie: header } });
    await handleApprove(req, env, governor, registrar);
    expect(calls.pendingView).toEqual([PENDING]);
    expect(calls.pendingView).not.toContain('FORGED');
  });

  test('a consent cookie with no living pending is refused and burnt', async () => {
    const { env, registrar, governor, calls } = harness({ view: null });
    const { header } = await consentCookies();
    const res = await handleApprove(getConsent(env, header), env, governor, registrar);
    expect(res.status).toBe(404);
    expect(calls.attachApproval).toEqual([]);
    const cleared = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? (res.headers.get('Set-Cookie') ? [res.headers.get('Set-Cookie') as string] : []);
    expect(cleared.some((c) => c.startsWith(`${PENDING_COOKIE}=;`))).toBe(true);
  });

  test('a consent knock from no session sends the browser to log in first', async () => {
    const { env, registrar, governor } = harness();
    const req = new Request(`${BASE}/approve`, {
      headers: { Cookie: cookieHeader({ [PENDING_COOKIE]: PENDING }) },
    });
    const res = await handleApprove(req, env, governor, registrar);
    expect(res.status).toBe(302); // off to Pocket ID; the pending cookie survives the round-trip
  });

  test('an unreachable registrar refuses the consent page (fail closed)', async () => {
    const { env, registrar, governor } = harness({ down: true });
    const { header } = await consentCookies();
    const res = await handleApprove(getConsent(env, header), env, governor, registrar);
    expect(res.status).toBe(503);
  });
});

// ── the election, on submit ──────────────────────────────────────────────────

describe('the authcode scope election', () => {
  test('an approval acts on the cookie pending id and ignores a forged query param', async () => {
    const { env, registrar, governor, calls } = harness();
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'reading-room' }, '?pending=FORGED'),
      env, governor, registrar,
    );
    expect(res.status).toBe(302);
    expect(calls.attachApproval).toEqual([[PENDING, APPROVER, 'reading-room']]);
  });

  test('an approval delivers the code to the pending\'s own redirect_uri with the echoed state', async () => {
    const { env, registrar, governor } = harness();
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(VIEW.redirect_uri);
    expect(location.searchParams.get('code')).toBe(PENDING);
    expect(location.searchParams.get('state')).toBe('cli-state-42');
    const cleared = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? (res.headers.get('Set-Cookie') ? [res.headers.get('Set-Cookie') as string] : []);
    expect(cleared.some((c) => c.startsWith(`${PENDING_COOKIE}=;`))).toBe(true);
  });

  test('a pending with no client state delivers the code without a state param', async () => {
    const { env, registrar, governor } = harness({ view: { ...VIEW, state: '' } });
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location') ?? '');
    expect(location.searchParams.get('code')).toBe(PENDING);
    expect(location.searchParams.has('state')).toBe(false);
  });

  test('an approval whose pending has vanished before delivery is a 409, not a redirect', async () => {
    const { env, registrar, governor, calls } = harness({ view: null });
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(409);
    expect(res.headers.get('Location')).toBe(null);
    expect(calls.attachApproval).toEqual([]);
  });

  test('electing stream-read without the second confirmation is rejected back to the election screen', async () => {
    const { env, registrar, governor, calls } = harness();
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'stream-read' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(400);
    expect(calls.attachApproval).toEqual([]);
    expect(await res.text()).toContain('name="scope"');
  });

  test('electing stream-read with the second confirmation attaches stream-read', async () => {
    const { env, registrar, governor, calls } = harness();
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'stream-read', stream_confirm: 'yes' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(302);
    expect(calls.attachApproval).toEqual([[PENDING, APPROVER, 'stream-read']]);
  });

  test('a forged full-house scope is not electable and never attaches', async () => {
    const { env, registrar, governor, calls } = harness();
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'full-house' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(400);
    expect(calls.attachApproval).toEqual([]);
  });

  test('a missing scope is rejected back to the election screen — nothing is attached', async () => {
    const { env, registrar, governor, calls } = harness();
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(400);
    expect(calls.attachApproval).toEqual([]);
  });

  test('Refuse sends the client access_denied at its redirect_uri, burns the cookie, and never attaches', async () => {
    const { env, registrar, governor, calls } = harness();
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'refuse', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(VIEW.redirect_uri);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('cli-state-42');
    expect(location.searchParams.has('code')).toBe(false);
    expect(calls.attachApproval).toEqual([]);
    const cleared = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? (res.headers.get('Set-Cookie') ? [res.headers.get('Set-Cookie') as string] : []);
    expect(cleared.some((c) => c.startsWith(`${PENDING_COOKIE}=;`))).toBe(true);
  });

  test('Refuse with the pending already gone is still a clean turn-away, no redirect', async () => {
    const { env, registrar, governor, calls } = harness({ view: null });
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'refuse', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Location')).toBe(null);
    expect(calls.attachApproval).toEqual([]);
  });

  test('a stale CSRF token is refused and never attaches', async () => {
    const { env, registrar, governor, calls } = harness();
    const { header } = await consentCookies();
    const res = await handleApprove(
      postConfirm(header, { csrf: 'not-the-token', decision: 'open', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(403);
    expect(calls.attachApproval).toEqual([]);
  });

  test('a CSRF token bound to a different pending id is refused', async () => {
    const { env, registrar, governor, calls } = harness();
    const { session, header } = await consentCookies();
    const wrong = await csrfFor(session, 'another-pending', SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf: wrong, decision: 'open', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(403);
    expect(calls.attachApproval).toEqual([]);
  });

  test('a submit from no approver session is refused and never attaches', async () => {
    const { env, registrar, governor, calls } = harness();
    const session = await mintSession(APPROVER, SECRET);
    const csrf = await csrfFor(session, PENDING, SECRET);
    // pending cookie present, but no session cookie
    const res = await handleApprove(
      postConfirm(cookieHeader({ [PENDING_COOKIE]: PENDING }), { csrf, decision: 'open', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(403);
    expect(calls.attachApproval).toEqual([]);
  });

  test('a de-listed approver cannot elect, and the registrar is never touched', async () => {
    const { env, registrar, governor, calls } = harness({}, {}, { APPROVER_SUBS: '' });
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(403);
    expect(calls.attachApproval).toEqual([]);
    expect(calls.pendingView).toEqual([]);
  });

  test('attachApproval returning false (pending gone) is reported, not swallowed', async () => {
    const { env, registrar, governor } = harness({ attach: false });
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(409);
  });

  test('an unreachable registrar on submit fails closed', async () => {
    const { env, registrar, governor } = harness({ down: true });
    const { session, header } = await consentCookies();
    const csrf = await csrfFor(session, PENDING, SECRET);
    const res = await handleApprove(
      postConfirm(header, { csrf, decision: 'open', scope: 'reading-room' }),
      env, governor, registrar,
    );
    expect(res.status).toBe(503);
  });
});

// ── the device flow is untouched ─────────────────────────────────────────────

describe('the device-flow desk keeps full-house (regression)', () => {
  test('device-flow confirm (no pending cookie) still defaults to and grants full-house', async () => {
    const { env, registrar, governor, calls } = harness();
    const session = await mintSession(APPROVER, SECRET);
    const csrf = await csrfFor(session, 'WXYZ-BCDF', SECRET);
    const res = await handleApprove(
      postConfirm(cookieHeader({ gate_session: session }), {
        csrf, user_code: 'WXYZ-BCDF', door_name: 'door:aurora-vm', decision: 'open',
      }),
      env, governor, registrar,
    );
    expect(res.status).toBe(200);
    expect(calls.knockDecide).toEqual([['WXYZ-BCDF', 'approved', 'door:aurora-vm', 'full-house']]);
    expect(calls.attachApproval).toEqual([]);
  });
});
