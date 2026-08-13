// sync/test/export.test.ts — Exodus integration proof for the /export route.
//
// Adaptation note (kept semantics-identical to the plan): `[vars]`/`[[services]]`
// bindings are resolved by the workerd runtime, so mutating the `cloudflare:test`
// `env` facade does NOT propagate to `SELF` — the gate (401 without a token) is
// proven through `SELF`, which needs no env; the authed path is proven by
// invoking the worker's default handler with a mutated `env` passed explicitly
// as the argument, so the injected fake `GATE` answers the introspection while
// the real DO forwarding + export path still run end-to-end.
//
// Sync no longer verifies anything locally (no JWKS, no issuer, no audience):
// the credential here is a legacy Pocket ID JWT, and the only thing that makes
// it good is the gate's JWT arm saying so.
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import worker from '../src/index';
import type { Env, GateFetcher } from '../src/auth';

/** The gate's JWT arm, answering for a living legacy window. */
function legacyWindowGate(principal: string): GateFetcher {
  return {
    fetch: async () => new Response(JSON.stringify({
      active: true,
      lease_id: 'legacy-window-sync',
      door_name: 'legacy-window-sync',
      scope: 'stream',
      principal,
      subject: 'user_marcus',
      flow: 'legacy',
      exp: 1893456000,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  };
}

describe('export endpoint', () => {
  test('401 without token; verified content with token', async () => {
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

    // Authed: the gate vouches for the legacy session → 200 with verified
    // content. `test/exp1` is owned by principal `test`.
    const testEnv = env as unknown as Env;
    testEnv.GATE = legacyWindowGate('test');
    testEnv.INTROSPECT_SECRET = 'test-secret';

    const res = await worker.fetch(
      new Request('https://sync.test/test/exp1/export', {
        headers: { Authorization: 'Bearer eyJhbGciOi.export-legacy.sig' },
      }),
      testEnv,
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
