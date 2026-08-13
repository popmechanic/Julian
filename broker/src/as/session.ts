// The approver's session, and the tokens that hang off it.
//
// A browser cannot hold a lease — leases belong to doors. What Marcus holds
// instead is a signed statement of who he is, minted only after Pocket ID has
// said so, carried in a cookie the gate signs and never trusts blindly. Nothing
// here is encrypted: the values are signed, not sealed. A browser may read its
// own session; it may not forge another.
//
// One shape serves both cookies: `<base64url(payload)>.<exp>.<base64url(sig)>`,
// where the signature covers `<payload>.<exp>` under HMAC-SHA-256. The session
// carries a `sub` and lives a day; the login flow carries its own state, nonce
// and PKCE verifier and lives ten minutes.

import { timingSafeEqual } from 'julian-shared/auth';

export { timingSafeEqual };

export const SESSION_COOKIE = 'gate_session';
export const FLOW_COOKIE = 'gate_flow';

export const SESSION_TTL_SECONDS = 86_400;  // one day at the approval desk
export const FLOW_TTL_SECONDS = 600;        // one trip to Pocket ID and back

const RANDOM_BYTES = 32; // 256 bits → 43 base64url characters, as the tokens use

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** 256 bits of fresh randomness, base64url — state, nonce, and the PKCE verifier. */
export function randomValue(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))));
}

/** A missing secret must never mint a credential — an unsigned cookie is a forged one. */
export async function mintSigned(payload: string, secret: string, ttlSeconds: number): Promise<string> {
  if (!secret) throw new Error('refusing to sign without SESSION_SECRET');
  const body = toBase64Url(encoder.encode(payload));
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${body}.${exp}.${await hmac(secret, `${body}.${exp}`)}`;
}

/** The payload back, or null: bad shape, bad signature, missing secret, or expired. */
export async function readSigned(value: string | null, secret: string): Promise<string | null> {
  if (!value || !secret) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [body, exp, signature] = parts;
  if (!timingSafeEqual(signature, await hmac(secret, `${body}.${exp}`))) return null;
  const expires = Number(exp);
  if (!Number.isInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return null;
  return fromBase64Url(body);
}

/** Reads one cookie out of a `Cookie:` header without trusting its neighbours. */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function mintSession(sub: string, secret: string): Promise<string> {
  return mintSigned(sub, secret, SESSION_TTL_SECONDS);
}

export async function readSession(
  cookieHeader: string | null, secret: string,
): Promise<{ sub: string } | null> {
  const sub = await readSigned(cookieValue(cookieHeader, SESSION_COOKIE), secret);
  return sub ? { sub } : null;
}

/**
 * The CSRF token for one session acting on one knock. Bound to the session
 * value, so a token cannot outlive the login that minted it, and to the user
 * code, so a token gathered from the code-entry page cannot approve a knock.
 * The parts are length-prefixed: no choice of code can impersonate a session.
 */
export function csrfFor(sessionValue: string, userCode: string, secret: string): Promise<string> {
  return hmac(secret, `gate-csrf.${sessionValue.length}.${sessionValue}.${userCode}`);
}
