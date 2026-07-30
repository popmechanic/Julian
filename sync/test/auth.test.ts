import { describe, expect, test } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { verifyWithKeySet } from '../src/auth';

const ISSUER = 'https://soul.test';

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return { privateKey, keySet: createLocalJWKSet({ keys: [jwk] }) };
}

async function sign(privateKey: CryptoKey, opts: { iss?: string; expOffset?: number; aud?: string } = {}) {
  let jwt = new SignJWT({ sub: 'user_marcus' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expOffset ?? 3600));
  if (opts.aud) jwt = jwt.setAudience(opts.aud);
  return jwt.sign(privateKey);
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
  test('audience enforced when provided: match → sub', async () => {
    const { privateKey, keySet } = await makeKeys();
    expect(await verifyWithKeySet(await sign(privateKey, { aud: 'julian' }), keySet, ISSUER, 'julian'))
      .toEqual({ sub: 'user_marcus' });
  });
  test('audience mismatch → null', async () => {
    const { privateKey, keySet } = await makeKeys();
    expect(await verifyWithKeySet(await sign(privateKey, { aud: 'other' }), keySet, ISSUER, 'julian')).toBeNull();
  });
  test('audience required but token has none → null', async () => {
    const { privateKey, keySet } = await makeKeys();
    expect(await verifyWithKeySet(await sign(privateKey), keySet, ISSUER, 'julian')).toBeNull();
  });
});
