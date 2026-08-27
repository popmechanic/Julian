// The gate's front door. Five faces hang off one worker: the knock (`/device`,
// `/token`), the approval (`/approve`, `/auth/callback`), the register
// (`/introspect`, `/consume-ticket`, the two pens `/refusals` and `/allowed`,
// and `/leases*`), the browser pair (`/exchange`,
// `/socket-ticket`), and the verbs themselves. The first four carry their own
// auth; everything else must present a living lease. A token buys a verb, never
// the key — the upstream credential is read inside the service modules and is
// never echoed back to the caller.
import { handleAdmin } from './as/admin';
import { handleApprove } from './as/approve';
import { handleAuthcode, oauthDiscovery } from './as/authcode';
import { handleDevice } from './as/device';
import type { Env } from './env';
import { handleExchange, handleSocketTicket } from './exchange';
import type { GovernorDO } from './governor';
import { GOVERNOR_DOWN, authenticate, json, reserve } from './lease-auth';
import { handleMcp } from './mcp';
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
 * where to fetch protected-resource metadata. This is the whole reason `/mcp`
 * authenticates itself ahead of the generic lease gate — an MCP client must be
 * handed the discovery chain, not a JSON scolding it cannot parse.
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

function passthrough(res: Response): Response {
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Sunset kill-switch (soul.store migration): a deploy that sets MOVED_TO
    // turns this whole worker into a signpost. Placed before all routing so
    // no stale client can reach auth, storage, or the DO on the old house —
    // not even the unauthenticated discovery documents, which would otherwise
    // keep pointing a fresh MCP client at a gate that no longer answers.
    // The DO bindings stay in wrangler.toml, so the governor and registrar
    // storage sit untouched beneath it.
    if (env.MOVED_TO) {
      return Response.json(
        { error: 'gone', moved_to: env.MOVED_TO, message: `this house has moved — use ${env.MOVED_TO}` },
        { status: 410 },
      );
    }

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
    // The browser pair, mounted here with the other self-authenticating faces
    // and deliberately not under `/leases/`: `/exchange` presents a Pocket ID
    // token (there is no lease yet to present), and `/socket-ticket` presents a
    // session access token to a face that must answer CORS preflights the
    // generic lease gate below knows nothing about.
    if (path === '/exchange') return handleExchange(req, env, gov);
    if (path === '/socket-ticket') return handleSocketTicket(req, env, gov);

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
    if (path === '/introspect' || path === '/consume-ticket' || path === '/refusals' || path === '/allowed' || path === '/leases' || path.startsWith('/leases/') || path === '/ledger' || path === '/pin-bump') {
      return handleAdmin(req, env, gov);
    }

    if (path === '/mcp') {
      // The MCP face authenticates itself so an unauthenticated client gets
      // the RFC 9728 challenge (WWW-Authenticate → resource metadata), not a
      // JSON scolding it cannot parse. Governor-down stays 503.
      const auth = await authenticate(req, env, gov);
      if (auth instanceof Response) {
        return auth.status === 401 ? challenge401(env) : auth;
      }
      if (req.method !== 'POST') {
        return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      }
      return handleMcp(req, env, auth, gov);
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
