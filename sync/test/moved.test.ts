// sync/test/moved.test.ts — the old house answers 410 when MOVED_TO is set.
//
// Scope, stated honestly: this covers **worker-routed** paths. `sync/wrangler.toml`
// carries an `[assets]` binding (`./public`), and in production a request that
// matches an asset file is served by the assets layer without ever invoking the
// worker — so `/fonts/…`, `face.gif`, and the aurora keep answering 200 under
// MOVED_TO, which is what every already-sent email needs until the sunset
// sitting deletes the worker outright. The kill-switch claim is scoped to the
// worker's own roads: every store, export, restore, socket, and internal road.
import { describe, expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/auth';

const MOVED = 'https://sync.julian.soul.store';

describe('MOVED_TO kill-switch', () => {
  test('any path answers 410 naming the new house; nothing else runs', async () => {
    const testEnv = { ...(env as unknown as Env), MOVED_TO: MOVED };
    for (const path of ['/julian/chat/export', '/julian/chat', '/internal/read/recent', '/anything']) {
      const res = await worker.fetch(new Request(`https://old.test${path}`), testEnv);
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: string; moved_to: string; message: string };
      expect(body).toEqual({
        error: 'gone',
        moved_to: MOVED,
        message: `this house has moved — use ${MOVED}`,
      });
    }
  });

  test('the signpost precedes auth: a lease-shaped credential never reaches the gate', async () => {
    // Without MOVED_TO this path would introspect against GATE, which the test
    // harness stubs to 500. A 410 here proves the switch runs first.
    const testEnv = { ...(env as unknown as Env), MOVED_TO: MOVED };
    const res = await worker.fetch(
      new Request('https://old.test/julian/chat/export', {
        headers: { Authorization: 'Bearer jla_not_a_real_token' },
      }),
      testEnv,
    );
    expect(res.status).toBe(410);
  });

  test('a socket upgrade is refused by the signpost too', async () => {
    const testEnv = { ...(env as unknown as Env), MOVED_TO: MOVED };
    const res = await worker.fetch(
      new Request('https://old.test/julian/chat?ticket=jst_whatever', {
        headers: { Upgrade: 'websocket' },
      }),
      testEnv,
    );
    expect(res.status).toBe(410);
    expect(res.webSocket).toBeFalsy();
  });

  test('an empty MOVED_TO is not a signpost — the switch is set-or-nothing', async () => {
    const testEnv = { ...(env as unknown as Env), MOVED_TO: '' };
    const res = await worker.fetch(new Request('https://old.test/nope'), testEnv);
    expect(res.status).toBe(404);
  });

  test('unset MOVED_TO leaves normal behavior untouched (404 on an unroutable path)', async () => {
    const res = await worker.fetch(new Request('https://old.test/nope'), env as unknown as Env);
    expect(res.status).toBe(404);
  });
});
