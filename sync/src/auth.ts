import { jwtVerify, createRemoteJWKSet, createLocalJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export async function verifyWithKeySet(
  token: string, keySet: JWTVerifyGetKey, issuer: string, audience?: string,
): Promise<{ sub: string } | null> {
  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer, clockTolerance: 60, ...(audience ? { audience } : {}),
    });
    return typeof payload.sub === 'string' && payload.sub ? { sub: payload.sub } : null;
  } catch {
    return null;
  }
}

export interface Env {
  JULIAN_SYNC: DurableObjectNamespace;
  OIDC_ISSUER: string;
  OIDC_JWKS_URL: string;
  OIDC_JWKS_JSON?: string; // test seam: inline JWKS instead of remote fetch
  OIDC_AUDIENCE?: string;  // when set, tokens must carry this aud
  GATE_URL: string;
  INTROSPECT_SECRET: string;
}

let remoteKeySet: JWTVerifyGetKey | null = null;
export function keySetFor(env: Env): JWTVerifyGetKey {
  if (env.OIDC_JWKS_JSON) return createLocalJWKSet(JSON.parse(env.OIDC_JWKS_JSON));
  remoteKeySet ??= createRemoteJWKSet(new URL(env.OIDC_JWKS_URL));
  return remoteKeySet;
}

// --- Lease-token introspection (POST /introspect on the gate) ---------------
//
// Doors present `jla_`-prefixed lease tokens instead of Pocket ID JWTs. The
// sync worker never verifies those locally (it holds no lease secrets) — it
// asks the gate. A module-level 60s cache keyed by token hash spares the gate
// a round trip on every reconnect/message-driven re-auth from a hot socket.

export interface LeaseIntrospection {
  active: boolean;
  leaseId?: string;
  doorName?: string;
  scope?: string;
}

interface IntrospectCacheEntry {
  result: LeaseIntrospection;
  expiresAt: number;
}

const INTROSPECT_CACHE_TTL_MS = 60_000;
const introspectCache = new Map<string, IntrospectCacheEntry>();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Note: a fetch() failure (gate unreachable — DNS/connect error, not an HTTP
// error status) is deliberately NOT caught here and propagates to the caller.
// Callers distinguish "gate said inactive" (401/close 4001, revoked — safe to
// tell the door to re-knock) from "couldn't ask the gate" (503/close 4002,
// fail closed) by catching the throw; collapsing both into `{active:false}`
// here would erase that distinction. A non-200 HTTP response IS treated as
// inactive, per the introspect contract (only 401 on a bad shared secret, and
// that should never happen from server-held config).
export async function introspectLease(
  token: string,
  gateUrl: string,
  secret: string,
): Promise<LeaseIntrospection> {
  const key = await sha256Hex(token);
  const now = Date.now();
  const cached = introspectCache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  const res = await fetch(`${gateUrl}/introspect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Introspect-Secret': secret,
    },
    body: new URLSearchParams({ token }),
  });

  let result: LeaseIntrospection;
  if (!res.ok) {
    result = { active: false };
  } else {
    const body = await res.json() as {
      active: boolean;
      lease_id?: string;
      door_name?: string;
      scope?: string;
    };
    result = body.active
      ? { active: true, leaseId: body.lease_id, doorName: body.door_name, scope: body.scope }
      : { active: false };
  }

  introspectCache.set(key, { result, expiresAt: now + INTROSPECT_CACHE_TTL_MS });
  return result;
}
