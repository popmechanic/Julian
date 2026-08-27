import {
  ALLOWED_PATH,
  INTERNAL_READ_PREFIX,
  INTROSPECT_SECRET_HEADER,
  REFUSALS_PATH,
  SYNC_AUTH_HEADER,
  SYNC_READ_SECRET_HEADER,
  type InternalReadRequest,
  type SyncAuthPayload,
} from 'julian-shared/gate-contract';
import { EXPORT_SCOPES, SOCKET_REQUIRED_MSG, SOCKET_SCOPES } from 'julian-shared/scopes';
import { storePathFor } from 'julian-shared/schema';
import { timingSafeEqual } from 'julian-shared/auth';
import { consumeTicket, introspectLease, type Env } from './auth';
export { JulianSyncDO } from './do';

const SEG = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;

// The §12 slot matrix, in words: a prefix is honored in exactly one slot.
//   jla_ -> Authorization only (a lease token in a URL leaks into logs)
//   jst_ -> ?ticket= only, and only on a WebSocket upgrade
// The JWT road is gone: the legacy window closed at the sunset (2026-08-25,
// `legacy-window-sync` revoked) and its fallback arm was deleted in the same
// sitting's permanence deploy — a raw bearer is refused here without ever
// reaching the gate.
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
// on a shape the read road itself does not serve.
//
// The reservation is total and cannot collide with a real store, because
// `storePathFor` refuses the `internal` principal outright (shared/schema.ts):
// no principal can ever own a store whose first segment is `internal`, so
// swallowing this prefix takes nothing from anyone.
const INTERNAL_PREFIX = '/internal/';

// The three read verbs. Server-side allowlist: an unrecognized verb is a 404
// after the secret, never a path handed onward to the DO.
const READ_KINDS = new Set(['recent', 'session', 'search']);

// The read road's refusals. The secret's own refusal is deliberately bodiless
// (an unauthenticated caller learns nothing about the shape of the road); every
// refusal past the guard says what died and what to do.
const BAD_PRINCIPAL_MSG = (principal: string): string =>
  `no store is addressable for principal \`${principal}\` — name a principal that owns a stream`;

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
  verb: 'export' | 'socket' | 'restore',
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

export function parsePath(
  pathname: string,
): { store: string; context: string; isExport: boolean; isRestore: boolean } | null {
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 3 && segs[2] !== 'export' && segs[2] !== 'restore') return null;
  if (segs.length < 2 || segs.length > 3) return null;
  const [store, context] = segs;
  if (!SEG.test(store) || !SEG.test(context)) return null;
  return { store, context, isExport: segs[2] === 'export', isRestore: segs[2] === 'restore' };
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

/**
 * The guarded road into the store: `POST /internal/read/{recent|session|search}`,
 * reached by the broker through its `SYNC` service binding.
 *
 * The shared secret is the WHOLE enforcement, and it is checked in the first
 * statement — before the method, before the path's tail, before the body is
 * touched. The binding is only the road: Cloudflare gives a service binding no
 * cryptographic identity a worker can verify, so no structural guard is
 * claimed here and none is relied on. An unset `SYNC_READ_SECRET` compares
 * against `''`, which `timingSafeEqual` refuses by construction (a zero-length
 * secret is never equal to anything) — so a mis-deployed worker refuses
 * everyone rather than admitting everyone.
 *
 * The refusal is bodiless on purpose: an unauthenticated caller learns nothing
 * from it, not even whether the verb it named exists.
 */
async function internalRead(req: Request, env: Env, url: URL): Promise<Response> {
  if (!timingSafeEqual(req.headers.get(SYNC_READ_SECRET_HEADER) ?? '', env.SYNC_READ_SECRET ?? '')) {
    return new Response(null, { status: 403 });
  }
  if (!url.pathname.startsWith(INTERNAL_READ_PREFIX)) {
    return new Response('Not found', { status: 404 });
  }
  if (req.method !== 'POST') {
    return new Response('reads are POST — resend as POST with a JSON body', { status: 405 });
  }
  const kind = url.pathname.slice(INTERNAL_READ_PREFIX.length);
  if (!READ_KINDS.has(kind)) {
    return new Response(
      `no read verb \`${kind}\` — the stream reads as recent, session, or search`, { status: 404 });
  }

  // Read the body once as text and forward that exact text, so the DO sees
  // what the caller sent rather than a re-serialization of it.
  const raw = await req.text();
  let body: InternalReadRequest;
  try {
    body = JSON.parse(raw) as InternalReadRequest;
  } catch {
    return new Response('unreadable body — send JSON like {"principal":"julian"}', { status: 400 });
  }

  // The principal names the store, and `storePathFor` is the only thing that
  // turns one into the other: it refuses the reserved `internal` principal and
  // anything outside the segment charset, so a body can neither address the
  // reserved prefix nor smuggle a path separator into the DO's name.
  const principal = typeof (body as { principal?: unknown })?.principal === 'string'
    ? body.principal : '';
  const storePath = storePathFor(principal);
  if (storePath === null) {
    return new Response(BAD_PRINCIPAL_MSG(principal), { status: 403 });
  }

  const stub = env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(storePath));
  return forwardToDo(stub, new Request(`https://do/read/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  }));
}

function ticketRefusal(error: string | undefined): string {
  if (error === 'expired') return 'ticket expired — mint another';
  if (error === 'reused') return 'ticket already used — mint another; this reuse is on the ledger';
  return 'not a living ticket';
}

export default {
  async fetch(rawReq: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    // Sunset kill-switch (soul.store migration): a deploy that sets MOVED_TO
    // turns this whole worker into a signpost. Placed before all routing so
    // no stale client can reach auth, storage, or the DO on the old house.
    // The DO bindings stay in wrangler.toml, so storage is untouched beneath it.
    //
    // Scope, stated honestly: this covers every *worker-routed* path. The
    // `[assets]` binding (`./public`) is served by the assets layer without
    // invoking the worker at all, so `/fonts/…` and the aurora keep answering
    // 200 under MOVED_TO — which is what the already-sent letters need until
    // the sunset sitting deletes the worker outright.
    if (env.MOVED_TO) {
      return Response.json(
        { error: 'gone', moved_to: env.MOVED_TO, message: `this house has moved — use ${env.MOVED_TO}` },
        { status: 410 },
      );
    }

    const req = stripInternalHandoff(rawReq);
    const url = new URL(req.url);

    // Matched AHEAD of parsePath, which would answer these paths 404 without
    // ever reaching the guard. The read road authenticates on its own secret,
    // so no lease, ticket, or JWT below buys anything here.
    if (url.pathname === '/internal' || url.pathname.startsWith(INTERNAL_PREFIX)) {
      return internalRead(req, env, url);
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
      if (parsed.isExport || parsed.isRestore) return new Response(TICKET_SOCKET_ONLY_MSG, { status: 401 });
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
        // The minting access token's expiry, carried through to the
        // attachment. A ticket-opened socket is the browser's socket, and
        // this is the only road by which its `exp` can reach the DO — without
        // it the exchange arm of `inactiveClose` never fires and an aged
        // session is told, terminally, that it was revoked (WS 4001 instead
        // of 4004). Absent is fine: the gate's own `reason` and the sweep
        // still govern, so the two workers deploy in either order.
        exp: consumed.exp,
      };
    } else {
      const token = headerToken ?? queryToken ?? '';
      if (!token) return new Response('Unauthorized', { status: 401 });
      // Only a lease token buys this arm. A raw Pocket ID JWT was honored here
      // until the sunset; it is now refused by shape, before any round trip —
      // the message tells a stale client what its session actually is.
      if (!token.startsWith('jla_')) {
        return new Response('this session is no longer recognized — sign in again', { status: 401 });
      }

      let introspection;
      try {
        // Through the GATE service binding, never a public URL (issue #28).
        introspection = await introspectLease(token, env.GATE, env.INTROSPECT_SECRET);
      } catch {
        return new Response(INDEFINITE_MSG, { status: 503 });
      }
      if (!introspection.active) {
        return new Response('lease revoked — re-knock', { status: 401 });
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
    const verb: 'export' | 'socket' | 'restore' =
      parsed.isExport ? 'export' : parsed.isRestore ? 'restore' : 'socket';
    const scopeAllows = parsed.isExport
      ? EXPORT_SCOPES.has(admitted.scope)
      : SOCKET_SCOPES.has(admitted.scope); // restore is a WRITE: socket scopes only
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
    if (parsed.isRestore) {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      // Door allowlist, fail-closed: unset RESTORE_DOORS admits nobody. Gated
      // on door_name because that is what the wire really carries for a
      // device-flow lease (subject is null there by construction — governor).
      const doors = new Set((env.RESTORE_DOORS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      if (admitted.doorName === undefined || !doors.has(admitted.doorName)) {
        reportPen(env, ctx, REFUSALS_PATH, admitted, 'restore',
          'refused: door is not on the restore allowlist');
        return new Response('restore is allowlisted-door-only', { status: 403 });
      }
      const bodyText = await req.text();
      reportPen(env, ctx, ALLOWED_PATH, admitted, 'restore',
        `token_id=${admitted.tokenId ?? ''}`);
      return forwardToDo(stub, new Request(new URL('/restore', req.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyText,
      }));
    }
    if (parsed.isExport) {
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      // A healthy read is a ledger row like a healthy open below: the pen
      // records what happened, not only what was refused. (Found missing by
      // the first live stream-read export, 2026-08-13.)
      reportPen(env, ctx, ALLOWED_PATH, admitted, 'export',
        `token_id=${admitted.tokenId ?? 'jwt'}`);
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
