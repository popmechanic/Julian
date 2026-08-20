// The register, and the one authority on who is alive.
//
// `POST /introspect` answers julian-sync about *every* credential this house
// knows — a `jla_` lease token, a live socket's `(lease_id, token_id)` handle,
// and (until the sunset) a Pocket ID bearer, which the JWT arm here verifies
// so that sync holds no keys, no issuer and no audience of its own. One
// authority means two workers can never disagree about who is alive, and the
// window closes in one place. `POST /consume-ticket` spends a `jst_`;
// `/refusals` and `/allowed` are the two pens sync writes the record with; and
// `/leases*` is the operator's console onto the same register — read the
// roster and its membership lists, revoke a door, reinstate a session, or pull
// the break-glass export.
//
// Two credentials open the register, and only two: a shared secret for
// machines (julian-sync's introspection call, the break-glass CLI) or the
// approver's own browser session — the same cookie `/approve` mints. Neither
// is optional; there is no unauthenticated path onto a lease's identity or a
// revoke, and a session for a sub the approval desk would no longer seat is
// refused here too — the allowlist, not the cookie, is what says who may act.
//
// The line that runs through every answer below: **definitive or indefinite,
// never blurred**. A 200 `{active:…}` is the register's own word about a
// credential and may be cached and acted on; anything the gate could not
// decide — an unreachable governor, an unreachable JWKS, a missing audience —
// is a non-200, which sync reads as "ask again", never as "you were revoked".
import { createLocalJWKSet } from 'jose';
import type { JSONWebKeySet, JWTVerifyGetKey } from 'jose';
import { keySetFor } from '../auth';
import type { Env } from '../env';
import { parseStreamSubs } from '../exchange';
import { TICKET_PREFIX } from '../governor';
import type {
  ConsumeTicketResult, GovernorDO, HandleVerdict, LeaseExport, LeaseIdentity, LeaseSummary,
  ReinstateResult,
} from '../governor';
import { ACCESS_PREFIX, GOVERNOR_DOWN, json } from '../lease-auth';
import { MANIFEST_PATH, PIN_KEY } from '../package-types';
import type { PackageManifest } from '../package-types';
import { verifyWithKeySet } from 'julian-shared/auth';
import type { ConsumeTicketWire, IntrospectionWire } from 'julian-shared/gate-contract';
import { EXCHANGE_SCOPES } from 'julian-shared/scopes';
import { readSession, timingSafeEqual } from './session';

/** The approver allowlist, parsed once: empty or missing seats nobody. */
function approverSubs(env: Env): string[] {
  return (env.APPROVER_SUBS ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** Same allowlist rule the approval desk enforces: empty or missing refuses everyone. */
function isApprover(sub: string, env: Env): boolean {
  return approverSubs(env).includes(sub);
}

interface Authorized { by: string }

const NO_CREDENTIAL =
  'no credential for the register — send X-Breakglass-Secret, or sign in as an approver at /approve';

/** Break-glass secret first (constant-time), then an approver's own session. */
async function authorizeRegister(req: Request, env: Env): Promise<Authorized | null> {
  const presented = req.headers.get('X-Breakglass-Secret');
  if (presented && env.BREAKGLASS_SECRET && timingSafeEqual(presented, env.BREAKGLASS_SECRET)) {
    return { by: 'breakglass' };
  }
  const session = await readSession(req.headers.get('Cookie'), env.SESSION_SECRET);
  if (session && isApprover(session.sub, env)) return { by: `approver:${session.sub}` };
  return null;
}

/** The machine credential: the same shared secret sync presents on every road. */
function hasMachineCredential(req: Request, env: Env): boolean {
  const presented = req.headers.get('X-Introspect-Secret') ?? '';
  return !!env.INTROSPECT_SECRET && timingSafeEqual(presented, env.INTROSPECT_SECRET);
}

/**
 * The sync worker's own legacy window, as a pseudo-lease. Two windows, two
 * revokes: the browser's raw-JWT door and this one close separately, and the
 * name is reserved — no mint path may ever produce it.
 */
const LEGACY_SYNC_LEASE_ID = 'legacy-window-sync';
/** What the window buys: exactly what a browser session gets, and nothing more. */
const LEGACY_SYNC_SCOPE = EXCHANGE_SCOPES[0];
const LEGACY_FLOW = 'legacy';

/** The one definitive no. Everything indefinite is a non-200 instead. */
const INACTIVE: IntrospectionWire = { active: false };
/**
 * The same definitive no, with the one sub-reason the wire carries — and the
 * by-handle form is the only place it may appear. It says the lease still
 * stands and only the minting access token aged out, which a socket reads as
 * "close 4004, re-exchange and come back" rather than "you were revoked".
 */
const TOKEN_EXPIRED: IntrospectionWire = { active: false, reason: 'token-expired' };

const NO_AUDIENCE =
  'the gate has no OIDC_AUDIENCE configured, so it cannot tell which app a token was minted for — refusing every introspection of a session token until it is set; tell Marcus';
const JWKS_UNREACHABLE =
  'the gate could not reach Pocket ID for its signing keys, so nothing was decided about this token — retry; this is not a refusal';

function field(form: FormData, name: string): string {
  return (form.get(name) ?? '').toString().trim();
}

/**
 * The active answer for a real lease. `door_name` is present in every active
 * shape (COLD M-8). `subject` and `token_id` are *omitted* when the register
 * holds none rather than sent as null: sync stores whatever arrives and later
 * re-presents it as a form field, where a null would ride the wire as the
 * literal string "null" and match no row. `exp` — the access token's own
 * expiry — rides along for the same reason the legacy answer carries one: the
 * socket keeps it in its attachment and measures an aged token (WS 4004,
 * re-exchange) against a dead lease (WS 4001, terminal) with it.
 */
function activeLease(identity: LeaseIdentity): Response {
  const body: IntrospectionWire = {
    active: true,
    lease_id: identity.leaseId,
    door_name: identity.doorName,
    scope: identity.scope,
    principal: identity.principal,
    flow: identity.flow,
    ...(identity.subject === null ? {} : { subject: identity.subject }),
    ...(identity.tokenId === null ? {} : { token_id: identity.tokenId }),
    ...(identity.exp === undefined ? {} : { exp: identity.exp }),
  };
  return json(body);
}

/** The active answer for the legacy window — one pseudo-lease, whoever holds the JWT. */
function activeLegacy(sub: string, principal: string, exp: number): Response {
  const body: IntrospectionWire = {
    active: true, scope: LEGACY_SYNC_SCOPE,
    lease_id: LEGACY_SYNC_LEASE_ID, door_name: LEGACY_SYNC_LEASE_ID,
    principal, subject: sub, flow: LEGACY_FLOW, exp,
  };
  return json(body);
}

/** The window as configured. An unparseable date is a closed window, never an open one. */
function windowOpen(env: Env): boolean {
  const end = Date.parse(env.LEGACY_WINDOW_END ?? '');
  return Number.isFinite(end) && Date.now() < end;
}

/**
 * The keys, and only the keys. The network fetch is wrapped here — and nothing
 * else is — so that "Pocket ID was unreachable" stays distinguishable from
 * "this signature is wrong": the first is indefinite and must answer 503, the
 * second is definitive and answers `{active:false}`. `verifyWithKeySet`
 * collapses every failure into null, which is exactly right for a signature
 * and exactly wrong for a socket, so the fetch never happens inside it.
 *
 * The key set is deliberately not cached across calls. A stale set does not
 * fail *indefinitely* — it fails **definitively**, telling a browser whose key
 * merely rotated that it was revoked, which is the one wrong answer this
 * module exists to prevent. Sync already caches the verdict for 60s, and
 * Pocket ID's own cache headers ride the fetch, so the honest read costs
 * little; correctness after a rotation is worth all of it.
 */
async function jwksFor(env: Env): Promise<JWTVerifyGetKey | null> {
  if (env.OIDC_JWKS_JSON) {
    // The local seam: no network, but a malformed document is still indefinite.
    try {
      return keySetFor(env);
    } catch {
      return null;
    }
  }
  let res: Response;
  try {
    res = await fetch(env.OIDC_JWKS_URL);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return createLocalJWKSet(await res.json() as JSONWebKeySet);
  } catch {
    return null;
  }
}

/**
 * The window's own membership test, shared by the JWT arm and its by-handle
 * twin: a mapped sub, an open window, and a living pseudo-lease — all three,
 * or nothing. Returns the principal, `null` for a definitive no, or a finished
 * 503 when the register could not be asked.
 */
async function legacyPrincipal(
  sub: string, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<string | null | Response> {
  // `parseStreamSubs` populates the map only for `sub=principal` entries, so a
  // bare (listed-but-unmapped) sub lands here as undefined — the gate never
  // guesses a principal, and never defaults one to `julian` (SEC NEW-4).
  const principal = parseStreamSubs(env.STREAM_SUBS).map.get(sub);
  if (principal === undefined) return null;
  if (!windowOpen(env)) return null;
  try {
    return (await gov.legacySyncAllowed()) ? principal : null;
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
}

/**
 * The JWT arm: the gate is the one authority on a Pocket ID bearer, so sync
 * holds no keys, no issuer and no audience of its own and the sunset lands in
 * exactly one place (spec §6.5).
 */
async function introspectJwt(
  token: string, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  // Fail closed on configuration, as `/exchange` does: without an audience the
  // gate cannot tell a token minted for the app from any other Pocket ID token.
  if (!env.OIDC_AUDIENCE) return json({ error: NO_AUDIENCE }, 503);

  const keySet = await jwksFor(env);
  if (!keySet) return json({ error: JWKS_UNREACHABLE }, 503);

  const claims = await verifyWithKeySet(token, keySet, env.OIDC_ISSUER, env.OIDC_AUDIENCE);
  if (!claims) return json(INACTIVE);

  const principal = await legacyPrincipal(claims.sub, env, gov);
  if (principal instanceof Response) return principal;
  if (principal === null) return json(INACTIVE);
  return activeLegacy(claims.sub, principal, claims.exp);
}

/**
 * By handle: what a hibernating socket re-auths with, since its attachment
 * holds `(leaseId, tokenId)` and never a bearer.
 *
 * An `exchange` lease is re-judged against `STREAM_SUBS` on every such check.
 * That is the account-level kill switch (§6.2): striking a sub from the map
 * closes the sockets it already holds, without anyone having to find and
 * revoke each session by name. A sub struck from the map is struck, not stale,
 * so that refusal carries no `reason`: there is nothing to re-exchange into.
 *
 * This is the one form that may answer with a reason at all, and it does so on
 * exactly one verdict — a living lease whose access token simply aged out.
 */
async function introspectHandle(
  leaseId: string, tokenId: string, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  let verdict: HandleVerdict;
  try {
    verdict = await gov.validateByHandle(leaseId, tokenId);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if (verdict.status === 'token-expired') return json(TOKEN_EXPIRED);
  if (verdict.status === 'dead') return json(INACTIVE);
  const { identity } = verdict;
  if (identity.flow === 'exchange') {
    const { map } = parseStreamSubs(env.STREAM_SUBS);
    if (identity.subject === null || !map.has(identity.subject)) return json(INACTIVE);
  }
  return activeLease(identity);
}

/** The legacy window, asked by handle: the same three tests, plus the token's own expiry. */
async function introspectLegacyHandle(
  sub: string, rawExp: string, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  const exp = Number(rawExp);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return json(INACTIVE);
  const principal = await legacyPrincipal(sub, env, gov);
  if (principal instanceof Response) return principal;
  if (principal === null) return json(INACTIVE);
  return activeLegacy(sub, principal, exp);
}

/**
 * No body detail on a bad secret — the wire contract is 401 alone.
 *
 * Three request forms, one response shape, dispatched in this order:
 *   `token=jla_…`               → the register, by secret
 *   `token=jst_…`               → inactive; a ticket is consumed, never queried
 *   `token=<anything else>`     → the JWT arm (the legacy window)
 *   `lease_id=…&token_id=…`     → the register, by handle
 *   `sub=…&exp=…&kind=legacy`   → the legacy window, by handle
 * Anything else is inactive: an unreadable question earns no identity.
 */
async function introspect(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  if (!hasMachineCredential(req, env)) return new Response(null, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(INACTIVE);
  }

  const token = field(form, 'token');
  if (token !== '') {
    if (token.startsWith(ACCESS_PREFIX)) {
      let identity: LeaseIdentity | null;
      try {
        identity = await gov.validateAccess(token);
      } catch {
        return json({ error: GOVERNOR_DOWN }, 503);
      }
      return identity ? activeLease(identity) : json(INACTIVE);
    }
    // A ticket is spent at `/consume-ticket` or not at all: answering here
    // would let the introspection cache hand one ticket to two sockets.
    if (token.startsWith(TICKET_PREFIX)) return json(INACTIVE);
    return introspectJwt(token, env, gov);
  }

  const leaseId = field(form, 'lease_id');
  const tokenId = field(form, 'token_id');
  if (leaseId !== '' && tokenId !== '') return introspectHandle(leaseId, tokenId, env, gov);

  const sub = field(form, 'sub');
  const exp = field(form, 'exp');
  if (field(form, 'kind') === 'legacy' && sub !== '' && exp !== '') {
    return introspectLegacyHandle(sub, exp, env, gov);
  }
  return json(INACTIVE);
}

/**
 * `POST /consume-ticket` — the one place a `jst_` is spent. The governor is
 * the arbiter of the burn (it takes the row in the same statement it checks
 * it); this face only carries the verdict, and never invents one: an
 * unreachable register is 503, never a refused ticket.
 */
async function consumeTicket(
  req: Request, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  if (!hasMachineCredential(req, env)) return json({ error: 'no machine credential' }, 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ ok: false, error: 'unknown' } satisfies ConsumeTicketWire);
  }
  const ticket = field(form, 'ticket');
  // Anything that is not a ticket is unknown by inspection — no round trip, and
  // no chance of a lease token being read as one.
  if (!ticket.startsWith(TICKET_PREFIX)) return json({ ok: false, error: 'unknown' } satisfies ConsumeTicketWire);

  let result: ConsumeTicketResult;
  try {
    result = await gov.consumeTicket(ticket);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if (!result.ok) return json({ ok: false, error: result.error } satisfies ConsumeTicketWire);
  // `exp` is the minting access token's, and the socket's only clock: the
  // ticket is spent by the time this is read, so nothing downstream can ask
  // again. Omitted rather than guessed when the register has none to give.
  const body: ConsumeTicketWire = {
    ok: true, lease_id: result.leaseId, token_id: result.tokenId,
    scope: result.scope, flow: result.flow, principal: result.principal,
    ...(result.subject === null ? {} : { subject: result.subject }),
    ...(result.exp === undefined ? {} : { exp: result.exp }),
  };
  return json(body);
}

/** The five fields both pens take. Which of them may be empty is the pen's business. */
const PEN_FIELDS = ['lease_id', 'door_name', 'service', 'verb', 'detail'] as const;
const PEN_SHAPE = 'lease_id, door_name, service, verb, detail — all required strings';

interface Pen { leaseId: string; doorName: string; service: string; verb: string; detail: string }

/**
 * A pen row off a JSON body, or null when it is not one. `mustFill` names the
 * fields that must additionally be non-empty — the denied pen wants all five,
 * the positive pen does not (see `recordAllowedAct`).
 */
function penBody(body: unknown, mustFill: readonly string[]): Pen | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!PEN_FIELDS.every((f) => typeof b[f] === 'string')) return null;
  if (!mustFill.every((f) => (b[f] as string).length > 0)) return null;
  return {
    leaseId: b.lease_id as string, doorName: b.door_name as string,
    service: b.service as string, verb: b.verb as string, detail: b.detail as string,
  };
}

/** Both pens open the same way: machine credential, JSON body, five fields. */
async function readPen(
  req: Request, env: Env, mustFill: readonly string[],
): Promise<Pen | Response> {
  if (!hasMachineCredential(req, env)) return json({ error: 'no machine credential' }, 401);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }
  return penBody(body, mustFill) ?? json({ error: PEN_SHAPE }, 400);
}

/** Sync-side refusals arrive here; the row is the same denied pen the broker's
 *  own verb path uses (reserveLease with zero caps): one disallowed entry, no
 *  quota spent. Guarded by the machine credential, like /introspect. */
async function recordRefusal(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const pen = await readPen(req, env, PEN_FIELDS);
  if (pen instanceof Response) return pen;
  try {
    await gov.reserveLease(pen.leaseId, pen.doorName, pen.service, pen.verb, pen.detail, 0, 0);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  return json({ recorded: true });
}

/**
 * The positive pen, `/allowed`: a row for something that *happened* — a socket
 * opened, a read answered — where the decision was made elsewhere and no cap
 * is at stake. One row, always `allowed:1`, no quota spent.
 *
 * `door_name` may be empty here, unlike on `/refusals`. A socket admitted by
 * ticket knows its lease but not its door — `/consume-ticket` answers with the
 * lease's identity, and door names belong to the register, which fills the
 * column itself. Refusing the row over a name the caller was never given would
 * lose the one record that says the socket opened at all.
 *
 * Whatever the caller does send is carried only as far as the register, which
 * ignores it: a known lease is named from the register's own row, and an
 * unknown one is written nameless. The field survives on the wire because the
 * two pens share a shape, not because anything downstream believes it.
 */
async function recordAllowedAct(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const pen = await readPen(req, env, ['lease_id', 'service', 'verb']);
  if (pen instanceof Response) return pen;
  try {
    await gov.recordAllowed(pen.leaseId, pen.doorName, pen.service, pen.verb, pen.detail);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  return json({ recorded: true });
}

/**
 * The roster, and beside it the two membership lists that decide who may act
 * at all (SEC NEW-16). A lease readout that does not say who is admitted makes
 * the operator diff two env vars in another window to read one refusal; both
 * halves belong in one readout.
 *
 * A listed-but-unmapped sub appears with an empty principal rather than
 * vanishing: that state is exactly what earns a `403 unmapped`, and it should
 * be legible as a gap, not as an absence.
 */
async function listLeases(env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  let leases: LeaseSummary[];
  try {
    leases = await gov.leaseList();
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  const { map, listed } = parseStreamSubs(env.STREAM_SUBS);
  const streamSubs: Record<string, string> = {};
  for (const sub of listed) streamSubs[sub] = map.get(sub) ?? '';
  return json({ leases, approver_subs: approverSubs(env), stream_subs: streamSubs });
}

/** A form body, or null when the request carries nothing usable. */
async function readForm(req: Request): Promise<URLSearchParams | null> {
  if (!(req.headers.get('Content-Type') ?? '').includes('application/x-www-form-urlencoded')) return null;
  try {
    return new URLSearchParams(await req.text());
  } catch {
    return null;
  }
}

/** `door_name` from a form body, trimmed; null when the body carries nothing usable. */
async function readDoorName(req: Request): Promise<string | null> {
  const doorName = ((await readForm(req))?.get('door_name') ?? '').trim();
  return doorName === '' ? null : doorName;
}

async function revokeLease(
  req: Request, gov: DurableObjectStub<GovernorDO>, authorized: Authorized,
): Promise<Response> {
  const doorName = await readDoorName(req);
  if (!doorName) return json({ error: 'expected a form body with door_name' }, 400);

  let revoked: boolean;
  try {
    revoked = await gov.leaseRevoke(doorName, authorized.by);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if (!revoked) return json({ error: `no living lease named ${doorName}` }, 404);
  return json({ revoked: true, doorName });
}

/**
 * The one verb that undoes a revoke, gated exactly like `/leases/revoke`. It
 * mints nothing: the revoke burned the tokens and they stay burned, so the
 * holder simply exchanges their Pocket ID session again.
 *
 * Both 409s say what died and what to do instead, because both are cases where
 * retrying this verb is the wrong move — a killed-rotation lease is a theft
 * signal that no verb undoes, and a device or visit door already has its own
 * way back in.
 */
async function reinstateLease(
  req: Request, gov: DurableObjectStub<GovernorDO>, authorized: Authorized,
): Promise<Response> {
  const form = await readForm(req);
  const doorName = (form?.get('door_name') ?? '').trim();
  if (doorName === '') return json({ error: 'expected a form body with door_name' }, 400);
  // A reason is how the ledger row stays legible a year from now; an absent one
  // is recorded as such rather than refused.
  const reason = (form?.get('reason') ?? '').trim() || 'unstated';

  let result: ReinstateResult;
  try {
    result = await gov.reinstate(doorName, authorized.by, reason);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if ('ok' in result) return json({ reinstated: true });
  if (result.error === 'not-found') return json({ error: `no lease named ${doorName}` }, 404);
  if (result.error === 'not-revoked') {
    return json({
      error: `${doorName} is not revoked — there is nothing to reinstate; a killed-rotation lease is undone by no verb, so the holder re-knocks under a fresh name`,
    }, 409);
  }
  return json({
    error: `${doorName} is not a browser session — only an exchange lease is reinstated; a device or visit door comes back by knocking again`,
  }, 409);
}

async function exportLeases(gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  let dump: LeaseExport;
  try {
    dump = await gov.leaseExport();
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  return json(dump);
}

/** The ledger, same as `/leases*` — a register action, not a lease verb. */
async function readLedger(req: Request, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const limit = parseInt(params.get('limit') ?? '50', 10) || 50;
  const beforeRaw = params.get('before');
  let before: number | undefined;
  if (beforeRaw !== null) {
    before = Number(beforeRaw);
    if (!Number.isFinite(before)) return json({ error: 'before must be a unix-ms timestamp' }, 400);
  }
  try {
    return json({ entries: await gov.entries(limit, before) });
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
}

/** Spot-check depth: how many manifest files a bump re-verifies. */
const PIN_SPOT_CHECKS = 3;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The pin moves only after the new sha is proven: it must sit on the
 * protected default branch, and the manifest plus a spot-check of its files
 * must fetch-and-hash clean at that sha — killing the push-then-bump race
 * (spec §6). Gated exactly like /leases/revoke; never a lease scope.
 */
async function pinBump(req: Request, env: Env): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const sha = (form.get('sha') ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) return json({ error: 'sha must be a 40-hex commit id' }, 400);

  let compare: Response;
  try {
    // env.PIN_COMPARE_BASE: the compare-endpoint root from wrangler.toml
    // (repo hardcoded there, e.g. …/repos/popmechanic/Julian/compare/main...);
    // env-addressable so the CI harness can point it at a fixture server.
    compare = await fetch(`${env.PIN_COMPARE_BASE}${sha}`, {
      headers: { 'User-Agent': 'julian-gate', Accept: 'application/vnd.github+json' },
    });
  } catch {
    return json({ error: `could not reach GitHub to prove ${sha} is on main` }, 502);
  }
  if (!compare.ok) return json({ error: `sha ${sha} is unknown to the repo` }, 409);
  const rel = (await compare.json() as { status?: string }).status ?? '';
  // 'identical' or 'behind' ⇒ sha is an ancestor of main (on the protected branch).
  if (rel !== 'identical' && rel !== 'behind') {
    return json({ error: `sha ${sha} is not on the default branch (${rel || 'unknown'})` }, 409);
  }

  let manifestRes: Response;
  try {
    manifestRes = await fetch(`${env.PACKAGE_RAW_BASE}/${sha}/${MANIFEST_PATH}`);
  } catch {
    return json({ error: `manifest fetch failed at ${sha} — pin unchanged` }, 502);
  }
  if (!manifestRes.ok) return json({ error: `no manifest at ${sha} (${manifestRes.status}) — pin unchanged` }, 502);
  let manifest: PackageManifest;
  try {
    manifest = await manifestRes.json() as PackageManifest;
  } catch {
    return json({ error: `manifest at ${sha} is not JSON — pin unchanged` }, 502);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return json({ error: `manifest at ${sha} lists no files — pin unchanged` }, 502);
  }

  for (const entry of manifest.files.slice(0, PIN_SPOT_CHECKS)) {
    let res: Response;
    try {
      res = await fetch(`${env.PACKAGE_RAW_BASE}/${sha}/${entry.path}`);
    } catch {
      return json({ error: `spot-check fetch failed for ${entry.path} at ${sha} — pin unchanged` }, 502);
    }
    if (!res.ok) return json({ error: `spot-check ${entry.path} returned ${res.status} at ${sha} — pin unchanged` }, 502);
    const digest = await sha256Hex(await res.arrayBuffer());
    if (digest !== entry.sha256) {
      return json({ error: `spot-check hash mismatch for ${entry.path} at ${sha} — pin unchanged` }, 502);
    }
  }

  await env.PIN.put(PIN_KEY, sha);
  return json({ pinned: sha });
}

export async function handleAdmin(
  req: Request, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  const path = new URL(req.url).pathname;

  if (path === '/introspect') {
    if (req.method !== 'POST') return json({ error: 'introspection is a POST' }, 405);
    return introspect(req, env, gov);
  }

  if (path === '/consume-ticket') {
    if (req.method !== 'POST') return json({ error: 'a ticket is spent by POST' }, 405);
    return consumeTicket(req, env, gov);
  }

  if (path === '/refusals') {
    if (req.method !== 'POST') return json({ error: 'refusals are POSTed' }, 405);
    return recordRefusal(req, env, gov);
  }

  if (path === '/allowed') {
    if (req.method !== 'POST') return json({ error: 'ledger rows are POSTed' }, 405);
    return recordAllowedAct(req, env, gov);
  }

  if (path === '/leases' || path === '/leases/revoke' || path === '/leases/reinstate' || path === '/leases/export' || path === '/ledger' || path === '/pin-bump') {
    const authorized = await authorizeRegister(req, env);
    if (!authorized) return json({ error: NO_CREDENTIAL }, 401);
    if (path === '/leases' && req.method === 'GET') return listLeases(env, gov);
    if (path === '/leases/revoke' && req.method === 'POST') return revokeLease(req, gov, authorized);
    if (path === '/leases/reinstate' && req.method === 'POST') return reinstateLease(req, gov, authorized);
    if (path === '/leases/export' && req.method === 'GET') return exportLeases(gov);
    if (path === '/ledger' && req.method === 'GET') return readLedger(req, gov);
    if (path === '/pin-bump' && req.method === 'POST') return pinBump(req, env);
    return json({ error: 'no such register action' }, 404);
  }

  return new Response('Not found', { status: 404 });
}
