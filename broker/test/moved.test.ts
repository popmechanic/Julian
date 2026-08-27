// broker/test/moved.test.ts — the old gate answers 410 when MOVED_TO is set.
//
// The gate has no assets layer: every path here is worker-routed, so the
// kill-switch is total. The DO bindings stay in wrangler.toml, so the governor
// and registrar storage sit untouched beneath the signpost.
import { describe, expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/env';

const MOVED = 'https://gate.julian.soul.store';

describe('MOVED_TO kill-switch', () => {
  test('any path answers 410 naming the new house; nothing else runs', async () => {
    const testEnv = { ...(env as unknown as Env), MOVED_TO: MOVED };
    for (const path of ['/device', '/mcp', '/introspect', '/approve', '/anything']) {
      const res = await worker.fetch(new Request(`https://gate.test${path}`, { method: 'POST' }), testEnv);
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: string; moved_to: string; message: string };
      expect(body).toEqual({
        error: 'gone',
        moved_to: MOVED,
        message: `this house has moved — use ${MOVED}`,
      });
    }
  });

  test('the signpost precedes discovery: even the unauthenticated well-knowns are gone', async () => {
    const testEnv = { ...(env as unknown as Env), MOVED_TO: MOVED };
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await worker.fetch(new Request(`https://gate.test${path}`), testEnv);
      expect(res.status).toBe(410);
    }
  });

  test('the signpost precedes auth: no 401 challenge escapes ahead of it', async () => {
    const testEnv = { ...(env as unknown as Env), MOVED_TO: MOVED };
    const res = await worker.fetch(new Request('https://gate.test/mcp', { method: 'POST' }), testEnv);
    expect(res.status).toBe(410);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  test('an empty MOVED_TO is not a signpost — the switch is set-or-nothing', async () => {
    const testEnv = { ...(env as unknown as Env), MOVED_TO: '' };
    const res = await worker.fetch(new Request('https://gate.test/definitely-not-a-route'), testEnv);
    expect(res.status).not.toBe(410);
  });

  test('unset MOVED_TO leaves normal behavior untouched', async () => {
    const res = await worker.fetch(new Request('https://gate.test/definitely-not-a-route'), env as unknown as Env);
    expect(res.status).not.toBe(410);
  });
});
