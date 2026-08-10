// The register: `POST /introspect` answers julian-sync about whether a lease
// token still holds; `/leases*` is the operator's console onto the same
// register — read the roster, revoke a door, or pull the break-glass export.
//
// Two credentials open the register, and only two: a shared secret for
// machines (julian-sync's introspection call, the break-glass CLI) or the
// approver's own browser session — the same cookie `/approve` mints. Neither
// is optional; there is no unauthenticated path onto a lease's identity or a
// revoke, and a session for a sub the approval desk would no longer seat is
// refused here too — the allowlist, not the cookie, is what says who may act.
import type { Env } from '../env';
import type { GovernorDO, LeaseExport, LeaseIdentity, LeaseSummary } from '../governor';
import { ACCESS_PREFIX, GOVERNOR_DOWN, json } from '../lease-auth';
import { readSession, timingSafeEqual } from './session';

/** Same allowlist rule the approval desk enforces: empty or missing refuses everyone. */
function isApprover(sub: string, env: Env): boolean {
  const subs = (env.APPROVER_SUBS ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return subs.length > 0 && subs.includes(sub);
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

/** No body detail on a bad secret — the wire contract is 401 alone. */
async function introspect(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const presented = req.headers.get('X-Introspect-Secret') ?? '';
  if (!env.INTROSPECT_SECRET || !timingSafeEqual(presented, env.INTROSPECT_SECRET)) {
    return new Response(null, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ active: false });
  }
  const token = (form.get('token') ?? '').toString().trim();
  // Introspection is for lease tokens only — sync keeps its own legacy JWT path.
  if (!token.startsWith(ACCESS_PREFIX)) return json({ active: false });

  let identity: LeaseIdentity | null;
  try {
    identity = await gov.validateAccess(token);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if (!identity) return json({ active: false });
  return json({
    active: true, lease_id: identity.leaseId, door_name: identity.doorName,
    scope: identity.scope, principal: identity.principal,
  });
}

/** Sync-side refusals arrive here; the row is the same denied pen the broker's
 *  own verb path uses (reserveLease with zero caps): one disallowed entry, no
 *  quota spent. Guarded by the machine credential, like /introspect. */
async function recordRefusal(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const presented = req.headers.get('X-Introspect-Secret') ?? '';
  if (!env.INTROSPECT_SECRET || !timingSafeEqual(presented, env.INTROSPECT_SECRET)) {
    return json({ error: 'no machine credential' }, 401);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }
  const b = body as Record<string, unknown>;
  const fields = ['lease_id', 'door_name', 'service', 'verb', 'detail'] as const;
  if (!fields.every((f) => typeof b[f] === 'string' && (b[f] as string).length > 0)) {
    return json({ error: 'lease_id, door_name, service, verb, detail — all required strings' }, 400);
  }
  try {
    await gov.reserveLease(
      b.lease_id as string, b.door_name as string, b.service as string, b.verb as string, b.detail as string, 0, 0,
    );
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  return json({ recorded: true });
}

async function listLeases(gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  let leases: LeaseSummary[];
  try {
    leases = await gov.leaseList();
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  return json({ leases });
}

/** `door_name` from a form body, trimmed; null when the body carries nothing usable. */
async function readDoorName(req: Request): Promise<string | null> {
  if (!(req.headers.get('Content-Type') ?? '').includes('application/x-www-form-urlencoded')) return null;
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return null;
  }
  const doorName = (form.get('door_name') ?? '').trim();
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
  const limit = parseInt(new URL(req.url).searchParams.get('limit') ?? '50', 10) || 50;
  try {
    return json({ entries: await gov.entries(limit) });
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
}

export async function handleAdmin(
  req: Request, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  const path = new URL(req.url).pathname;

  if (path === '/introspect') {
    if (req.method !== 'POST') return json({ error: 'introspection is a POST' }, 405);
    return introspect(req, env, gov);
  }

  if (path === '/refusals') {
    if (req.method !== 'POST') return json({ error: 'refusals are POSTed' }, 405);
    return recordRefusal(req, env, gov);
  }

  if (path === '/leases' || path === '/leases/revoke' || path === '/leases/export' || path === '/ledger') {
    const authorized = await authorizeRegister(req, env);
    if (!authorized) return json({ error: NO_CREDENTIAL }, 401);
    if (path === '/leases' && req.method === 'GET') return listLeases(gov);
    if (path === '/leases/revoke' && req.method === 'POST') return revokeLease(req, gov, authorized);
    if (path === '/leases/export' && req.method === 'GET') return exportLeases(gov);
    if (path === '/ledger' && req.method === 'GET') return readLedger(req, gov);
    return json({ error: 'no such register action' }, 404);
  }

  return new Response('Not found', { status: 404 });
}
