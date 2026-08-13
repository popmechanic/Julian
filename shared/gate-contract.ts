// shared/gate-contract.ts
//
// The wire shapes and path/header constants that both workers — and the
// acceptance harness — build against. Import-free, same as scopes.ts: this
// file exists so the broker's HTTP surface and sync's client of it never
// drift out of literal agreement (spec §8's fixture rule).

export const INTROSPECT_PATH = '/introspect';
export const CONSUME_TICKET_PATH = '/consume-ticket';
export const REFUSALS_PATH = '/refusals';
export const ALLOWED_PATH = '/allowed';
export const INTERNAL_READ_PREFIX = '/internal/read/';

export const SYNC_AUTH_HEADER = 'X-Sync-Auth';
export const INTROSPECT_SECRET_HEADER = 'X-Introspect-Secret';
export const SYNC_READ_SECRET_HEADER = 'X-Sync-Read-Secret';

// POST /introspect response shape — snake_case on the wire, `active` plus
// the optional fields present on an active answer. `door_name` is present
// in every active shape (even for an exchange lease, where it names a
// session rather than a door — see memory/adapters/gate-ledger.md).
export interface IntrospectionWire {
  active: boolean;
  lease_id?: string;
  door_name?: string;
  scope?: string;
  principal?: string;
  subject?: string;
  flow?: string;
  token_id?: string;
  exp?: number;
  // By-handle form ONLY, and only alongside `active:false`: the one sub-reason
  // an inactive by-handle answer carries. A hibernating socket re-auths by
  // handle and cannot otherwise tell "the lease died" (WS 4001, terminal) from
  // "the minting access token simply aged out" (WS 4004, re-exchange and come
  // back). `reason:'token-expired'` is that distinction and nothing else —
  // absent means the lease itself is dead.
  reason?: 'token-expired';
}

// The internal handoff the sync router hands to its DO after auth. Set once
// by the router, stripped unconditionally from every inbound request as the
// router's first act, and trusted by the DO from there on — no raw bearer is
// ever serialized into a socket attachment again.
export interface SyncAuthPayload {
  leaseId: string;
  tokenId?: string;
  subject: string;
  scope: string;
  flow: string;
  principal: string;
  exp?: number;
}

// POST /consume-ticket response shape.
export interface ConsumeTicketWire {
  ok: boolean;
  lease_id?: string;
  token_id?: string;
  subject?: string;
  scope?: string;
  flow?: string;
  principal?: string;
  // Expiry (seconds since the epoch) of the ACCESS TOKEN that minted this
  // ticket — not of the ticket, which is spent by the time anyone reads this.
  // It rides through to the socket attachment so a hibernating exchange socket
  // can tell an aged token (WS 4004, re-exchange) from a revoked lease (WS
  // 4001, terminal) even when the gate's by-handle answer carries no reason.
  // Optional on purpose: a gate that does not send it costs the socket
  // nothing but that local fallback, so the two workers deploy in any order.
  exp?: number;
  error?: string;
}

// POST <sync>/internal/read/{recent|session|search} request body.
export interface InternalReadRequest {
  principal: string;
  limit?: number;
  sessionId?: string;
  from?: number;
  to?: number;
  query?: string;
}

// One row of stream history, as read verbs and the internal-read wire hand
// it back — `text` only, never the raw `content` block array.
export interface StreamRow {
  id: string;
  sessionId: string;
  role: string;
  speakerName: string;
  text: string;
  ts: number;
  kind: string;
}

export type InternalReadResponse =
  | { ok: true; rows: StreamRow[]; truncated: boolean }
  | { ok: false };
