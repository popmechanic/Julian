// The face's client of the sync worker's internal read routes (spec §14).
// Pure transport: build the wire request per verb, POST through the SYNC
// service binding with the shared secret, and collapse every kind of
// failure — non-200, an unparsable body, or a thrown fetch — to the same
// `{ok: false}` refusal shape. Callers never see the difference between
// "the store said no" and "the store could not be reached"; both mean the
// stream could not be read.
import type { Env } from '../env';
import { INTERNAL_READ_PREFIX, SYNC_READ_SECRET_HEADER } from 'julian-shared/gate-contract';
import type { InternalReadRequest, InternalReadResponse, StreamRow } from 'julian-shared/gate-contract';

export type StreamKind = 'recent' | 'session' | 'search';

// The internal-read wire clamps to this too (sync/src/reads.ts READ_MAX_ROWS),
// but the face clamps its own request rather than trusting the far side to —
// a caller asking for 10,000 rows never even puts that number on the wire.
const MAX_LIMIT = 200;

function clampLimit(limit: unknown): number | undefined {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return undefined;
  return Math.max(0, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Shape the tool's own arguments into the wire body for one read kind. The
 *  principal is never taken from `args` — it is always the caller's own. */
function buildBody(kind: StreamKind, principal: string, args: Record<string, unknown>): InternalReadRequest {
  const body: InternalReadRequest = { principal };
  if (kind === 'recent') {
    const limit = clampLimit(args.limit);
    if (limit !== undefined) body.limit = limit;
    return body;
  }
  if (kind === 'session') {
    body.sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
    const range = args.range && typeof args.range === 'object' ? args.range as Record<string, unknown> : {};
    const from = numberOrUndefined(range.from);
    const to = numberOrUndefined(range.to);
    if (from !== undefined) body.from = from;
    if (to !== undefined) body.to = to;
    return body;
  }
  // search
  body.query = typeof args.query === 'string' ? args.query : '';
  const limit = clampLimit(args.limit);
  if (limit !== undefined) body.limit = limit;
  return body;
}

/**
 * One internal read, own-principal only. Any non-200 response, a body that
 * fails to parse or does not carry `ok: true`, or a thrown fetch — all
 * collapse to `{ok: false}`. There is no partial success: the caller either
 * gets rows, or a refusal to build a tool result from.
 */
export async function streamRead(
  env: Env, kind: StreamKind, principal: string, args: Record<string, unknown>,
): Promise<{ ok: true; rows: StreamRow[]; truncated: boolean } | { ok: false }> {
  const body = buildBody(kind, principal, args);
  try {
    const res = await env.SYNC.fetch(`https://sync.internal${INTERNAL_READ_PREFIX}${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SYNC_READ_SECRET_HEADER]: env.SYNC_READ_SECRET },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false };
    const parsed = await res.json() as InternalReadResponse;
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.rows)) return { ok: false };
    return { ok: true, rows: parsed.rows, truncated: Boolean(parsed.truncated) };
  } catch {
    return { ok: false };
  }
}

/**
 * The ledger's args-hash (spec §15): a keyed digest of the tool's own
 * arguments, so a search query never sits in the ledger as recoverable
 * plaintext but a repeated read still leaves a matching fingerprint.
 */
export async function hmacHex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
