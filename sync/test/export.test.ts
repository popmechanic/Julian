// sync/test/export.test.ts — Exodus integration proof for the /export route.
//
// Adaptation note (kept semantics-identical to the plan): `[vars]` bindings are
// resolved by the workerd runtime, so mutating the `cloudflare:test` `env` facade
// does NOT propagate to `SELF` — the deployed worker keeps reading the wrangler.toml
// values, and `keySetFor` can never see a per-test `CLERK_JWKS_JSON` through `SELF`
// (verified: an authed `SELF.fetch` throws `Invalid URL string` on the placeholder
// `CLERK_JWKS_URL`). The gate (401 without a token) is proven through `SELF`, which
// needs no env; the authed path is proven by invoking the worker's default handler
// with the mutated `env` passed explicitly as the argument, so `keySetFor` receives
// the injected JWKS while the real DO forwarding + export path still run end-to-end.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import worker from '../src/index';
import type { Env } from '../src/auth';

async function authedEnv() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  (env as unknown as Env).CLERK_JWKS_JSON = JSON.stringify({ keys: [jwk] });
  (env as unknown as Env).CLERK_ISSUER = 'https://clerk.test';
  const token = await new SignJWT({ sub: 'user_marcus' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer('https://clerk.test').setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
  return token;
}

describe('export endpoint', () => {
  test('401 without token; verified content with token', async () => {
    const token = await authedEnv();

    // Gate: no token → 401, proven through the routed worker (SELF).
    const anon = await SELF.fetch('https://sync.test/test/exp1/export');
    expect(anon.status).toBe(401);

    // Seed the precious content into the target DO.
    await runInDurableObject(
      env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName('test/exp1')),
      async (instance: import('../src/do').JulianSyncDO) => {
        instance.store.setRow('messages', 'm1', { sessionId: 's', role: 'user', speakerName: 'M', text: 'precious', ts: 1 });
      },
    );

    // Authed: valid Clerk JWT → 200 with verified content. Direct handler
    // invocation carries the injected env so keySetFor sees the test JWKS.
    const res = await worker.fetch(
      new Request('https://sync.test/test/exp1/export', { headers: { Authorization: `Bearer ${token}` } }),
      env as unknown as Env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { mergeableContent: unknown; contentHash: number };
    const { getHash } = await import('tinybase');
    expect(getHash(JSON.stringify(body.mergeableContent))).toBe(body.contentHash);

    // Prove parseability: content round-trips into a fresh schema'd store.
    const { createStreamStore } = await import('julian-shared/schema');
    const probe = createStreamStore('probe');
    probe.setMergeableContent(body.mergeableContent as never);
    expect(probe.getCell('messages', 'm1', 'text')).toBe('precious');
  });
});
