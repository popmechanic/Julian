import {
  ALLOWED_PATH,
  INTROSPECT_SECRET_HEADER,
  REFUSALS_PATH,
  SYNC_AUTH_HEADER,
  type SyncAuthPayload,
} from 'julian-shared/gate-contract';
import { EXPORT_SCOPES, SOCKET_REQUIRED_MSG, SOCKET_SCOPES } from 'julian-shared/scopes';
import { consumeTicket, introspectLease, type Env } from './auth';
export { JulianSyncDO } from './do';

const SEG = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;

// The §12 slot matrix, in words: a prefix is honored in exactly one slot.
//   jla_ -> Authorization only (a lease token in a URL leaks into logs)
//   jst_ -> ?ticket= only, and only on a WebSocket upgrade
//   JWT  -> Authorization or ?token=, until the legacy window closes
// Every other pairing is a typed 401 that says which slot the credential
// belongs in, so a misconfigured client learns something from the refusal.
const LEASE_SLOT_MSG = 'lease tokens ride in headers only';
const TICKET_SLOT_MSG = 'a socket ticket rides in ?ticket= only';
const TICKET_ONLY_TICKET_MSG = '?ticket= carries a socket ticket (jst_…) only — mint one and retry';
const TICKET_SOCKET_ONLY_MSG = 'a ticket opens a socket, nothing else';
const INDEFINITE_MSG = 'introspection unavailable';

// Everything under /internal/ belongs to the broker-only read road, which
// authenticates on a different secret entirely. The whole prefix is reserved
// here — a reserved path must never fall through to store routing, not even
// while it is still empty.
const INTERNAL_PREFIX = '/internal/';

/** What the router learned about a request before it forwards anything. */
interface Admitted {
  leaseId: string;
  doorName: string;
  scope: string;
  principal: string;
  subject: string;
  flow: string;
  tokenId?: string;
  exp?: number;
}

// Fire-and-forget: the verdict stands whether or not the report lands. The
// denied pen (`/refusals`) and the positive pen (`/allowed`) take the same
// five fields and differ only in which column of the ledger they write.
function reportPen(
  env: Env,
  ctx: ExecutionContext | undefined,
  path: string,
  admitted: Pick<Admitted, 'leaseId' | 'doorName'>,
  verb: 'export' | 'socket',
  detail: string,
): void {
  const p = env.GATE.fetch(`https://gate${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [INTROSPECT_SECRET_HEADER]: env.INTROSPECT_SECRET,
    },
    body: JSON.stringify({
      lease_id: admitted.leaseId, door_name: admitted.doorName,
      service: 'stream', verb, detail,
    }),
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

const isUpgrade = (req: Request): boolean =>
  req.headers.get('Upgrade')?.toLowerCase() === 'websocket';

/**
 * The router's first act. `X-Sync-Auth` is the internal handoff the router
 * writes for its own Durable Object; anything carrying it inbound is either a
 * confused proxy or a forgery, and either way the DO must never see it.
 * Stripped unconditionally, before any routing decision reads the request.
 *
 * Exported so the strip is provable on its own terms: a test that names this
 * function fails to compile if the strip is ever deleted.
 */
export function stripInternalHandoff(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.delete(SYNC_AUTH_HEADER);
  return new Request(req, { headers });
}

/**
 * The only door to the Durable Object. Every request the router forwards goes
 * through here, and the handoff header is authored here and nowhere else:
 * deleted first — so no inbound value can survive by any route, including a
 * route added later that forwards a request the entry strip never touched —
 * then set only from the router's own payload, and only when there is one.
 *
 * Belt and braces on purpose. `stripInternalHandoff` protects the request the
 * router reasons about; this protects the request the DO actually receives,
 * which is the property that matters. Neither depends on the other.
 */
function forwardToDo(
  stub: { fetch(req: Request): Promise<Response> },
  req: Request,
  payload?: SyncAuthPayload,
): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete(SYNC_AUTH_HEADER);
  if (payload !== undefined) headers.set(SYNC_AUTH_HEADER, JSON.stringify(payload));
  return stub.fetch(new Request(req, { headers }));
}

function ticketRefusal(error: string | undefined): string {
  if (error === 'expired') return 'ticket expired — mint another';
  if (error === 'reused') return 'ticket already used — mint another; this reuse is on the ledger';
  return 'not a living ticket';
}

export default {
  async fetch(rawReq: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const req = stripInternalHandoff(rawReq);
    const url = new URL(req.url);

    if (url.pathname === '/internal' || url.pathname.startsWith(INTERNAL_PREFIX)) {
      return new Response('Not found', { status: 404 });
    }

    const parsed = parsePath(url.pathname);
    if (!parsed) return new Response('Not found', { status: 404 });

    // Default-deny: no credential the gate vouches for → nothing. No public
    // mode exists, and sync never reads a cookie.
    const bearer = req.headers.get('Authorization');
    const headerToken = bearer?.startsWith('Bearer ') ? bearer.slice(7) : null;
    const queryToken = url.searchParams.get('token');
    const queryTicket = url.searchParams.get('ticket');

    if (queryToken?.startsWith('jla_') || queryTicket?.startsWith('jla_')) {
      return new Response(LEASE_SLOT_MSG, { status: 401 });
    }
    if (headerToken?.startsWith('jst_') || queryToken?.startsWith('jst_')) {
      return new Response(TICKET_SLOT_MSG, { status: 401 });
    }

    let admitted: Admitted;
    if (queryTicket !== null) {
      // A ticket is a one-shot key to one door: a socket upgrade. Every other
      // shape is refused before the ticket is spent, so a mis-aimed client
      // can retry with the same ticket instead of burning it.
      if (parsed.isExport) return new Response(TICKET_SOCKET_ONLY_MSG, { status: 401 });
      if (!queryTicket.startsWith('jst_')) return new Response(TICKET_ONLY_TICKET_MSG, { status: 401 });
      if (!isUpgrade(req)) return new Response('Expected WebSocket', { status: 426 });

      let consumed;
      try {
        consumed = await consumeTicket(queryTicket, env.GATE, env.INTROSPECT_SECRET);
      } catch {
        // Indefinite: the gate did not answer. Fail closed as unavailable,
        // never as a refusal of the ticket itself.
        return new Response(INDEFINITE_MSG, { status: 503 });
      }
      if (!consumed.ok) {
        return new Response(ticketRefusal(consumed.error), { status: 401 });
      }
      admitted = {
        // /consume-ticket answers with the lease's identity, not the door's;
        // the register owns door names and fills this column itself.
        leaseId: consumed.leaseId ?? '', doorName: '',
        scope: consumed.scope ?? '', principal: consumed.principal ?? '',
        subject: consumed.subject ?? '', flow: consumed.flow ?? '',
        tokenId: consumed.tokenId,
      };
    } else {
      const token = headerToken ?? queryToken ?? '';
      if (!token) return new Response('Unauthorized', { status: 401 });

      let introspection;
      try {
        // Through the GATE service binding, never a public URL (issue #28).
        // `jla_` leases and legacy JWTs take the same road: the gate decides
        // which arm answers, and sync holds no keys of its own.
        introspection = await introspectLease(token, env.GATE, env.INTROSPECT_SECRET);
      } catch {
        return new Response(INDEFINITE_MSG, { status: 503 });
      }
      if (!introspection.active) {
        return new Response(
          token.startsWith('jla_')
            ? 'lease revoked — re-knock'
            : 'this session is no longer recognized — sign in again',
          { status: 401 });
      }
      admitted = {
        leaseId: introspection.leaseId ?? '', doorName: introspection.doorName ?? '',
        scope: introspection.scope ?? '', principal: introspection.principal ?? '',
        subject: introspection.subject ?? '', flow: introspection.flow ?? '',
        tokenId: introspection.tokenId, exp: introspection.exp,
      };
    }

    // One scope gate for every credential shape. `reading-room` is
    // package-only (identity, not confidentiality) and reaches neither
    // surface; `stream-read` reads /export but never holds a socket, because
    // TinyBase sync is bidirectional and a socket is therefore a WRITE
    // surface. The sets themselves live in the shared vocabulary — sync owns
    // no private copy of the table.
    const verb: 'export' | 'socket' = parsed.isExport ? 'export' : 'socket';
    const scopeAllows = parsed.isExport
      ? EXPORT_SCOPES.has(admitted.scope)
      : SOCKET_SCOPES.has(admitted.scope);
    if (!scopeAllows) {
      reportPen(env, ctx, REFUSALS_PATH, admitted, verb,
        `refused: scope ${admitted.scope} may not stream.${verb}`);
      return new Response(
        parsed.isExport ? 'this lease may not read the stream' : SOCKET_REQUIRED_MSG,
        { status: 403 });
    }
    // The store segment is the owning principal (e.g. `julian/chat` is owned
    // by `julian`). A credential whose principal doesn't match never reads
    // another principal's stream, even with a stream-capable scope.
    if (admitted.principal !== parsed.store) {
      reportPen(env, ctx, REFUSALS_PATH, admitted, verb,
        `refused: principal ${admitted.principal} does not own ${parsed.store}`);
      return new Response('this lease does not own this store', { status: 403 });
    }

    const stub = env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(`${parsed.store}/${parsed.context}`));
    if (parsed.isExport) {
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      // The DO routes on `/export`, so the path is rewritten; the caller's
      // headers ride along (as they do on the socket path) and pass through
      // the one door, which is what makes the handoff strip load-bearing here
      // rather than an accident of a freshly-built request.
      return forwardToDo(
        stub, new Request(new URL('/export', req.url), { method: 'GET', headers: req.headers }));
    }
    if (!isUpgrade(req)) {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // The handoff: identity by handle, never a raw bearer. The DO may trust
    // this header because no inbound copy of it survives the one door.
    const payload: SyncAuthPayload = {
      leaseId: admitted.leaseId,
      subject: admitted.subject,
      scope: admitted.scope,
      flow: admitted.flow,
      principal: admitted.principal,
      ...(admitted.tokenId !== undefined ? { tokenId: admitted.tokenId } : {}),
      ...(admitted.exp !== undefined ? { exp: admitted.exp } : {}),
    };

    // A healthy open is a ledger row too: the pen records what happened, not
    // only what was refused, so the record reads as a life rather than a
    // list of accidents.
    reportPen(env, ctx, ALLOWED_PATH, admitted, 'socket',
      `open token_id=${admitted.tokenId ?? 'jwt'}`);
    return forwardToDo(stub, req, payload);
  },
};
