// The approval — the only face of the gate a human ever sees.
//
// Everything else here is machines talking to machines. This is the one place
// where a door's request stops being automatic and waits for Marcus. So the
// page is built around one distinction: what the *gate* knows (the scope being
// asked for, when the knock arrived) is stated plainly; what the *door* says
// about itself is quarantined under "The door claims:", escaped, and cut short.
// A door that names itself with a script tag gets to watch its own name printed
// back at it as text.
//
// Getting here at all takes a Pocket ID login with PKCE, a nonce, and a sub on
// the approver allowlist. An empty or missing `APPROVER_SUBS` refuses everyone:
// there is no auto-approve path, and a misconfigured gate approves nothing. The
// list is consulted at the login *and* at every act of the desk — a cookie is a
// day long, the list is whatever it is right now, and the list wins.
import { decodeJwt } from 'jose';
import { keySetFor, verifyWithKeySet } from '../auth';
import type { Env } from '../env';
import type { GovernorDO, KnockDecision, KnockView } from '../governor';
import type { RegistrarDO } from '../registrar';
import { GOVERNOR_DOWN } from '../lease-auth';
import { PENDING_COOKIE } from './authcode';
import {
  FLOW_COOKIE, FLOW_TTL_SECONDS, SESSION_COOKIE, SESSION_TTL_SECONDS,
  clearCookie, cookieValue, csrfFor, mintSession, mintSigned, randomValue,
  readSession, readSigned, setCookie, timingSafeEqual, toBase64Url,
} from './session';

// Two flows reach this desk, told apart by the browser's cookies. The device
// flow (a `user_code` on a door's screen) still hands out a full-house lease —
// that is unchanged. The authcode flow (an MCP *visit*, carrying a
// `gate_pending` cookie) elects a narrower scope, and the house is not on the
// ballot: `full-house` is never one of the choices here, and the real gate is
// server-side in `GovernorDO.mintAuthcodeLease`.
/** The scope the device flow grants — the pre-selected election of that path. */
const DEVICE_SCOPE = 'full-house';
/** The only scopes an MCP visit may elect. The house is deliberately absent. */
const READING_SCOPE = 'reading-room';
const STREAM_SCOPE = 'stream-read';
const ELECTABLE_SCOPES: readonly string[] = [READING_SCOPE, STREAM_SCOPE];
/** stream-read is the wider of the two — it takes a second, explicit confirmation. */
const STREAM_CONFIRM = 'yes';
/** A door's self-description is testimony, not identity — show enough to judge, no more. */
const CLAIM_MAX = 120;
const DOOR_NAME_MAX = 64;
/** Wrong codes per approver per day. Correct codes cost nothing. */
const CODE_ATTEMPT_CAP = 5;
const SPACE = 32;
const DELETE = 127;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]!));

/** Control characters a door might smuggle in to garble the page it is judged on. */
function flatten(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? SPACE;
    out += code < SPACE || code === DELETE ? ' ' : ch;
  }
  return out;
}

/** Cut a claim down before it is shown; the ellipsis keeps the whole cell at 120. */
function claim(value: string): string {
  const flat = flatten(value);
  return flat.length > CLAIM_MAX ? `${flat.slice(0, CLAIM_MAX - 1)}…` : flat;
}

/**
 * The prefilled door name. Doors are documented as knocking with client_id
 * values that already read "door:whatever" (see door-knock.ts), so blindly
 * prepending "door:" here produced "door:door:whatever". Use the client_id
 * verbatim when it already carries the prefix; prepend it otherwise.
 */
function defaultDoorName(clientId: string): string {
  return clientId.startsWith('door:') ? clientId : `door:${clientId}`;
}

function issuerOf(env: Env): string {
  return (env.OIDC_ISSUER ?? '').replace(/\/+$/, '');
}

interface FlowState { state: string; nonce: string; verifier: string }

// ── the page ────────────────────────────────────────────────────────────────

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 2.5rem 1.25rem; font: 16px/1.6 ui-serif, Georgia, serif;
       background: #faf8f4; color: #1c1a17; }
@media (prefers-color-scheme: dark) { body { background: #16151a; color: #e8e4dc; } }
main { max-width: 34rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 1.5rem; font-weight: 600; letter-spacing: -0.01em; }
h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.65;
     margin: 2rem 0 0.6rem; font-weight: 600; }
dl { display: grid; grid-template-columns: 8rem 1fr; gap: 0.4rem 1rem; margin: 0; }
dt { opacity: 0.6; font-size: 0.9rem; }
dd { margin: 0; overflow-wrap: anywhere; }
.claims { border-left: 3px solid rgba(180,120,60,0.6); padding-left: 1rem; }
label { display: block; margin: 1.6rem 0 0.4rem; font-size: 0.9rem; opacity: 0.7; }
input { font: inherit; padding: 0.55rem 0.7rem; width: 100%; box-sizing: border-box;
        border: 1px solid rgba(128,128,128,0.45); border-radius: 5px;
        background: transparent; color: inherit; }
.row { display: flex; gap: 0.75rem; margin-top: 1.75rem; }
button { font: inherit; padding: 0.6rem 1.4rem; border-radius: 5px; cursor: pointer;
         border: 1px solid rgba(128,128,128,0.45); background: transparent; color: inherit; }
button.open { border-color: #1c1a17; background: #1c1a17; color: #faf8f4; }
@media (prefers-color-scheme: dark) {
  button.open { border-color: #e8e4dc; background: #e8e4dc; color: #16151a; }
}
p.note { opacity: 0.75; }
.origin { font-size: 1.15rem; font-weight: 600; overflow-wrap: anywhere; }
.banner { display: inline-block; margin: 0 0 0.75rem; padding: 0.2rem 0.6rem; border-radius: 4px;
          font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700;
          background: rgba(180,120,60,0.18); border: 1px solid rgba(180,120,60,0.6); }
fieldset { border: 1px solid rgba(128,128,128,0.35); border-radius: 6px; margin: 1.2rem 0 0; padding: 0.6rem 1rem; }
legend { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.65; }
label.choice { display: flex; align-items: baseline; gap: 0.5rem; margin: 0.5rem 0; opacity: 1; }
label.choice input { width: auto; }
`.replace(/\s+/g, ' ');

function page(title: string, body: string, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${esc(title)}</title><style>${STYLE}</style></head>`
    + `<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers });
}

function notice(title: string, message: string, status: number, cookies: string[] = []): Response {
  return page(title, `<p class="note">${esc(message)}</p>`, status, cookies);
}

function codeEntryForm(csrf: string, lead: string): string {
  return `<p class="note">${esc(lead)}</p>`
    + '<form method="post" action="/approve">'
    + `<input type="hidden" name="csrf" value="${esc(csrf)}">`
    + '<label for="user_code">The code the door is showing</label>'
    + '<input id="user_code" name="user_code" autocomplete="off" autocapitalize="characters"'
    + ' spellcheck="false" placeholder="XXXX-XXXX">'
    + '<div class="row"><button class="open" type="submit">Look it up</button></div>'
    + '</form>';
}

function confirmForm(knock: KnockView, csrf: string): string {
  const claims: Array<[string, string]> = [
    ['client_id', knock.clientId],
    ['host', knock.host],
    ['purpose', knock.purpose],
  ];
  return '<h2>The gate knows</h2>'
    + '<dl>'
    + `<dt>code</dt><dd>${esc(knock.userCode)}</dd>`
    + `<dt>knocked at</dt><dd>${esc(new Date(knock.created).toISOString())}</dd>`
    + `<dt>scope asked</dt><dd>${esc(DEVICE_SCOPE)}</dd>`
    + '</dl>'
    + '<h2>The door claims:</h2>'
    + '<dl class="claims">'
    + claims.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(claim(v))}</dd>`).join('')
    + '</dl>'
    + '<form method="post" action="/approve/confirm">'
    + `<input type="hidden" name="csrf" value="${esc(csrf)}">`
    + `<input type="hidden" name="user_code" value="${esc(knock.userCode)}">`
    + '<label for="door_name">Name this door (yours to choose, not the door’s)</label>'
    + `<input id="door_name" name="door_name" maxlength="${DOOR_NAME_MAX}" autocomplete="off"`
    + ` spellcheck="false" value="${esc(claim(defaultDoorName(knock.clientId)))}">`
    + '<div class="row">'
    + '<button class="open" type="submit" name="decision" value="open">Open</button>'
    + '<button type="submit" name="decision" value="refuse">Refuse</button>'
    + '</div></form>';
}

/**
 * The MCP visit's consent page. The decoded origin is the primary identity a
 * homograph attack cannot hide behind — it is stated plainly and, until a visit
 * has been seen before, flagged NEW ORIGIN. What the client says about *itself*
 * (its id, its redirect) stays quarantined under "claims", escaped and clipped,
 * exactly as a door's testimony is. The election offers only the two narrow
 * scopes; `stream-read`, the wider one, is gated behind a second confirmation.
 * The pending id is never put in the form — it rides the HttpOnly cookie, and
 * the CSRF token below is bound to it server-side.
 */
function consentForm(
  view: { client_id: string; origin: string; redirect_uri: string },
  csrf: string, newOrigin: boolean, message?: string,
): string {
  const claims: Array<[string, string]> = [
    ['client_id', view.client_id],
    ['redirect_uri', view.redirect_uri],
  ];
  return '<h2>The gate knows</h2>'
    + (newOrigin ? '<div class="banner">NEW ORIGIN</div>' : '')
    + `<p class="origin">${esc(view.origin)}</p>`
    + '<h2>The visit claims:</h2>'
    + '<dl class="claims">'
    + claims.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(claim(v))}</dd>`).join('')
    + '</dl>'
    + (message ? `<p class="note">${esc(message)}</p>` : '')
    + '<form method="post" action="/approve/confirm">'
    + `<input type="hidden" name="csrf" value="${esc(csrf)}">`
    + '<fieldset><legend>Scope</legend>'
    + `<label class="choice"><input type="radio" name="scope" value="${READING_SCOPE}" checked> ${READING_SCOPE}</label>`
    + `<label class="choice"><input type="radio" name="scope" value="${STREAM_SCOPE}"> ${STREAM_SCOPE}</label>`
    + '</fieldset>'
    + `<label class="choice"><input type="checkbox" name="stream_confirm" value="${STREAM_CONFIRM}">`
    + ` I confirm granting ${STREAM_SCOPE} (required only for ${STREAM_SCOPE})</label>`
    + '<div class="row">'
    + '<button class="open" type="submit" name="decision" value="open">Open</button>'
    + '<button type="submit" name="decision" value="refuse">Refuse</button>'
    + '</div></form>';
}

// ── the login ───────────────────────────────────────────────────────────────

async function startLogin(env: Env): Promise<Response> {
  const flow: FlowState = { state: randomValue(), nonce: randomValue(), verifier: randomValue() };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier));

  const authorize = new URL(`${issuerOf(env)}/authorize`);
  authorize.searchParams.set('client_id', env.GATE_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', env.GATE_REDIRECT_URI);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid');
  authorize.searchParams.set('state', flow.state);
  authorize.searchParams.set('nonce', flow.nonce);
  authorize.searchParams.set('code_challenge', toBase64Url(new Uint8Array(digest)));
  authorize.searchParams.set('code_challenge_method', 'S256');

  const cookie = await mintSigned(JSON.stringify(flow), env.SESSION_SECRET, FLOW_TTL_SECONDS);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      'Set-Cookie': setCookie(FLOW_COOKIE, cookie, FLOW_TTL_SECONDS),
      'Cache-Control': 'no-store',
    },
  });
}

/** Empty, missing, or all-whitespace `APPROVER_SUBS` refuses every sub. */
function isApprover(sub: string, env: Env): boolean {
  const subs = (env.APPROVER_SUBS ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return subs.length > 0 && subs.includes(sub);
}

async function exchangeCode(code: string, verifier: string, env: Env): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${issuerOf(env)}/api/oidc/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.GATE_REDIRECT_URI,
        client_id: env.GATE_CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = await res.json() as { id_token?: unknown };
    return typeof body.id_token === 'string' && body.id_token !== '' ? body.id_token : null;
  } catch {
    return null;
  }
}

async function authCallback(req: Request, url: URL, env: Env): Promise<Response> {
  // The flow cookie is spent the moment it comes back, whichever way this ends.
  const spent = [clearCookie(FLOW_COOKIE)];
  const refuse = (message: string, status = 400) => notice('Sign-in failed', message, status, spent);

  const raw = await readSigned(cookieValue(req.headers.get('Cookie'), FLOW_COOKIE), env.SESSION_SECRET);
  if (raw === null) return refuse('this sign-in expired before it finished — open /approve and start again');

  let flow: FlowState;
  try {
    const parsed = JSON.parse(raw) as Partial<FlowState>;
    if (!parsed.state || !parsed.nonce || !parsed.verifier) {
      return refuse('the sign-in state was incomplete — start again at /approve');
    }
    flow = parsed as FlowState;
  } catch {
    return refuse('the sign-in state was unreadable — start again at /approve');
  }

  if (url.searchParams.has('error')) return refuse('Pocket ID refused the sign-in — start again at /approve');
  if (!timingSafeEqual(url.searchParams.get('state') ?? '', flow.state)) {
    return refuse('that sign-in did not start here — start again at /approve');
  }

  const code = url.searchParams.get('code') ?? '';
  if (code === '') return refuse('Pocket ID returned no code — start again at /approve');

  const idToken = await exchangeCode(code, flow.verifier, env);
  if (idToken === null) return refuse('the identity provider would not trade that code — start again at /approve');

  const claims = await verifyWithKeySet(idToken, keySetFor(env), issuerOf(env), env.GATE_CLIENT_ID);
  if (!claims) return refuse('that identity token did not verify — start again at /approve', 403);

  // The nonce ties this token to the browser that started the login. It is read
  // off the payload only after the signature above has already been trusted.
  let nonce: unknown;
  try {
    nonce = decodeJwt(idToken).nonce;
  } catch {
    nonce = undefined;
  }
  if (typeof nonce !== 'string' || !timingSafeEqual(nonce, flow.nonce)) {
    return refuse('that identity token belongs to a different sign-in — start again at /approve');
  }

  if (!isApprover(claims.sub, env)) {
    return notice(
      'Not an approver',
      'you are signed in to Pocket ID, but this account is not on the gate’s approver list — nothing was approved',
      403, spent,
    );
  }

  const session = await mintSession(claims.sub, env.SESSION_SECRET);
  const headers = new Headers({
    Location: new URL('/approve', env.PUBLIC_URL || req.url).toString(),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', clearCookie(FLOW_COOKIE));
  headers.append('Set-Cookie', setCookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

// ── the desk ────────────────────────────────────────────────────────────────

const STALE_FORM = 'that form went stale — reload /approve and try again';
const NO_SESSION = 'your approver session expired — reload /approve to sign in again';
const NOT_A_FORM = 'the gate expects a form post from its own page';
const DELISTED = 'this account is no longer on the gate’s approver list — nothing was approved;'
  + ' restore the sub in APPROVER_SUBS, then sign in again';

async function readForm(req: Request): Promise<URLSearchParams | null> {
  if (!(req.headers.get('Content-Type') ?? '').includes('application/x-www-form-urlencoded')) return null;
  try {
    return new URLSearchParams(await req.text());
  } catch {
    return null;
  }
}

interface Seat { sub: string; value: string }

/**
 * Who is at the desk, if anyone. Two things must hold, and both are checked on
 * every act rather than once at login: the cookie must verify, and the sub it
 * names must still be on the allowlist. A session is a day long and the list
 * can be emptied in a second — so the list, not the cookie, is what says who
 * may approve. Taking a sub off `APPROVER_SUBS` shuts that browser out on its
 * very next request, and an empty list shuts every browser out.
 *
 * `delisted` separates "you were never signed in" from "you were, and are no
 * longer": the second deserves the truth and a burnt cookie, not a login loop.
 */
async function desk(req: Request, env: Env): Promise<{ seat: Seat | null; delisted: boolean }> {
  const header = req.headers.get('Cookie');
  const session = await readSession(header, env.SESSION_SECRET);
  const value = cookieValue(header, SESSION_COOKIE);
  if (!session || !value) return { seat: null, delisted: false };
  if (!isApprover(session.sub, env)) return { seat: null, delisted: true };
  return { seat: { sub: session.sub, value }, delisted: false };
}

/** The refusal owed to an empty seat — and, when the list moved, a dead cookie. */
function noSeat(delisted: boolean): Response {
  return delisted
    ? notice('Not an approver', DELISTED, 403, [clearCookie(SESSION_COOKIE)])
    : notice('Signed out', NO_SESSION, 403);
}

async function codeEntry(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const { seat, delisted } = await desk(req, env);
  if (!seat) return noSeat(delisted);

  const form = await readForm(req);
  if (!form) return notice('Bad request', NOT_A_FORM, 400);

  const entryCsrf = await csrfFor(seat.value, '', env.SESSION_SECRET);
  if (!timingSafeEqual(form.get('csrf') ?? '', entryCsrf)) return notice('Refused', STALE_FORM, 403);

  let knock: KnockView | null;
  try {
    knock = await gov.knockByUserCode((form.get('user_code') ?? '').trim());
  } catch {
    return notice('Gate unavailable', GOVERNOR_DOWN, 503);
  }

  if (!knock) {
    // Only wrong guesses are metered: a working approval never spends the
    // allowance, and a stream of wrong ones stops before it becomes a search.
    // The guess itself is not written down — the ledger records that a miss
    // happened and who was at the desk, not what was typed.
    let allowed: boolean;
    try {
      allowed = (await gov.reserve(`approve:${seat.sub}`, 'gate', 'code-attempt', 'miss', CODE_ATTEMPT_CAP)).ok;
    } catch {
      return notice('Gate unavailable', GOVERNOR_DOWN, 503);
    }
    if (!allowed) return notice('Refused', 'too many attempts, wait 15 minutes', 429);
    return page(
      'No such knock',
      codeEntryForm(entryCsrf, 'no knock is waiting under that code — it may have expired, or been mistyped.'),
      404,
    );
  }

  return page('A door is knocking', confirmForm(knock, await csrfFor(seat.value, knock.userCode, env.SESSION_SECRET)));
}

async function confirm(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const { seat, delisted } = await desk(req, env);
  if (!seat) return noSeat(delisted);

  const form = await readForm(req);
  if (!form) return notice('Bad request', NOT_A_FORM, 400);

  // CSRF first, and bound to this exact code: a token lifted from the
  // code-entry page cannot be spent on a knock, and a token for one knock
  // cannot be spent on another.
  const userCode = (form.get('user_code') ?? '').trim();
  const expected = await csrfFor(seat.value, userCode, env.SESSION_SECRET);
  if (!timingSafeEqual(form.get('csrf') ?? '', expected)) return notice('Refused', STALE_FORM, 403);

  const choice = form.get('decision');
  if (choice !== 'open' && choice !== 'refuse') {
    return notice('Bad request', 'that was neither Open nor Refuse — nothing was decided', 400);
  }
  const decision: KnockDecision = choice === 'open' ? 'approved' : 'refused';

  const doorName = flatten(form.get('door_name') ?? '').trim().slice(0, DOOR_NAME_MAX).trim();
  if (doorName === '') {
    return notice('Bad request', 'a door needs a name you will recognise later — nothing was decided', 400);
  }

  let decided: boolean;
  try {
    decided = await gov.knockDecide(userCode, decision, doorName, DEVICE_SCOPE);
  } catch {
    return notice('Gate unavailable', GOVERNOR_DOWN, 503);
  }
  if (!decided) {
    return notice('Nothing to decide', 'that knock has expired or was already answered — ask the door to knock again', 409);
  }

  return notice(
    decision === 'approved' ? 'Opened' : 'Refused',
    decision === 'approved'
      ? `${doorName} holds a ${DEVICE_SCOPE} lease. It picks up its token on the next poll; revoke it any time from /leases.`
      : `${doorName} was turned away. It holds nothing.`,
    200,
  );
}

// ── the authcode consent (an MCP visit electing a scope) ─────────────────────

const NO_PENDING = 'no visit is waiting under this session — the consent may have expired, or was already answered. Ask the client to start again.';
const REGISTRAR_DOWN = 'the gate cannot reach the visit register right now — nothing was decided. Try again shortly.';

/**
 * Until there is a registry of origins Marcus has vouched for, every MCP visit
 * is a first meeting: warn, do not fail to warn. The banner is shown for every
 * authcode consent, and the decoded origin is always stated in full.
 */
function isNewOrigin(_origin: string): boolean {
  return true;
}

/** Render the election for the pending the cookie names — read server-side, never from the URL. */
async function authcodeConsent(
  env: Env, registrar: DurableObjectStub<RegistrarDO> | undefined, seat: Seat, pendingId: string,
): Promise<Response> {
  if (!registrar) return notice('Gate unavailable', REGISTRAR_DOWN, 503);

  let view: { client_id: string; origin: string; redirect_uri: string } | null;
  try {
    view = await registrar.pendingView(pendingId);
  } catch {
    return notice('Gate unavailable', REGISTRAR_DOWN, 503);
  }
  // A cookie with no living pending behind it is stale or forged — burn it.
  if (!view) return notice('No visit waiting', NO_PENDING, 404, [clearCookie(PENDING_COOKIE)]);

  const csrf = await csrfFor(seat.value, pendingId, env.SESSION_SECRET);
  return page('A visit is asking to enter', consentForm(view, csrf, isNewOrigin(view.origin)));
}

/**
 * Bind an approver's scope election to the pending the *browser's own cookie*
 * names — nothing a query param or form field claims. `full-house` is not
 * electable here, and `stream-read` takes the second confirmation; either miss
 * lands back on the election screen having attached nothing.
 */
async function authcodeConfirm(
  req: Request, env: Env, registrar: DurableObjectStub<RegistrarDO> | undefined, pendingId: string,
): Promise<Response> {
  const { seat, delisted } = await desk(req, env);
  if (!seat) return noSeat(delisted);
  if (!registrar) return notice('Gate unavailable', REGISTRAR_DOWN, 503);

  const form = await readForm(req);
  if (!form) return notice('Bad request', NOT_A_FORM, 400);

  // CSRF bound to this session and this exact pending: a token from one consent
  // cannot answer another, and neither can one lifted from the code-entry page.
  const expected = await csrfFor(seat.value, pendingId, env.SESSION_SECRET);
  if (!timingSafeEqual(form.get('csrf') ?? '', expected)) return notice('Refused', STALE_FORM, 403);

  const choice = form.get('decision');
  if (choice !== 'open' && choice !== 'refuse') {
    return notice('Bad request', 'that was neither Open nor Refuse — nothing was decided', 400);
  }
  if (choice === 'refuse') {
    return notice('Refused', 'the visit was turned away. It holds nothing.', 200, [clearCookie(PENDING_COOKIE)]);
  }

  const elected = form.get('scope') ?? '';
  const streamConfirmed = form.get('stream_confirm') === STREAM_CONFIRM;
  const badElection = !ELECTABLE_SCOPES.includes(elected)
    || (elected === STREAM_SCOPE && !streamConfirmed);

  if (badElection) {
    // Back to the election screen with nothing attached. Re-fetch the view to
    // redraw it; a pending that has since vanished is reported honestly.
    let view: { client_id: string; origin: string; redirect_uri: string } | null;
    try {
      view = await registrar.pendingView(pendingId);
    } catch {
      return notice('Gate unavailable', REGISTRAR_DOWN, 503);
    }
    if (!view) return notice('No visit waiting', NO_PENDING, 409, [clearCookie(PENDING_COOKIE)]);
    const message = elected === STREAM_SCOPE
      ? `${STREAM_SCOPE} needs the extra confirmation before it can be granted.`
      : 'choose a scope for this visit.';
    return page(
      'A visit is asking to enter',
      consentForm(view, expected, isNewOrigin(view.origin), message),
      400,
    );
  }

  let attached: boolean;
  try {
    attached = await registrar.attachApproval(pendingId, seat.sub, elected);
  } catch {
    return notice('Gate unavailable', REGISTRAR_DOWN, 503);
  }
  if (!attached) {
    return notice('Nothing to decide', NO_PENDING, 409, [clearCookie(PENDING_COOKIE)]);
  }

  return notice(
    'Opened',
    `this visit may enter with a ${elected} lease. It collects its token on the next token exchange; revoke it any time from /leases.`,
    200, [clearCookie(PENDING_COOKIE)],
  );
}

// ── the face ────────────────────────────────────────────────────────────────

export async function handleApprove(
  req: Request, env: Env, gov: DurableObjectStub<GovernorDO>,
  registrar?: DurableObjectStub<RegistrarDO>,
): Promise<Response> {
  const url = new URL(req.url);
  // The one authority on which pending a browser is answering is its own
  // cookie. A `?pending=…` on the URL is never consulted.
  const pendingId = cookieValue(req.headers.get('Cookie'), PENDING_COOKIE);

  if (url.pathname === '/auth/callback') {
    if (req.method !== 'GET') return notice('Not allowed', 'the callback is a GET', 405);
    return authCallback(req, url, env);
  }

  if (url.pathname === '/approve') {
    if (req.method === 'POST') return codeEntry(req, env, gov);
    if (req.method !== 'GET') return notice('Not allowed', 'the approval desk answers GET and POST', 405);
    const { seat, delisted } = await desk(req, env);
    // A de-listed browser is told so; sending it back to Pocket ID would only
    // walk it into the same refusal one round-trip later.
    if (delisted) return noSeat(true);
    // The login is a separate cookie, so the pending consent survives the
    // round-trip to Pocket ID and is still here when the approver returns.
    if (!seat) return startLogin(env);
    if (pendingId) return authcodeConsent(env, registrar, seat, pendingId);
    return page('The approval desk', codeEntryForm(
      await csrfFor(seat.value, '', env.SESSION_SECRET),
      'a door is waiting somewhere with a code on its screen. Type it in.',
    ));
  }

  if (url.pathname === '/approve/confirm') {
    if (req.method !== 'POST') return notice('Not allowed', 'a decision is a POST', 405);
    // The consent cookie tells the two flows apart: an MCP visit elects a scope;
    // a device knock decides a full-house lease as it always has.
    if (pendingId) return authcodeConfirm(req, env, registrar, pendingId);
    return confirm(req, env, gov);
  }

  return notice('Not found', 'no such page at the approval desk', 404);
}
