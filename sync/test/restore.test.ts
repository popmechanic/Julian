// sync/test/restore.test.ts — the one-shot restore road (soul.store migration).
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import worker from '../src/index';
import { SOCKET_REQUIRED_MSG } from 'julian-shared/scopes';
import type { Env, GateFetcher } from '../src/auth';

/**
 * A gate that vouches for a device-flow lease with the given scope and door
 * name. TRUE WIRE SHAPE: a device lease carries NO subject (governor.ts —
 * "a device lease has no subject"); the fake must not invent one, or the
 * suite passes against a shape production never produces.
 */
function gate(scope: string, doorName: string): GateFetcher {
  return {
    fetch: async (input: string | Request, init?: RequestInit) => {
      const path = new URL(typeof input === 'string' ? input : input.url).pathname;
      if (path === '/allowed' || path === '/refusals') {
        void init;
        return new Response(JSON.stringify({ recorded: true }), { status: 200 });
      }
      return new Response(JSON.stringify({
        active: true, lease_id: 'lease-restore', door_name: doorName,
        scope, principal: 'test', flow: 'device', token_id: 'tok-r',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
}

async function makeSourceExport() {
  const { createStreamStore } = await import('julian-shared/schema');
  const { encodeUndefined } = await import('julian-shared/export-codec');
  const { getHash } = await import('tinybase');
  const src = createStreamStore('restore-src');
  // The `content` array cell is REQUIRED in this fixture: the real record
  // carries one on every message, and tinybase 9.2.0's middleware breaks
  // setMergeableContent's stamp-faithfulness for array-typed cells (every
  // stamp rewritten as a fresh local write). Found live at R9 of the
  // soul.store migration — a fixture without `content` stays green while
  // production flattens provenance. Test written to reality's shape.
  src.setRow('messages', 'kept', { sessionId: 's', role: 'user', speakerName: 'M', text: 'stays', ts: 1, content: [{ type: 'text', text: 'stays' }] as never });
  src.setRow('messages', 'gone', { sessionId: 's', role: 'user', speakerName: 'M', text: 'retracted', ts: 2, content: [{ type: 'text', text: 'retracted' }] as never });
  src.delRow('messages', 'gone');
  const mergeableContent = encodeUndefined(src.getMergeableContent());
  return { mergeableContent, contentHash: getHash(JSON.stringify(mergeableContent)) };
}

function restoreEnv(scope: string, doorName: string): Env {
  const testEnv = env as unknown as Env;
  testEnv.GATE = gate(scope, doorName);
  testEnv.INTROSPECT_SECRET = 'test-secret';
  testEnv.RESTORE_DOORS = 'mac-home';
  return testEnv;
}

/**
 * One token per store, never one shared token. `introspectCache` in
 * sync/src/auth.ts is module-level and keyed by token hash for 60s, so a
 * single reused token would serve the FIRST test's gate answer to every later
 * test — a suite that proves the cache works and nothing else. (Caught here:
 * a shared token made the stream-read and stranger-door refusals both answer
 * 200 from a cached `stream`/`mac-home` verdict.)
 */
const tokenFor = (store: string): string => `jla_restore-${store}`;

function restoreReq(store: string, body: unknown): Request {
  return new Request(`https://sync.test/test/${store}/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(store)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function exportReq(store: string): Request {
  return new Request(`https://sync.test/test/${store}/export`, {
    headers: { Authorization: `Bearer ${tokenFor(store)}` },
  });
}

/**
 * Read the status AND drain the body. Draining is not optional here: a
 * response streamed back from the Durable Object holds the isolated-storage
 * stack open until it is consumed, and the pop then fails for the whole file
 * (the same trap export.test.ts records at its `consume the DO's stream`
 * line). Returning both means an assertion can never leave a body unread by
 * throwing before the drain.
 */
async function statusAndText(res: Response): Promise<{ status: number; text: string }> {
  return { status: res.status, text: await res.text() };
}

describe('restore road', () => {
  test('round-trip: restore into an empty store reproduces the source hash and keeps the retraction', async () => {
    const source = await makeSourceExport();
    const res = await statusAndText(await worker.fetch(
      restoreReq('r1', { mergeableContent: source.mergeableContent }), restoreEnv('stream', 'mac-home')));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { restored: boolean; contentHash: number };
    expect(body.restored).toBe(true);
    expect(body.contentHash).toBe(source.contentHash);

    const exp = await statusAndText(await worker.fetch(
      exportReq('r1'), restoreEnv('stream', 'mac-home')));
    expect(exp.status).toBe(200);
    const expBody = JSON.parse(exp.text) as { contentHash: number };
    expect(expBody.contentHash).toBe(source.contentHash);

    await runInDurableObject(
      env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName('test/r1')),
      async (instance: import('../src/do').JulianSyncDO) => {
        expect(instance.store.getRowIds('messages')).toEqual(['kept']);
      },
    );
  });

  test('one-shot: a non-empty store answers 409 and is not modified', async () => {
    await runInDurableObject(
      env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName('test/r2')),
      async (instance: import('../src/do').JulianSyncDO) => {
        instance.store.setRow('messages', 'pre', { sessionId: 's', role: 'user', speakerName: 'M', text: 'existing', ts: 1 });
      },
    );
    const source = await makeSourceExport();
    const res = await statusAndText(await worker.fetch(
      restoreReq('r2', { mergeableContent: source.mergeableContent }), restoreEnv('stream', 'mac-home')));
    expect(res.status).toBe(409);
    await runInDurableObject(
      env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName('test/r2')),
      async (instance: import('../src/do').JulianSyncDO) => {
        expect(instance.store.getRowIds('messages')).toEqual(['pre']);
      },
    );
  });

  test('door-gated: a door outside RESTORE_DOORS is refused 403', async () => {
    const source = await makeSourceExport();
    const res = await statusAndText(await worker.fetch(
      restoreReq('r3', { mergeableContent: source.mergeableContent }), restoreEnv('stream', 'stranger-door')));
    expect(res.status).toBe(403);
    expect(res.text).toBe('restore is allowlisted-door-only');
    // The refusal is total: nothing was written on the way to it.
    await runInDurableObject(
      env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName('test/r3')),
      async (instance: import('../src/do').JulianSyncDO) => {
        expect(instance.store.getRowIds('messages')).toEqual([]);
      },
    );
  });

  test('write scopes only: stream-read may export but never restore', async () => {
    const source = await makeSourceExport();
    const res = await statusAndText(await worker.fetch(
      restoreReq('r4', { mergeableContent: source.mergeableContent }), restoreEnv('stream-read', 'mac-home')));
    expect(res.status).toBe(403);
    // Refused by the SCOPE gate, before the door allowlist is ever consulted —
    // so the sentence is the socket-scope one, not the restore-door one.
    expect(res.text).toBe(SOCKET_REQUIRED_MSG);

    // The same lease still reads: stream-read loses restore, not export.
    const exp = await statusAndText(await worker.fetch(
      exportReq('r4'), restoreEnv('stream-read', 'mac-home')));
    expect(exp.status).toBe(200);
  });

  test('unset RESTORE_DOORS refuses every door (fail-closed)', async () => {
    const source = await makeSourceExport();
    const testEnv = restoreEnv('stream', 'mac-home');
    testEnv.RESTORE_DOORS = undefined;
    const res = await statusAndText(await worker.fetch(
      restoreReq('r6', { mergeableContent: source.mergeableContent }), testEnv));
    expect(res.status).toBe(403);
    expect(res.text).toBe('restore is allowlisted-door-only');
  });

  test('an empty RESTORE_DOORS, and a bare comma, admit nobody either', async () => {
    // The CSV is filtered, so '' and ',' produce an EMPTY door set rather than
    // a set containing the empty string — otherwise a lease whose door_name
    // never arrived would match, and the fail-closed guard would be a door.
    const source = await makeSourceExport();
    for (const doors of ['', ' , ']) {
      const testEnv = restoreEnv('stream', 'mac-home');
      testEnv.RESTORE_DOORS = doors;
      const res = await statusAndText(await worker.fetch(
        restoreReq('r7', { mergeableContent: source.mergeableContent }), testEnv));
      expect(res.status).toBe(403);
    }
  });

  test('spacing in RESTORE_DOORS is tolerated; a door listed beside others is admitted', async () => {
    const source = await makeSourceExport();
    const testEnv = restoreEnv('stream', 'mac-home');
    testEnv.RESTORE_DOORS = 'other-door, mac-home ,third-door';
    const res = await statusAndText(await worker.fetch(
      restoreReq('r8', { mergeableContent: source.mergeableContent }), testEnv));
    expect(res.status).toBe(200);
    expect((JSON.parse(res.text) as { contentHash: number }).contentHash).toBe(source.contentHash);
  });

  test('bad body: missing mergeableContent is 400, store stays empty', async () => {
    const res = await statusAndText(await worker.fetch(
      restoreReq('r5', { nothing: true }), restoreEnv('stream', 'mac-home')));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toEqual({ error: 'body must carry mergeableContent' });
    await runInDurableObject(
      env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName('test/r5')),
      async (instance: import('../src/do').JulianSyncDO) => {
        expect(instance.store.getRowIds('messages')).toEqual([]);
      },
    );
  });

  test('a ticket never opens the restore road', async () => {
    // A socket ticket is a one-shot key to exactly one door, and restore is
    // not that door. Refused by shape, before the ticket is spent.
    const res = await statusAndText(await worker.fetch(
      new Request('https://sync.test/test/r9/restore?ticket=jst_whatever', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergeableContent: [] }),
      }),
      restoreEnv('stream', 'mac-home'),
    ));
    expect(res.status).toBe(401);
    expect(res.text).toBe('a ticket opens a socket, nothing else');
  });

  test('GET on the restore road is 405, not a silent read', async () => {
    const res = await statusAndText(await worker.fetch(
      new Request('https://sync.test/test/ra/restore', {
        headers: { Authorization: `Bearer ${tokenFor('ra')}` },
      }),
      restoreEnv('stream', 'mac-home'),
    ));
    expect(res.status).toBe(405);
  });

  test('a store whose only content is a retraction answers 409 — a deletion stamp is a written record', async () => {
    // Pins the second half of the emptiness-guard comment (do.ts): the plain
    // view of this store is empty, but the stamp tree is not, and the guard
    // must read the stamp tree.
    await runInDurableObject(
      env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName('test/rb')),
      async (instance: import('../src/do').JulianSyncDO) => {
        instance.store.setRow('messages', 'gone', { sessionId: 's', role: 'user', speakerName: 'M', text: 'was here', ts: 1 });
        instance.store.delRow('messages', 'gone');
        expect(instance.store.getRowIds('messages')).toEqual([]);
      },
    );
    const source = await makeSourceExport();
    const res = await statusAndText(await worker.fetch(
      restoreReq('rb', { mergeableContent: source.mergeableContent }), restoreEnv('stream', 'mac-home')));
    expect(res.status).toBe(409);
  });

  test('a durability failure after a successful merge is 500, distinct from the 400 merge class', async () => {
    // If save() throws after setMergeableContent landed, the store is already
    // non-empty in memory: a 400 would blame the caller's body, and the
    // natural retry would answer 409 — the one-shot road spent on a storage
    // fault reported as a merge error. The two failure classes must be
    // distinguishable from the responses alone.
    await runInDurableObject(
      env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName('test/rc')),
      async (instance: import('../src/do').JulianSyncDO) => {
        // The persister object itself is frozen (TinyBase); swap the DO's
        // field reference instead — restoreContent reads `this.persister`.
        instance.persister = {
          save: async () => { throw new Error('forced durability fault'); },
        } as unknown as typeof instance.persister;
      },
    );
    const source = await makeSourceExport();
    const res = await statusAndText(await worker.fetch(
      restoreReq('rc', { mergeableContent: source.mergeableContent }), restoreEnv('stream', 'mac-home')));
    expect(res.status).toBe(500);
    expect(JSON.parse(res.text)).toEqual({
      error: 'restore merged but durability failed (Error) — verify with export before any retry',
    });
  });
});
