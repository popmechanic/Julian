import { createRemoteJWKSet, createLocalJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { Env } from './env';

export { verifyWithKeySet } from '../../sync/src/auth';

let remoteKeySet: JWTVerifyGetKey | null = null;
export function keySetFor(env: Env): JWTVerifyGetKey {
  if (env.OIDC_JWKS_JSON) return createLocalJWKSet(JSON.parse(env.OIDC_JWKS_JSON));
  remoteKeySet ??= createRemoteJWKSet(new URL(env.OIDC_JWKS_URL));
  return remoteKeySet;
}
