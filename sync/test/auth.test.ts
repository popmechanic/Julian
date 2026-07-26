import { describe, expect, test } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { verifyWithKeySet } from '../src/auth';

const ISSUER = 'https://clerk.test';

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return { privateKey, keySet: createLocalJWKSet({ keys: [jwk] }) };
}

async function sign(privateKey: CryptoKey, opts: { iss?: string; expOffset?: number } = {}) {
  return new SignJWT({ sub: 'user_marcus' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expOffset ?? 3600))
    .sign(privateKey);
}

describe('verifyWithKeySet', () => {
  test('valid token → sub', async () => {
    const { privateKey, keySet } = await makeKeys();
    expect(await verifyWithKeySet(await sign(privateKey), keySet, ISSUER)).toEqual({ sub: 'user_marcus' });
  });
  test('expired token → null', async () => {
    const { privateKey, keySet } = await makeKeys();
    expect(await verifyWithKeySet(await sign(privateKey, { expOffset: -7200 }), keySet, ISSUER)).toBeNull();
  });
  test('wrong issuer → null', async () => {
    const { privateKey, keySet } = await makeKeys();
    expect(await verifyWithKeySet(await sign(privateKey, { iss: 'https://evil.test' }), keySet, ISSUER)).toBeNull();
  });
  test('garbage token → null', async () => {
    const { keySet } = await makeKeys();
    expect(await verifyWithKeySet('not-a-jwt', keySet, ISSUER)).toBeNull();
  });
});
