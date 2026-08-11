// The gate's front door. Four faces hang off one worker: the knock (`/device`,
// `/token`), the approval (`/approve`, `/auth/callback`), the register
// (`/introspect`, `/leases*`), and the verbs themselves. The first three carry
// their own auth; everything else must present a living lease. A token buys a
// verb, never the key — the upstream credential is read inside the service
// modules and is never echoed back to the caller.
import { handleAdmin } from './as/admin';
import { handleApprove } from './as/approve';
import { handleAuthcode, oauthDiscovery } from './as/authcode';
import { handleDevice } from './as/device';
import type { Env } from './env';
import type { GovernorDO, LeaseIdentity, LeaseReserveResult } from './governor';
import { GOVERNOR_DOWN, authenticate, json, leaseCapFor, scopeAllows } from './lease-auth';
import { policyFor } from './policy';
import type { RegistrarDO } from './registrar';
import { mailHealth, mailList, mailRead, mailSend, validateSendBody } from './services/mail';
export { GovernorDO } from './governor';
export { RegistrarDO } from './registrar';

/** RFC 6749 §4.1: the code grant `/token` must present to reach the authcode module. */
const AUTHCODE_GRANT_TYPE = 'authorization_code';

function governor(env: Env): DurableObjectStub<GovernorDO> {
  return env.GOVERNOR.get(env.GOVERNOR.idFromName('governor')) as unknown as DurableObjectStub<GovernorDO>;
}

/** Mirrors governor(env): the DCR/authcode store is a single named instance. */
function registrar(env: Env): DurableObjectStub<RegistrarDO> {
  return env.REGISTRAR.get(env.REGISTRAR.idFromName('registrar')) as unknown as DurableObjectStub<RegistrarDO>;
}

/**
 * The 401 a resource-server-unaware client gets from `/mcp` (RFC 9728 §5.1):
 * where to fetch protected-resource metadata. `/mcp` itself is not mounted
 * here — that is a future endpoint (B2) — but the discovery chain it will
 * point at is wired now, so this helper is ready the moment that door opens.
 */
export function challenge401(env: Env): Response {
  return new Response(null, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer resource_metadata="${env.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    },
  });
}

/**
 * Peek `grant_type` off a `/token` POST without spending the body the chosen
 * module will parse for itself — `req.clone()` gives the peek its own stream
 * so the module downstream still sees an unconsumed request. A body that
 * will not parse as form data is not this router's failure to report: it
 * falls through to the device module, exactly as an empty grant_type always
 * has, and that module's own `parseForm` produces the right error.
 */
async function peekGrantType(req: Request): Promise<string> {
  try {
    const form = await req.clone().formData();
    const value = form.get('grant_type');
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
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

    // OAuth discovery: public metadata, no lease, no DO round-trip.
    const discovery = oauthDiscovery(env, path);
    if (discovery) return discovery;

    // The authcode face — DCR registration and the consent hand-off both need
    // the registrar; a broken binding here refuses (fail closed), never mints.
    if (path === '/register' || path === '/authorize') {
      let reg: DurableObjectStub<RegistrarDO>;
      try {
        reg = registrar(env);
      } catch {
        return json({ error: GOVERNOR_DOWN }, 503);
      }
      return handleAuthcode(req, env, gov, reg);
    }

    // The self-authenticating faces, ahead of the lease gate: a door with no
    // lease yet must still be able to knock. `/token` forks on `grant_type`:
    // authorization_code goes to the authcode module, everything else
    // (device_code, refresh_token) keeps going to the device module, unchanged.
    if (path === '/device') return handleDevice(req, env, gov);
    if (path === '/token') {
      const grantType = await peekGrantType(req);
      if (grantType === AUTHCODE_GRANT_TYPE) {
        let reg: DurableObjectStub<RegistrarDO>;
        try {
          reg = registrar(env);
        } catch {
          return json({ error: GOVERNOR_DOWN }, 503);
        }
        return handleAuthcode(req, env, gov, reg);
      }
      return handleDevice(req, env, gov);
    }
    if (path === '/approve' || path.startsWith('/approve/') || path === '/auth/callback') {
      // Best-effort, not fail-closed: the device-flow desk (today's whole
      // approval surface) never touches the registrar, so a broken binding
      // must not turn away a device door. Once the authcode branch lands
      // (task 5) it fails closed on its own registrar calls when this is
      // undefined — the same way `gov` failures are handled throughout.
      let reg: DurableObjectStub<RegistrarDO> | undefined;
      try {
        reg = registrar(env);
      } catch {
        // fall through with reg left undefined
      }
      return handleApprove(req, env, gov, reg as DurableObjectStub<RegistrarDO>);
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
