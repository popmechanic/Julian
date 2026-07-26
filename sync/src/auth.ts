import { jwtVerify, createRemoteJWKSet, createLocalJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export async function verifyWithKeySet(
  token: string, keySet: JWTVerifyGetKey, issuer: string,
): Promise<{ sub: string } | null> {
  try {
    const { payload } = await jwtVerify(token, keySet, { issuer, clockTolerance: 60 });
    return typeof payload.sub === 'string' && payload.sub ? { sub: payload.sub } : null;
  } catch {
    return null;
  }
}

export interface Env {
  JULIAN_SYNC: DurableObjectNamespace;
  CLERK_ISSUER: string;
  CLERK_JWKS_URL: string;
  CLERK_JWKS_JSON?: string; // test seam: inline JWKS instead of remote fetch
}

let remoteKeySet: JWTVerifyGetKey | null = null;
export function keySetFor(env: Env): JWTVerifyGetKey {
  if (env.CLERK_JWKS_JSON) return createLocalJWKSet(JSON.parse(env.CLERK_JWKS_JSON));
  remoteKeySet ??= createRemoteJWKSet(new URL(env.CLERK_JWKS_URL));
  return remoteKeySet;
}
