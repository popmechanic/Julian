// Who is at the door, and what that buys them.
//
// Two kinds of caller reach the gate. A lease token (`jla_…`) is the gate's
// own credential: it is checked against the register, which is the only place
// a door's name and scope may come from. A Pocket ID JWT is the old way in,
// kept alive for the migration and modelled as one revocable pseudo-lease —
// so closing the window early is a revoke, not a deploy.
import { keySetFor, verifyWithKeySet } from './auth';
import type { Env } from './env';
import type { GovernorDO, LeaseIdentity } from './governor';

export const ACCESS_PREFIX = 'jla_';
export const LEGACY_LEASE_ID = 'legacy-window';
export const LEGACY_SCOPE = 'full-house';

// The per-lease `mail.send` allowance. The register carries the same number in
// each lease's own `send_cap_per_day` column, but Task 1's DO surface exposes
// no per-lease reader, so the default lives here as well; a lease with a
// bespoke cap will need a governor accessor before this can honour it.
export const LEASE_SEND_CAP_PER_DAY = 5;

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

/** What each scope may ask for. Unknown scopes buy nothing.
 *  reading-room = the public identity package only (attribution, not confidentiality).
 *  stream-read  = package + the private live record, read-only.
 *  full-house   = everything, incl. mail verbs — held by home doors, not MCP leases. */
const PACKAGE_VERBS = ['package.list', 'package.read'] as const;
const STREAM_VERBS = ['stream.recent', 'stream.session', 'stream.search'] as const;
const MAIL_VERBS = ['mail.send', 'mail.list', 'mail.read', 'mail.health'] as const;

const SCOPE_VERBS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'reading-room': Object.freeze([...PACKAGE_VERBS]),
  'stream-read': Object.freeze([...PACKAGE_VERBS, ...STREAM_VERBS]),
  'full-house': Object.freeze([...PACKAGE_VERBS, ...STREAM_VERBS, ...MAIL_VERBS]),
});

export function scopeAllows(scope: string, service: string, verb: string): boolean {
  return SCOPE_VERBS[scope]?.includes(`${service}.${verb}`) ?? false;
}

/**
 * The lease's own daily allowance for this verb, judged alongside the house's.
 * Only `mail.send` is metered per lease. The legacy pseudo-lease is deliberately
 * unmetered: it stands for everyone who was already trusted yesterday, and
 * re-capping them at 5 mid-migration would break doors the window exists to keep
 * working — the house cap of 20 still binds it.
 */
export function leaseCapFor(auth: LeaseIdentity, service: string, verb: string): number | null {
  if (service !== 'mail' || verb !== 'send') return null;
  if (auth.leaseId === LEGACY_LEASE_ID) return null;
  return LEASE_SEND_CAP_PER_DAY;
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

  return { leaseId: LEGACY_LEASE_ID, doorName: LEGACY_LEASE_ID, scope: LEGACY_SCOPE };
}
