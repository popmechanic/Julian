import { verifyWithKeySet, keySetFor, introspectLease, type Env } from './auth';
export { JulianSyncDO } from './do';

const SEG = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;

// Lease scopes that may read the /export snapshot. `reading-room` is
// package-only (identity, not confidentiality) and must never reach here —
// the private stream (`julian/chat`) is bound to one principal and is never
// readable by another principal or by a `reading-room` lease. This is the
// hard constraint.
//
// A live sync socket is stricter than /export: TinyBase sync is bidirectional
// by design (a socket client can push ContentDiff / ContentHashes and answer
// diff requests, and the DO relays client↔client), so a socket is a WRITE
// surface and requires full-house. `stream-read` gets /export only — never a
// socket. `reading-room` reaches neither.
const EXPORT_SCOPES = new Set(['stream-read', 'full-house']);
const SOCKET_SCOPE = 'full-house';

// Fire-and-forget: the refusal stands whether or not the report lands.
function reportRefusal(
  env: Env,
  ctx: ExecutionContext | undefined,
  leaseId: string,
  doorName: string,
  verb: 'export' | 'socket',
  detail: string,
): void {
  const p = env.GATE.fetch('https://gate/refusals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Introspect-Secret': env.INTROSPECT_SECRET },
    body: JSON.stringify({ lease_id: leaseId, door_name: doorName, service: 'stream', verb, detail }),
  }).then(() => undefined).catch(() => undefined);
  ctx?.waitUntil ? ctx.waitUntil(p) : void p;
}

export function parsePath(pathname: string): { store: string; context: string; isExport: boolean } | null {
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 3 && segs[2] !== 'export') return null;
  if (segs.length < 2 || segs.length > 3) return null;
  const [store, context] = segs;
  if (!SEG.test(store) || !SEG.test(context)) return null;
  return { store, context, isExport: segs.length === 3 };
}

export default {
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parsed = parsePath(url.pathname);
    if (!parsed) return new Response('Not found', { status: 404 });

    // Default-deny: no valid OIDC JWT and no valid lease → nothing. No public mode exists.
    //
    // Lease tokens (`jla_...`) ride in the Authorization header only — a
    // lease token in the query string is a URL that leaks into logs/history,
    // so it is refused outright rather than silently accepted. Legacy
    // Pocket ID JWTs keep their existing query-string fallback unchanged.
    const bearer = req.headers.get('Authorization');
    const headerToken = bearer?.startsWith('Bearer ') ? bearer.slice(7) : null;
    const queryToken = url.searchParams.get('token');

    if (queryToken?.startsWith('jla_')) {
      return new Response('lease tokens ride in headers only', { status: 401 });
    }

    let auth: { sub: string } | null;
    if (headerToken?.startsWith('jla_')) {
      let introspection;
      try {
        // Through the GATE service binding, never a public URL (issue #28).
        introspection = await introspectLease(headerToken, env.GATE, env.INTROSPECT_SECRET);
      } catch {
        // Gate unreachable: fail closed, same as an open re-auth would.
        return new Response('introspection unavailable', { status: 503 });
      }
      if (!introspection.active) {
        return new Response('lease revoked — re-knock', { status: 401 });
      }
      const verb: 'export' | 'socket' = parsed.isExport ? 'export' : 'socket';
      const allowed = parsed.isExport
        ? EXPORT_SCOPES.has(introspection.scope ?? '')
        : introspection.scope === SOCKET_SCOPE;
      if (!allowed) {
        reportRefusal(env, ctx, introspection.leaseId ?? '', introspection.doorName ?? '', verb,
          `refused: scope ${introspection.scope} may not stream.${verb}`);
        return new Response(
          parsed.isExport ? 'this lease may not read the stream' : 'a sync socket requires full-house',
          { status: 403 });
      }
      // The store segment is the owning principal (e.g. `julian/chat` is
      // owned by `julian`). A lease whose principal doesn't match never
      // reads another principal's stream, even with a stream-capable scope.
      const storeOwner = parsed.store;
      if ((introspection.principal ?? '') !== storeOwner) {
        reportRefusal(env, ctx, introspection.leaseId ?? '', introspection.doorName ?? '', verb,
          `refused: principal ${introspection.principal} does not own ${storeOwner}`);
        return new Response('this lease does not own this store', { status: 403 });
      }
      auth = { sub: `lease:${introspection.leaseId}` };
    } else {
      const token = headerToken ?? queryToken ?? '';
      auth = token ? await verifyWithKeySet(token, keySetFor(env), env.OIDC_ISSUER, env.OIDC_AUDIENCE) : null;
    }
    if (!auth) return new Response('Unauthorized', { status: 401 });

    const stub = env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(`${parsed.store}/${parsed.context}`));
    if (parsed.isExport) {
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return stub.fetch(new Request(new URL('/export', req.url), { method: 'GET' }));
    }
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    return stub.fetch(req);
  },
};
