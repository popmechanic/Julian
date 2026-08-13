import { describe, expect, test } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import type { KeyLike } from 'jose';
import { verifyWithKeySet, timingSafeEqual } from './auth';

const ISSUER = 'https://soul.test';
const AUDIENCE = 'julian-app';

async function keySet() {
  const pair = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return { privateKey: pair.privateKey as KeyLike, keySet: createLocalJWKSet({ keys: [jwk] }) };
}

function sign(
  privateKey: KeyLike,
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; exp?: number } = {},
) {
  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt();
  if (opts.issuer !== undefined) builder = builder.setIssuer(opts.issuer);
  if (opts.audience !== undefined) builder = builder.setAudience(opts.audience);
  if (opts.exp !== undefined) builder = builder.setExpirationTime(opts.exp);
  else builder = builder.setExpirationTime(Math.floor(Date.now() / 1000) + 3600);
  return builder.sign(privateKey);
}

describe('verifyWithKeySet', () => {
  test('returns sub and exp matching the signed claims', async () => {
    const { privateKey, keySet: ks } = await keySet();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await sign(privateKey, { sub: 'user_marcus' }, { issuer: ISSUER, audience: AUDIENCE, exp });
    const claims = await verifyWithKeySet(token, ks, ISSUER, AUDIENCE);
    expect(claims).toEqual({ sub: 'user_marcus', exp });
  });

  test('wrong issuer -> null', async () => {
    const { privateKey, keySet: ks } = await keySet();
    const token = await sign(privateKey, { sub: 'user_marcus' }, { issuer: 'https://other.test', audience: AUDIENCE });
    expect(await verifyWithKeySet(token, ks, ISSUER, AUDIENCE)).toBeNull();
  });

  test('wrong audience when audience passed -> null', async () => {
    const { privateKey, keySet: ks } = await keySet();
    const token = await sign(privateKey, { sub: 'user_marcus' }, { issuer: ISSUER, audience: 'someone-else' });
    expect(await verifyWithKeySet(token, ks, ISSUER, AUDIENCE)).toBeNull();
  });

  test('missing exp claim -> null', async () => {
    const { privateKey, keySet: ks } = await keySet();
    const token = await new SignJWT({ sub: 'user_marcus' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .sign(privateKey);
    expect(await verifyWithKeySet(token, ks, ISSUER, AUDIENCE)).toBeNull();
  });

  test('missing sub -> null', async () => {
    const { privateKey, keySet: ks } = await keySet();
    const token = await sign(privateKey, {}, { issuer: ISSUER, audience: AUDIENCE });
    expect(await verifyWithKeySet(token, ks, ISSUER, AUDIENCE)).toBeNull();
  });
});

describe('timingSafeEqual', () => {
  test('equal strings are true', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });
  test('differing strings are false', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
  });
  test('empty strings are false', () => {
    expect(timingSafeEqual('', '')).toBe(false);
  });
  test('different-length strings are false', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
