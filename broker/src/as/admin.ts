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
import { MANIFEST_PATH, PIN_KEY } from '../package-types';
import type { PackageManifest } from '../package-types';
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

  if (path === '/refusals') {
    if (req.method !== 'POST') return json({ error: 'refusals are POSTed' }, 405);
    return recordRefusal(req, env, gov);
  }

  if (path === '/leases' || path === '/leases/revoke' || path === '/leases/export' || path === '/ledger' || path === '/pin-bump') {
    const authorized = await authorizeRegister(req, env);
    if (!authorized) return json({ error: NO_CREDENTIAL }, 401);
    if (path === '/leases' && req.method === 'GET') return listLeases(gov);
    if (path === '/leases/revoke' && req.method === 'POST') return revokeLease(req, gov, authorized);
    if (path === '/leases/export' && req.method === 'GET') return exportLeases(gov);
    if (path === '/ledger' && req.method === 'GET') return readLedger(req, gov);
    if (path === '/pin-bump' && req.method === 'POST') return pinBump(req, env);
    return json({ error: 'no such register action' }, 404);
  }

  return new Response('Not found', { status: 404 });
}
