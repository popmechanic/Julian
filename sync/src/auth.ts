// sync/src/auth.ts — sync's client of the one authority.
//
// The gate is the only thing sync asks about a credential. There is no JWKS
// here, no issuer, no audience, no `jose`. The gate's JWT arm was deleted at
// the sunset (2026-08-25): a raw Pocket ID JWT is refused by the router before
// any round trip, and would answer `{active:false}` at the gate regardless.
// One authority means two workers can never disagree about who is alive.
import {
  CONSUME_TICKET_PATH,
  INTROSPECT_PATH,
  INTROSPECT_SECRET_HEADER,
  type ConsumeTicketWire,
  type IntrospectionWire,
} from 'julian-shared/gate-contract';

export interface Env {
  JULIAN_SYNC: DurableObjectNamespace;
  GATE: GateFetcher;
  INTROSPECT_SECRET: string;
  // The broker-only read road's own secret (`X-Sync-Read-Secret`), installed
  // as a worker secret at deploy step 0 — never a var, never in wrangler.toml.
  // It is deliberately NOT the introspection secret: /internal/read/* is a
  // different privilege (read the stream) from /introspect (ask about a
  // credential), and one leaked secret must not buy the other. Typed as
  // `string` but read defensively at the guard, because an unset secret
  // arrives as undefined at runtime and must refuse everyone.
  SYNC_READ_SECRET: string;

  /** When set, the worker answers 410 to everything — the sunset signpost. */
  MOVED_TO?: string;
}

// --- Gate-mediated credential checks ---------------------------------------
//
// Doors present `jla_`-prefixed lease tokens; the browser presents a `jst_`
// socket ticket. (The legacy window's Pocket ID JWT road closed at the
// sunset, 2026-08-25.) The sync worker verifies none of them locally (it
// holds no secrets and no keys) — it asks the gate. A module-level 60s cache keyed by token hash (or by handle)
// spares the gate a round trip on every reconnect/message-driven re-auth from
// a hot socket. Tickets are deliberately excluded: see `consumeTicket`.

export interface LeaseIntrospection {
  active: boolean;
  leaseId?: string;
  doorName?: string;
  scope?: string;
  principal?: string;
  subject?: string;
  flow?: string;
  tokenId?: string;
  exp?: number;
  // Only ever set beside `active:false`, and only by the by-handle form: see
  // `IntrospectionWire.reason`. The DO turns this into WS 4004 rather than
  // 4001, so it must survive the wire→domain mapping below.
  reason?: 'token-expired';
}

/** The gate's verdict on a single-use socket ticket. */
export interface ConsumeTicket {
  ok: boolean;
  leaseId?: string;
  tokenId?: string;
  subject?: string;
  scope?: string;
  flow?: string;
  principal?: string;
  // The minting access token's expiry — see `ConsumeTicketWire.exp`. Carried
  // through to the socket attachment, where it is the exchange flow's own
  // evidence that an inactive answer means "aged out", not "revoked".
  exp?: number;
  error?: string;
}

/** Structural type of a Cloudflare service binding (Fetcher). Tests inject fakes. */
export interface GateFetcher {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

interface IntrospectCacheEntry {
  result: LeaseIntrospection;
  expiresAt: number;
}

const INTROSPECT_CACHE_TTL_MS = 60_000;
const introspectCache = new Map<string, IntrospectCacheEntry>();

// The URL's host is ignored by a service binding — https://gate/ is a
// conventional placeholder. Only the path matters. (Sync→gate traffic goes
// through the GATE binding, never a public URL — same-account workers.dev
// fetches do not route, issue #28.)
const gateUrl = (path: string): string => `https://gate${path}`;

function formPost(secret: string, body: URLSearchParams): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      [INTROSPECT_SECRET_HEADER]: secret,
    },
    body,
  };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromWire(body: IntrospectionWire): LeaseIntrospection {
  return body.active
    ? {
        active: true,
        leaseId: body.lease_id, doorName: body.door_name,
        scope: body.scope, principal: body.principal,
        subject: body.subject, flow: body.flow,
        tokenId: body.token_id, exp: body.exp,
      }
    // An inactive answer carries no identity — only, on the by-handle form,
    // the one sub-reason that separates "expired token" from "dead lease".
    // Dropping it here would collapse WS 4004 into 4001 and tell a browser
    // its session was revoked when it merely needs to re-exchange.
    : body.reason === 'token-expired'
      ? { active: false, reason: 'token-expired' }
      : { active: false };
}

// A governor blip must not read as revocation. Only a definitive 200 is ever
// a verdict on the credential itself:
//   - 200 {active:true, ...}  -> a living lease/session.
//   - 200 {active:false}      -> a definitive revocation.
// Anything else — a fetch() failure (gate unreachable, DNS/connect error), a
// 401 (bad shared secret / config error), or any 5xx / other non-200 status —
// means the gate did not give a definitive answer, not that it said no.
// These are deliberately NOT caught here and propagate as a throw, same
// shape for all of them: callers catch it and fail closed for the request at
// hand (503 / WS close 4002, "introspection unavailable") WITHOUT telling
// the door its lease was revoked (401 / WS close 4001, "lease revoked").
// Collapsing either into `{active:false}` here would erase that distinction.
//
// Only the two definitive 200 outcomes are cached — a transient failure must
// never be, or it would keep refusing reconnects for the rest of the 60s
// window even after the gate recovers.
async function definitive(
  key: string,
  gate: GateFetcher,
  secret: string,
  body: URLSearchParams,
  bypassCache = false,
): Promise<LeaseIntrospection> {
  const now = Date.now();
  if (!bypassCache) {
    const cached = introspectCache.get(key);
    if (cached && cached.expiresAt > now) return cached.result;
  }

  const res = await gate.fetch(gateUrl(INTROSPECT_PATH), formPost(secret, body));
  if (!res.ok) {
    throw new Error(`introspect: gate responded ${res.status}`);
  }

  const result = fromWire(await res.json() as IntrospectionWire);
  introspectCache.set(key, { result, expiresAt: now + INTROSPECT_CACHE_TTL_MS });
  return result;
}

/**
 * Introspects a `jla_` lease access token. (The router refuses every other
 * bearer shape before this is called; the gate would answer `{active:false}`
 * for one anyway.) Cached by token hash for 60s, definitive answers only.
 */
export async function introspectLease(
  token: string,
  gate: GateFetcher,
  secret: string,
): Promise<LeaseIntrospection> {
  return definitive(await sha256Hex(token), gate, secret, new URLSearchParams({ token }));
}

/**
 * Introspects by handle rather than by token: `lease_id`+`token_id` for a
 * lease, or `sub`+`exp`+`kind=legacy` for the legacy window. This is what a
 * hibernating socket re-auths with, because its attachment stores handles —
 * never a raw bearer.
 *
 * `bypassCache` is for the alarm sweep, whose whole job is to distrust a warm
 * answer.
 */
export async function introspectByHandle(
  form: Record<string, string>,
  gate: GateFetcher,
  secret: string,
  opts?: { bypassCache?: boolean },
): Promise<LeaseIntrospection & { subject?: string; flow?: string; tokenId?: string; exp?: number }> {
  return definitive(handleCacheKey(form), gate, secret, new URLSearchParams(form), opts?.bypassCache);
}

function handleCacheKey(form: Record<string, string>): string {
  return form.lease_id !== undefined
    ? `handle:${form.lease_id}:${form.token_id ?? ''}`
    : `legacy:${form.sub ?? ''}:${form.exp ?? ''}`;
}

/**
 * Spends a single-use socket ticket at the gate.
 *
 * This is deliberately its own function, and deliberately never touches
 * `introspectCache`: a ticket is spent, not queried, so a cached "ok" would
 * hand the same ticket to two sockets and quietly delete the single-use
 * property. Keeping the uncached call structurally separate means a later
 * refactor of the introspection path cannot re-lose it by accident.
 *
 * Non-200 is indefinite and throws, exactly as introspection does — the caller
 * fails closed with 503, never with a 401 that would read as "your ticket was
 * refused".
 */
export async function consumeTicket(
  ticket: string,
  gate: GateFetcher,
  secret: string,
): Promise<ConsumeTicket> {
  const res = await gate.fetch(
    gateUrl(CONSUME_TICKET_PATH), formPost(secret, new URLSearchParams({ ticket })));
  if (!res.ok) {
    throw new Error(`consume-ticket: gate responded ${res.status}`);
  }
  const body = await res.json() as ConsumeTicketWire;
  return body.ok
    ? {
        ok: true,
        leaseId: body.lease_id, tokenId: body.token_id, subject: body.subject,
        scope: body.scope, flow: body.flow, principal: body.principal,
        exp: body.exp,
      }
    : { ok: false, error: body.error };
}
