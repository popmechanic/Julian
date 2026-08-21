// Who is at the door, and what that buys them.
//
// Two kinds of caller reach the gate. A lease token (`jla_…`) is the gate's
// own credential: it is checked against the register, which is the only place
// a door's name and scope may come from. A Pocket ID JWT is the old way in,
// kept alive for the migration and modelled as one revocable pseudo-lease —
// so closing the window early is a revoke, not a deploy.
import { keySetFor, verifyWithKeySet } from './auth';
import type { Env } from './env';
import type { GovernorDO, LeaseIdentity, LeaseReserveResult } from './governor';
import { policyFor } from './policy';
import { SCOPE_VERBS } from 'julian-shared/scopes';

export const ACCESS_PREFIX = 'jla_';
export const LEGACY_LEASE_ID = 'legacy-window';
export const LEGACY_SCOPE = 'full-house';

// The per-lease `mail.send` allowance. The register carries the same number in
// each lease's own `send_cap_per_day` column, but Task 1's DO surface exposes
// no per-lease reader, so the default lives here as well; a lease with a
// bespoke cap will need a governor accessor before this can honour it.
export const LEASE_SEND_CAP_PER_DAY = 5;

// The per-lease `stream.*` allowance — a read a minute for twelve hours
// straight, generous enough that no legitimate visit notices it exists
// (one budget across the three stream verbs — #35).
export const STREAM_READ_CAP_PER_DAY = 500;

export const GOVERNOR_DOWN = 'governor unavailable — refusing without a ledger entry';

// A 401 tells the door what died and what to do about it — never a bare
// "Unauthorized" to something that can act on the answer.
const NO_TOKEN = 'no lease token — this door needs a lease; run: bun scripts/door-knock.ts';
const DEAD_LEASE = 'lease token invalid or expired — renew, or re-knock if revoked';
const BAD_SESSION =
  'session token invalid or expired — sign in again, or take a lease: bun scripts/door-knock.ts';
const WINDOW_CLOSED =
  'the legacy-bearer window has closed — this door needs a lease; run: bun scripts/door-knock.ts';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// What each scope may ask for lives in julian-shared/scopes (spec §5's
// table) — reading-room = the public identity package only (attribution,
// not confidentiality); stream-read/stream = package + the private live
// record, read-only (and, for stream, the socket); full-house = everything,
// incl. mail verbs — held by home doors, not MCP leases.
export function scopeAllows(scope: string, service: string, verb: string): boolean {
  if (!Object.hasOwn(SCOPE_VERBS, scope)) return false;
  return (SCOPE_VERBS as Readonly<Record<string, readonly string[]>>)[scope].includes(`${service}.${verb}`);
}

/**
 * The lease's own daily allowance for this verb, judged alongside the house's.
 * Only `mail.send` and `stream.*` are metered per lease. The legacy
 * pseudo-lease is deliberately unmetered for both: it stands for everyone who
 * was already trusted yesterday, and re-capping them mid-migration would break
 * doors the window exists to keep working — the house cap (mail's 20/day; no
 * house cap on stream reads) still binds it.
 */
export function leaseCapFor(auth: LeaseIdentity, service: string, verb: string): number | null {
  if (auth.leaseId === LEGACY_LEASE_ID) return null;
  if (service === 'mail' && verb === 'send') return LEASE_SEND_CAP_PER_DAY;
  if (service === 'stream') return STREAM_READ_CAP_PER_DAY;
  return null;
}

/**
 * Resolve the caller to a living lease, or to the finished refusal.
 * Never trusts a request body for identity: `doorName` and `scope` come from
 * the register alone.
 */
export async function authenticate(
  req: Request, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<LeaseIdentity | Response> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token === '') return json({ error: NO_TOKEN }, 401);

  if (token.startsWith(ACCESS_PREFIX)) {
    let identity: LeaseIdentity | null;
    try {
      identity = await gov.validateAccess(token);
    } catch {
      return json({ error: GOVERNOR_DOWN }, 503);
    }
    return identity ?? json({ error: DEAD_LEASE }, 401);
  }

  // The legacy path. A bearer that is not a lease token is only ever a Pocket
  // ID JWT, and only while all three of signature, window and pseudo-lease hold.
  const claims = await verifyWithKeySet(token, keySetFor(env), env.OIDC_ISSUER, env.OIDC_AUDIENCE);
  // A bearer that fails verification is a dead session, not a closed window:
  // say which one died, so the door knows whether to sign in or to knock.
  if (!claims) return json({ error: BAD_SESSION }, 401);

  const windowEnd = Date.parse(env.LEGACY_WINDOW_END ?? '');
  if (!Number.isFinite(windowEnd) || Date.now() >= windowEnd) return json({ error: WINDOW_CLOSED }, 401);

  let allowed: boolean;
  try {
    allowed = await gov.legacyAllowed();
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if (!allowed) return json({ error: WINDOW_CLOSED }, 401);

  return { leaseId: LEGACY_LEASE_ID, doorName: LEGACY_LEASE_ID, scope: LEGACY_SCOPE, principal: 'julian' };
}

/**
 * A refusal is an act, and acts are ledgered. `reserveLease` with a zero cap is
 * the register's denied pen: it writes one row under `lease:<id>` marked
 * disallowed and spends no quota. If the governor is unreachable the caller is
 * refused anyway — a lost refusal row never widens what a door may do.
 */
export async function ledgerRefusal(
  gov: DurableObjectStub<GovernorDO>, auth: LeaseIdentity,
  service: string, verb: string, detail: string,
): Promise<void> {
  try {
    await gov.reserveLease(auth.leaseId, auth.doorName, service, verb, detail, 0, 0);
  } catch {
    // The refusal stands either way.
  }
}

// Returns null when the act may proceed; otherwise the refusal Response.
// Fail closed: an unreachable governor refuses — no act without a ledger entry.
export async function reserve(
  gov: DurableObjectStub<GovernorDO>, auth: LeaseIdentity,
  service: string, verb: string, detail: string,
): Promise<Response | null> {
  const policy = policyFor(service, verb);
  if (!policy) return json({ error: 'unknown verb' }, 404);

  if (!scopeAllows(auth.scope, service, verb)) {
    await ledgerRefusal(gov, auth, service, verb, `refused: scope ${auth.scope} may not ${service}.${verb}`);
    return json({
      error: `this lease holds scope ${auth.scope}, which may not ${service}.${verb} — re-knock for full-house if the door needs it`,
    }, 403);
  }

  let result: LeaseReserveResult;
  try {
    result = await gov.reserveLease(
      auth.leaseId, auth.doorName, service, verb, detail,
      policy.capPerDay, leaseCapFor(auth, service, verb),
    );
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if (!result.ok) {
    return json({
      error: 'cap',
      refusedBy: result.refusedBy,
      policy: `${service}.${verb}: ${result.cap}/day`,
      count: result.count,
      cap: result.cap,
    }, 429);
  }
  return null;
}
