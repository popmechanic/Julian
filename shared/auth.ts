// shared/auth.ts
//
// The one JWT verifier and the one constant-time compare, hoisted so the
// broker and sync workers never hold two copies that can drift (the
// broker→sync source import this replaces coupled the two trees for no
// reason a shared package doesn't already solve).

import { jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

/**
 * Verifies a JWT against a key set, issuer, and (optionally) audience.
 * Returns the claims the gate actually needs — `sub` and `exp` — or null on
 * any failure: bad signature, wrong issuer/audience, or a payload missing a
 * numeric `exp` or a non-empty string `sub`.
 */
export async function verifyWithKeySet(
  token: string,
  keySet: JWTVerifyGetKey,
  issuer: string,
  audience?: string,
): Promise<{ sub: string; exp: number } | null> {
  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      clockTolerance: 60,
      ...(audience ? { audience } : {}),
    });
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return { sub: payload.sub, exp: payload.exp };
  } catch {
    return null;
  }
}

/**
 * Compares without leaking where two strings first differ. Both sides are
 * expected to be base64url of a fixed-width digest, so length alone tells an
 * attacker nothing he did not already know.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
