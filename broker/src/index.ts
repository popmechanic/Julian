// The gate's front door. Four faces hang off one worker: the knock (`/device`,
// `/token`), the approval (`/approve`, `/auth/callback`), the register
// (`/introspect`, `/leases*`), and the verbs themselves. The first three carry
// their own auth; everything else must present a living lease. A token buys a
// verb, never the key — the upstream credential is read inside the service
// modules and is never echoed back to the caller.
import { handleAdmin } from './as/admin';
import { handleApprove } from './as/approve';
import { handleDevice } from './as/device';
import type { Env } from './env';
import type { GovernorDO, LeaseIdentity, LeaseReserveResult } from './governor';
import { GOVERNOR_DOWN, authenticate, json, leaseCapFor, scopeAllows } from './lease-auth';
import { policyFor } from './policy';
import { mailHealth, mailList, mailRead, mailSend, validateSendBody } from './services/mail';
export { GovernorDO } from './governor';
export { RegistrarDO } from './registrar';

function governor(env: Env): DurableObjectStub<GovernorDO> {
  return env.GOVERNOR.get(env.GOVERNOR.idFromName('governor')) as unknown as DurableObjectStub<GovernorDO>;
}

/**
 * A refusal is an act, and acts are ledgered. `reserveLease` with a zero cap is
 * the register's denied pen: it writes one row under `lease:<id>` marked
 * disallowed and spends no quota. If the governor is unreachable the caller is
 * refused anyway — a lost refusal row never widens what a door may do.
 */
async function ledgerRefusal(
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
async function reserve(
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

function passthrough(res: Response): Response {
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    let gov: DurableObjectStub<GovernorDO>;
    try {
      gov = governor(env);
    } catch {
      return json({ error: GOVERNOR_DOWN }, 503);
    }

    // The three self-authenticating faces, ahead of the lease gate: a door with
    // no lease yet must still be able to knock.
    if (path === '/device' || path === '/token') return handleDevice(req, env, gov);
    if (path === '/approve' || path.startsWith('/approve/') || path === '/auth/callback') {
      return handleApprove(req, env, gov);
    }
    if (path === '/introspect' || path === '/refusals' || path === '/leases' || path.startsWith('/leases/') || path === '/ledger') {
      return handleAdmin(req, env, gov);
    }

    // Everything past here is a verb, and every verb needs a living lease.
    const auth = await authenticate(req, env, gov);
    if (auth instanceof Response) return auth;

    if (path === '/mail/send' && req.method === 'POST') {
      let parsed: unknown;
      try { parsed = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
      const body = validateSendBody(parsed);
      if (!body) return json({ error: 'invalid send body: need {to: [email, ...], subject, and text or html}' }, 400);
      const refusal = await reserve(gov, auth, 'mail', 'send', `to=${body.to.join(',')} subject=${body.subject}`);
      if (refusal) return refusal;
      return passthrough(await mailSend(env, body));
    }

    if (path === '/mail/messages' && req.method === 'GET') {
      const refusal = await reserve(gov, auth, 'mail', 'list', '');
      if (refusal) return refusal;
      return passthrough(await mailList(env));
    }

    const readMatch = path.match(/^\/mail\/messages\/([^/]+)$/);
    if (readMatch && req.method === 'GET') {
      // Malformed percent-encoding must be the caller's error, not a worker crash.
      let id: string;
      try { id = decodeURIComponent(readMatch[1]); } catch { return json({ error: 'invalid message id' }, 400); }
      const refusal = await reserve(gov, auth, 'mail', 'read', `id=${id}`);
      if (refusal) return refusal;
      return passthrough(await mailRead(env, id));
    }

    if (path === '/health' && req.method === 'GET') {
      const refusal = await reserve(gov, auth, 'mail', 'health', '');
      if (refusal) return refusal;
      return json({ services: { mail: await mailHealth(env) } });
    }

    return new Response('Not found', { status: 404 });
  },
};
