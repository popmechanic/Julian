// The two browser-facing faces, and the one wrapper they share.
//
// A browser cannot hold a lease the way a VM door can: it has no place to keep
// a refresh token that a script on the page cannot also read, and a WebSocket
// upgrade gives it no header to present. So the browser gets a *delegated
// session* instead — `POST /exchange` trades a verified Pocket ID token for one
// hour-scale access token on Marcus's own `browser:<sub>` lease, and
// `POST /socket-ticket` trades that token for a sixty-second, single-use ticket
// that may ride in a URL because it dies before anyone can read the log.
//
// Both live in this one module on purpose (PROTO N5). The CORS answer is not a
// decoration on each handler; it is the module's entry and exit, so a third
// browser endpoint added here cannot forget it the way a third endpoint added
// across three files would.
import { keySetFor } from './auth';
import type { Env } from './env';
import type { ExchangeMintResult, GovernorDO, MintTicketResult } from './governor';
import { ACCESS_PREFIX, GOVERNOR_DOWN, json } from './lease-auth';
import { verifyWithKeySet } from 'julian-shared/auth';
import { EXCHANGE_SCOPES } from 'julian-shared/scopes';

/** The one scope this flow hands out — spec §5's mint allowlist, not a literal. */
const EXCHANGE_SCOPE = EXCHANGE_SCOPES[0];

/** The reserved door-name prefix for a browser session. The register enforces it too. */
const BROWSER_PREFIX = 'browser:';

/**
 * The ledger's name for what happens here. `exchange.mint` is not in the verb
 * policy table and never goes through `reserve` — these are self-authenticating
 * faces with their own caps (the session cap, the ticket cap, the rate limiter),
 * so the register is asked to *record*, never to *permit*.
 */
const LEDGER_SERVICE = 'exchange';
const LEDGER_MINT = 'mint';
const LEDGER_TICKET = 'ticket';

/**
 * The refusal ledger key for an exchange that never reached a lease id. The
 * mint's `revoked` and `session-cap` answers both mean a lease row exists but
 * do not carry its id, so the row is penned under this stable key with the
 * subject's own door name in the detail — the only place the sub is legible.
 */
const EXCHANGE_LEDGER_KEY = 'exchange';

// Every refusal says what died and what to do about it. A browser is the one
// caller that cannot read a runbook, so these sentences are the runbook.
const NO_SESSION =
  'no session token — sign in, then present the Pocket ID token as `Authorization: Bearer <jwt>`';
const BAD_SESSION =
  'session token invalid or expired — sign in again, then retry the exchange';
const NO_AUDIENCE =
  'the gate has no OIDC_AUDIENCE configured, so it cannot tell which app a token was minted for — refusing every exchange until it is set; tell Marcus';
const RATE =
  'too many failed exchanges from this address — wait a minute, then sign in again';
const NOT_LISTED =
  'this account is not admitted to the stream — ask Marcus to add your subject to STREAM_SUBS';
const UNMAPPED =
  'this account is listed but carries no record to write to — ask Marcus to map it as `sub=principal` in STREAM_SUBS; the gate never guesses one';
const REVOKED =
  'exchange refused: lease revoked — a standing act (reinstate) is required; signing in again will not help';
const SESSION_CAP =
  'too many active sessions on this account — close a tab, or wait for one to expire (an hour at most), then retry';
const NOT_A_TICKET_CREDENTIAL =
  'a socket ticket needs a session access token — POST /exchange first, then present the jla_ token here';
const DEAD_ACCESS =
  'session access token invalid or expired — re-exchange at POST /exchange, then ask for a ticket again';
const NOT_A_SESSION =
  'socket tickets are minted only for browser sessions — this lease opens its sockets with its own Authorization header instead';
const TICKET_CAP =
  'too many live socket tickets on this session — wait a few seconds and retry';
const WRONG_METHOD =
  'this face answers POST only — send the token as `Authorization: Bearer <token>` on a POST';

/**
 * The `STREAM_SUBS` map, read twice over so the two ways of being refused stay
 * distinguishable. A `sub=principal` entry populates both halves; a bare `sub`,
 * or one whose principal is empty, populates `listed` alone — which is how
 * "listed but unmapped" can be told from "not listed at all", and why neither
 * is ever quietly defaulted to `julian` (SEC NEW-4: one env-var slip must not
 * grant cross-tenant write). An empty or unset var yields two empty halves and
 * therefore refuses everyone.
 */
export function parseStreamSubs(raw: string | undefined): { map: Map<string, string>; listed: Set<string> } {
  const map = new Map<string, string>();
  const listed = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    // Only the first `=` splits: a principal is free to contain one, a sub is not.
    const eq = trimmed.indexOf('=');
    const sub = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim();
    if (sub === '') continue;
    const principal = eq === -1 ? '' : trimmed.slice(eq + 1).trim();
    listed.add(sub);
    if (principal !== '') map.set(sub, principal);
  }
  return { map, listed };
}

/**
 * The CORS answer for one request. Exact string match against `APP_ORIGINS` —
 * no suffix rule, no scheme coercion, no `*`, and never
 * `Access-Control-Allow-Credentials`: these faces authenticate on a header the
 * page sets deliberately, so a browser must never be able to reach them with
 * ambient credentials it did not choose to send.
 *
 * `Vary: Origin` is unconditional. It rides refusals and preflights alike
 * (SEC NEW-17), because a cache that learned one origin's answer must not be
 * allowed to hand it to another.
 */
export function corsHeadersFor(req: Request, env: Env): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  const origin = req.headers.get('Origin');
  if (origin === null || origin === '') return headers;
  const allowed = (env.APP_ORIGINS ?? '').split(',').map((o) => o.trim());
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/** Re-dress a finished response in this request's CORS answer. */
function withCors(res: Response, cors: Record<string, string>, extra: Record<string, string> = {}): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries({ ...cors, ...extra })) headers.set(name, value);
  return new Response(res.body, { status: res.status, headers });
}

/** `{error, class}` — the human sentence and the machine class, always both. */
function refuse(cors: Record<string, string>, status: number, cls: string, error: string): Response {
  return withCors(json({ error, class: cls }, status), cors);
}

/** The preflight. It costs nothing and counts against nothing. */
function preflight(cors: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/**
 * OPTIONS → preflight; POST → null (carry on); anything else → 405. Returned as
 * a Response-or-null so both handlers open with the same two lines.
 */
function methodGate(req: Request, cors: Record<string, string>): Response | null {
  if (req.method === 'OPTIONS') return preflight(cors);
  if (req.method !== 'POST') {
    return withCors(json({ error: WRONG_METHOD, class: 'method' }, 405), cors, { Allow: 'POST, OPTIONS' });
  }
  return null;
}

function bearerOf(req: Request): string {
  const header = req.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/**
 * The denied pen, in the shape `reserveLease` gives it: zero caps, so the row
 * lands marked disallowed and no quota is spent. Failure to write it does not
 * un-refuse anything — the refusal stands either way, exactly as it does in
 * `lease-auth.ledgerRefusal`.
 */
async function penRefusal(
  gov: DurableObjectStub<GovernorDO>, leaseId: string, doorName: string, verb: string, detail: string,
): Promise<void> {
  try {
    await gov.reserveLease(leaseId, doorName, LEDGER_SERVICE, verb, detail, 0, 0);
  } catch {
    // The refusal stands either way.
  }
}

/**
 * `POST /exchange` — a Pocket ID session traded for a lease access token.
 *
 * The order below is the whole security argument, so it is worth reading as
 * one: the method gate spends nothing; a missing bearer is answered before any
 * configuration is consulted; a missing audience refuses *everyone* rather than
 * verifying against an unbounded audience; and the rate limiter is consulted
 * **only after a verification has already failed**, so a legitimate signed-in
 * subject is never turned away by a counter someone else filled (and, when the
 * binding is absent entirely, is never turned away at all — the one place this
 * house's fail-closed instinct is deliberately inverted).
 */
export async function handleExchange(
  req: Request, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  const cors = corsHeadersFor(req, env);
  const wrongMethod = methodGate(req, cors);
  if (wrongMethod) return wrongMethod;

  const token = bearerOf(req);
  if (token === '') return refuse(cors, 401, 'bad-session', NO_SESSION);

  // Fail closed on configuration: without an audience the gate cannot tell a
  // token minted for the app from one minted for anything else Pocket ID serves.
  if (!env.OIDC_AUDIENCE) return refuse(cors, 503, 'no-audience', NO_AUDIENCE);

  const claims = await verifyWithKeySet(token, keySetFor(env), env.OIDC_ISSUER, env.OIDC_AUDIENCE);
  if (!claims) {
    // Only a failed verification reaches the counter. The key is the connecting
    // address because there is no trustworthy subject here — the token that
    // would have named one is the thing that just failed.
    const key = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    let limited = false;
    if (env.EXCHANGE_RL) {
      try {
        limited = !(await env.EXCHANGE_RL.limit({ key })).success;
      } catch {
        // A limiter that cannot answer refuses nobody, for the same reason a
        // missing one does not: it is a comfort, not a gate.
        limited = false;
      }
    }
    return limited
      ? refuse(cors, 429, 'rate', RATE)
      : refuse(cors, 401, 'bad-session', BAD_SESSION);
  }

  const { map, listed } = parseStreamSubs(env.STREAM_SUBS);
  if (!listed.has(claims.sub)) return refuse(cors, 403, 'not-listed', NOT_LISTED);
  const principal = map.get(claims.sub);
  if (principal === undefined) return refuse(cors, 403, 'unmapped', UNMAPPED);
  // Both refusals above are pre-lease: there is no row to pen them under, and
  // inventing one would let an unverified stranger write into the register. A
  // bad-JWT refusal is the same case. They are deliberately unledgered.

  const doorName = BROWSER_PREFIX + claims.sub;
  let minted: ExchangeMintResult;
  try {
    minted = await gov.mintExchangeAccess(claims.sub, principal);
  } catch {
    return refuse(cors, 503, 'governor', GOVERNOR_DOWN);
  }

  if (minted.status === 'revoked') {
    await penRefusal(gov, EXCHANGE_LEDGER_KEY, doorName, LEDGER_MINT, `${doorName} refused: lease revoked`);
    return refuse(cors, 403, 'revoked', REVOKED);
  }
  if (minted.status === 'session-cap') {
    await penRefusal(
      gov, EXCHANGE_LEDGER_KEY, doorName, LEDGER_MINT, `${doorName} refused: too many active sessions`,
    );
    return refuse(cors, 429, 'session-cap', SESSION_CAP);
  }

  try {
    await gov.recordAllowed(minted.leaseId, doorName, LEDGER_SERVICE, LEDGER_MINT, `token=${minted.tokenId}`);
  } catch {
    // No act without a record of it. The token exists inside the register
    // either way, but withholding it here keeps it inert: unheld, it expires
    // within the hour and the next mint's prune reclaims it. The alternative —
    // serving a session the ledger has never heard of — is the one thing this
    // house does not do.
    return refuse(cors, 503, 'governor', GOVERNOR_DOWN);
  }

  return withCors(json({
    access_token: minted.accessToken,
    token_type: 'Bearer',
    expires_in: minted.expiresIn,
    scope: EXCHANGE_SCOPE,
  }), cors);
}

/**
 * `POST /socket-ticket` — a session access token traded for one URL-safe
 * upgrade credential.
 *
 * Only a `flow='exchange'` lease may ask (SEC NEW-13). A device or full-house
 * door already has somewhere safe to put a header, so handing it a credential
 * that rides in a query string would be a downgrade with nothing bought: the
 * ticket is a cure for the browser's missing header, not a second way in.
 */
export async function handleSocketTicket(
  req: Request, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  const cors = corsHeadersFor(req, env);
  const wrongMethod = methodGate(req, cors);
  if (wrongMethod) return wrongMethod;

  const token = bearerOf(req);
  // Checked before the register is asked anything: a Pocket ID JWT is not a
  // ticket credential, and the exchange is where it belongs.
  if (!token.startsWith(ACCESS_PREFIX)) return refuse(cors, 401, 'bad-token', NOT_A_TICKET_CREDENTIAL);

  let identity;
  try {
    identity = await gov.validateAccess(token);
  } catch {
    return refuse(cors, 503, 'governor', GOVERNOR_DOWN);
  }
  if (!identity) return refuse(cors, 401, 'bad-token', DEAD_ACCESS);

  // A ticket stores the `(leaseId, tokenId)` binding and nothing else, so a
  // token with no handle has nothing to bind to. Only pre-B3 rows can be in
  // that state, and none of them is a browser session — both halves of this
  // condition mean the same thing to the caller: this is not a session token.
  if (identity.flow !== 'exchange' || identity.tokenId === null) {
    await penRefusal(
      gov, identity.leaseId, identity.doorName, LEDGER_TICKET,
      `refused: flow ${identity.flow} may not mint socket tickets`,
    );
    return refuse(cors, 403, 'not-a-session', NOT_A_SESSION);
  }

  let minted: MintTicketResult;
  try {
    minted = await gov.mintTicket(identity.leaseId, identity.tokenId);
  } catch {
    return refuse(cors, 503, 'governor', GOVERNOR_DOWN);
  }
  if (minted.status === 'cap') {
    await penRefusal(
      gov, identity.leaseId, identity.doorName, LEDGER_TICKET, 'refused: too many live tickets',
    );
    return refuse(cors, 429, 'rate', TICKET_CAP);
  }

  // The successful mint is not ledgered here. Sync writes the row that matters
  // — the socket actually opening — and a ticket that is minted and never
  // presented is not an act, only an intention (§10.4: the fold stays legible).
  return withCors(json({ ticket: minted.ticket, expires_in: minted.expiresIn }), cors);
}
