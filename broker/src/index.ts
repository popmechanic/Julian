// The broker's front door. Every request presents a session token; the token
// buys a verb, never the key. The upstream credential is read from the env
// inside the service modules and is never echoed back to the caller.
import { keySetFor, verifyWithKeySet } from './auth';
import type { Env } from './env';
import { policyFor } from './policy';
import type { GovernorDO, ReserveResult } from './governor';
import { mailHealth, mailList, mailRead, mailSend, validateSendBody } from './services/mail';
export { GovernorDO } from './governor';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function governor(env: Env): DurableObjectStub<GovernorDO> {
  return env.GOVERNOR.get(env.GOVERNOR.idFromName('governor')) as unknown as DurableObjectStub<GovernorDO>;
}

// Returns null when the act may proceed; otherwise the refusal Response.
// Fail closed: an unreachable governor refuses — no act without a ledger entry.
async function reserve(env: Env, sub: string, service: string, verb: string, detail: string): Promise<Response | null> {
  const policy = policyFor(service, verb);
  if (!policy) return json({ error: 'unknown verb' }, 404);
  let result: ReserveResult;
  try {
    result = await governor(env).reserve(sub, service, verb, detail, policy.capPerDay);
  } catch {
    return json({ error: 'governor unavailable — refusing without a ledger entry' }, 503);
  }
  if (!result.ok) {
    return json({ error: 'cap', policy: `${service}.${verb}: ${result.cap}/day`, count: result.count, cap: result.cap }, 429);
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

    // Default-deny: header bearer only. No public mode, no query token.
    const bearer = req.headers.get('Authorization');
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : '';
    const auth = token ? await verifyWithKeySet(token, keySetFor(env), env.OIDC_ISSUER, env.OIDC_AUDIENCE) : null;
    if (!auth) return new Response('Unauthorized', { status: 401 });

    if (url.pathname === '/mail/send' && req.method === 'POST') {
      let parsed: unknown;
      try { parsed = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
      const body = validateSendBody(parsed);
      if (!body) return json({ error: 'invalid send body: need {to: [email, ...], subject, and text or html}' }, 400);
      const refusal = await reserve(env, auth.sub, 'mail', 'send', `to=${body.to.join(',')} subject=${body.subject}`);
      if (refusal) return refusal;
      return passthrough(await mailSend(env, body));
    }

    if (url.pathname === '/mail/messages' && req.method === 'GET') {
      const refusal = await reserve(env, auth.sub, 'mail', 'list', '');
      if (refusal) return refusal;
      return passthrough(await mailList(env));
    }

    const readMatch = url.pathname.match(/^\/mail\/messages\/([^/]+)$/);
    if (readMatch && req.method === 'GET') {
      // Malformed percent-encoding must be the caller's error, not a worker crash.
      let id: string;
      try { id = decodeURIComponent(readMatch[1]); } catch { return json({ error: 'invalid message id' }, 400); }
      const refusal = await reserve(env, auth.sub, 'mail', 'read', `id=${id}`);
      if (refusal) return refusal;
      return passthrough(await mailRead(env, id));
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      const refusal = await reserve(env, auth.sub, 'mail', 'health', '');
      if (refusal) return refusal;
      return json({ services: { mail: await mailHealth(env) } });
    }

    if (url.pathname === '/ledger' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
      try {
        return json({ entries: await governor(env).entries(limit) });
      } catch {
        return json({ error: 'governor unavailable' }, 503);
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
