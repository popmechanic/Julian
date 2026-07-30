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
}

let remoteKeySet: JWTVerifyGetKey | null = null;
export function keySetFor(env: Env): JWTVerifyGetKey {
  if (env.OIDC_JWKS_JSON) return createLocalJWKSet(JSON.parse(env.OIDC_JWKS_JSON));
  remoteKeySet ??= createRemoteJWKSet(new URL(env.OIDC_JWKS_URL));
  return remoteKeySet;
}
