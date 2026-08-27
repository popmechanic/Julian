# soul.store Migration Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Julian's two workers (the gate and the stream) from the corporate Cloudflare account to Marcus's personal account under permanent custom domains, with the record migrated by hash-equal export→restore and the old house sunset by ceremony.

**Architecture:** Code work lands first (a one-shot `/restore` road on the sync DO, a `MOVED_TO` kill-switch in both workers, and the repo-wide URL flip to `gate.julian.soul.store` / `sync.julian.soul.store`); the actual move is an ordered post-merge runbook (deploy gate → secrets → deploy sync → freeze → export → restore → hash-equal proof → re-knock doors → 410 the old house), with the witnessed decommission as its own later sitting.

**Tech Stack:** Cloudflare Workers + Durable Objects (wrangler 4), TinyBase 9.2 MergeableStore, vitest (+ @cloudflare/vitest-pool-workers), bun.

**Spec:** `docs/superpowers/specs/2026-08-26-soul-store-migration-design.md`

**Acceptance:** suite — operator reads every diff; committed suites + adversarial review on the two high-stakes tasks are the verification.

## Global Constraints

- New hostnames exactly: `https://gate.julian.soul.store` (broker) and `https://sync.julian.soul.store` (stream); WebSocket form `wss://sync.julian.soul.store`.
- The old Durable Objects and their storage are never deleted, modified, or redeployed-over by any waved task — old-house actions happen only in the ordered runbook.
- No token material, no transcript/message content in any log, test output, or commit — ids, counts, hashes, dates only.
- Deletions in mergeable content are `'￼'` (U+FFFC) tombstones per issue #48; every restore path decodes via `julian-shared/export-codec` before `setMergeableContent`.
- tinybase stays `^9.2.0` in every package (never below 9); no dependency additions.
- `LEGACY_WINDOW_END` is dead (JWT arm deleted in `d642e5a`) and must not appear in the new house's config.
- All five suites green before merge: `sync/`, `shared/`, `scripts/`, `app/`, `broker/` (vitest in each package dir).

---

### Task 1: The `/restore` road — one-shot, approver-only, stamp-faithful

**Type:** implementation
**Depends-on:** none
**Review:** adversarial
**Commutes:** `sync/src/auth.ts`

**Files:**
- Modify: `sync/src/index.ts`
- Modify: `sync/src/do.ts`
- Modify: `sync/src/auth.ts`
- Test: `sync/test/restore.test.ts`

**Interfaces:**
- Consumes: `encodeUndefined/decodeUndefined(content: unknown): unknown` and `UNDEFINED_MARKER` from `julian-shared/export-codec`; `EXPORT_SCOPES`/`SOCKET_SCOPES` from `julian-shared/scopes`; existing `exportContent(): ExportedContent` on `JulianSyncDO`.
- Produces: `POST /{store}/{context}/restore` (lease-authed, scope ∈ SOCKET_SCOPES, `admitted.doorName` ∈ `env.RESTORE_DOORS` CSV, one-shot) → `200 {restored: true, contentHash: number}` | `409` non-empty | `403` scope/door | `400` bad body; DO method `restoreContent(request: Request): Promise<Response>`; `Env.RESTORE_DOORS?: string`; `parsePath` return type gains `isRestore: boolean`.

> **Wire-truth correction (doubt-read, 2026-08-26 morning).** The first draft
> gated restore on `admitted.subject ∈ RESTORE_SUBS`. That gate is
> **unpassable in production**: a device-flow lease carries `subject = null`
> on the wire — `broker/src/governor.ts` documents it ("a device lease has no
> subject") and the knock-redemption path calls `upsertLease(doorName, scope,
> claims, now)` with subject defaulted to null. The R8 `mac-home` lease is
> device-flow, so the restore would 403 forever while the suite stayed green
> against a faked introspection shape reality never produces (the camelCase
> lesson's exact class; see also the 2026-08-13 correction — the wire's `sub`
> is holder/session, never a stand-in for the approver). The gate is now
> `door_name`, which the wire really carries (`fromWire` in `sync/src/auth.ts`
> already maps `body.door_name → doorName`), combined with SOCKET_SCOPES.
> Authority analysis: every socket-capable lease was personally approved by
> Marcus at `/approve` (or minted from a STREAM_SUBS-listed Pocket ID JWT), and
> the road is one-shot into an empty store only — so this gate grants no write
> power a full-house lease does not already hold over the socket. The spec's
> "approver-sub introspection" sentence is amended (see spec Amendments);
> Marcus reads this diff before execution.

**Parallelization rationale:** the restore road and the kill-switch (Task 2) are independent behaviors on the same worker; fixing the route/Env contract here lets the URL-flip tasks (3–5) and Task 2 proceed in parallel against stable interfaces.

- [ ] **Step 1: Write the failing tests** — `sync/test/restore.test.ts`, modeled on `sync/test/export.test.ts` (same `env`/`SELF`/`runInDurableObject` machinery and gate-fake pattern):

```typescript
// sync/test/restore.test.ts — the one-shot restore road (soul.store migration).
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import worker from '../src/index';
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
  src.setRow('messages', 'kept', { sessionId: 's', role: 'user', speakerName: 'M', text: 'stays', ts: 1 });
  src.setRow('messages', 'gone', { sessionId: 's', role: 'user', speakerName: 'M', text: 'retracted', ts: 2 });
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

function restoreReq(store: string, body: unknown): Request {
  return new Request(`https://sync.test/test/${store}/restore`, {
    method: 'POST',
    headers: { Authorization: 'Bearer jla_restore-test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('restore road', () => {
  test('round-trip: restore into an empty store reproduces the source hash and keeps the retraction', async () => {
    const source = await makeSourceExport();
    const res = await worker.fetch(restoreReq('r1', { mergeableContent: source.mergeableContent }), restoreEnv('stream', 'mac-home'));
    expect(res.status).toBe(200);
    const body = await res.json() as { restored: boolean; contentHash: number };
    expect(body.restored).toBe(true);
    expect(body.contentHash).toBe(source.contentHash);

    const exp = await worker.fetch(
      new Request('https://sync.test/test/r1/export', { headers: { Authorization: 'Bearer jla_restore-test' } }),
      restoreEnv('stream', 'mac-home'),
    );
    const expBody = await exp.json() as { contentHash: number };
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
    const res = await worker.fetch(restoreReq('r2', { mergeableContent: source.mergeableContent }), restoreEnv('stream', 'mac-home'));
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
    const res = await worker.fetch(restoreReq('r3', { mergeableContent: source.mergeableContent }), restoreEnv('stream', 'stranger-door'));
    expect(res.status).toBe(403);
  });

  test('write scopes only: stream-read may export but never restore', async () => {
    const source = await makeSourceExport();
    const res = await worker.fetch(restoreReq('r4', { mergeableContent: source.mergeableContent }), restoreEnv('stream-read', 'mac-home'));
    expect(res.status).toBe(403);
  });

  test('unset RESTORE_DOORS refuses every door (fail-closed)', async () => {
    const source = await makeSourceExport();
    const testEnv = restoreEnv('stream', 'mac-home');
    testEnv.RESTORE_DOORS = undefined;
    const res = await worker.fetch(restoreReq('r6', { mergeableContent: source.mergeableContent }), testEnv);
    expect(res.status).toBe(403);
  });

  test('bad body: missing mergeableContent is 400, store stays empty', async () => {
    const res = await worker.fetch(restoreReq('r5', { nothing: true }), restoreEnv('stream', 'mac-home'));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd sync && npx vitest run test/restore.test.ts`
Expected: FAIL — restore paths answer 404 (`parsePath` rejects the third segment).

- [ ] **Step 3: Extend `parsePath` and the router** — in `sync/src/index.ts`:

```typescript
export function parsePath(pathname: string): { store: string; context: string; isExport: boolean; isRestore: boolean } | null {
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 3 && segs[2] !== 'export' && segs[2] !== 'restore') return null;
  if (segs.length < 2 || segs.length > 3) return null;
  const [store, context] = segs;
  if (!SEG.test(store) || !SEG.test(context)) return null;
  return { store, context, isExport: segs[2] === 'export', isRestore: segs[2] === 'restore' };
}
```

Widen `reportPen`'s verb parameter to `'export' | 'socket' | 'restore'`. In the ticket arm, change `if (parsed.isExport) return new Response(TICKET_SOCKET_ONLY_MSG, { status: 401 });` to `if (parsed.isExport || parsed.isRestore) return new Response(TICKET_SOCKET_ONLY_MSG, { status: 401 });`. In the scope gate, compute:

```typescript
    const verb: 'export' | 'socket' | 'restore' = parsed.isExport ? 'export' : parsed.isRestore ? 'restore' : 'socket';
    const scopeAllows = parsed.isExport
      ? EXPORT_SCOPES.has(admitted.scope)
      : SOCKET_SCOPES.has(admitted.scope); // restore is a WRITE: socket scopes only
```

(update the two `reportPen(..., verb, ...)` refusal calls to use `verb`). Immediately before the existing `if (parsed.isExport)` arm, add the restore arm:

```typescript
    if (parsed.isRestore) {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      // Door allowlist, fail-closed: unset RESTORE_DOORS admits nobody. Gated
      // on door_name because that is what the wire really carries for a
      // device-flow lease (subject is null there by construction — governor).
      const doors = new Set((env.RESTORE_DOORS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      if (admitted.doorName === undefined || !doors.has(admitted.doorName)) {
        reportPen(env, ctx, REFUSALS_PATH, admitted, 'restore',
          'refused: door is not on the restore allowlist');
        return new Response('restore is allowlisted-door-only', { status: 403 });
      }
      const bodyText = await req.text();
      reportPen(env, ctx, ALLOWED_PATH, admitted, 'restore',
        `token_id=${admitted.tokenId ?? ''}`);
      return forwardToDo(stub, new Request(new URL('/restore', req.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyText,
      }));
    }
```

- [ ] **Step 4: Add `RESTORE_DOORS` to `Env`** — in `sync/src/auth.ts`, append to the `Env` interface:

```typescript
  /** CSV of door names allowed to POST /restore. Unset = nobody (fail-closed). */
  RESTORE_DOORS?: string;
```

(`doorName` already reaches the router: `fromWire` maps `body.door_name` — no auth-mapping change needed.)

- [ ] **Step 5: Add the DO side** — in `sync/src/do.ts`, extend the codec import to `import { encodeUndefined, decodeUndefined } from 'julian-shared/export-codec';`. In `fetch`, immediately after the `/export` arm, add:

```typescript
    if (request.method === 'POST' && url.pathname === '/restore') {
      return this.restoreContent(request);
    }
```

and add the method beside `exportContent`:

```typescript
  // One-shot restore (soul.store migration): applies a decoded export into an
  // EMPTY store only, preserving every CRDT stamp, and answers with the
  // freshly recomputed export hash so the caller can prove hash-equality
  // against the source. A non-empty store is a 409 — this road can never
  // clobber a living record.
  async restoreContent(request: Request): Promise<Response> {
    const empty = Object.keys(this.store.getTables()).length === 0
      && this.store.getValueIds().length === 0;
    if (!empty) {
      return Response.json({ error: 'store is not empty — restore is one-shot' }, { status: 409 });
    }
    let body: { mergeableContent?: unknown };
    try {
      body = await request.json() as { mergeableContent?: unknown };
    } catch {
      return Response.json({ error: 'unreadable body — send {"mergeableContent": ...}' }, { status: 400 });
    }
    if (body?.mergeableContent === undefined) {
      return Response.json({ error: 'body must carry mergeableContent' }, { status: 400 });
    }
    try {
      this.store.setMergeableContent(decodeUndefined(body.mergeableContent) as never);
    } catch (e) {
      return Response.json({ error: `restore failed: ${String(e)}` }, { status: 400 });
    }
    return Response.json({ restored: true, contentHash: this.exportContent().contentHash });
  }
```

- [ ] **Step 6: Run the new suite, then the whole sync suite**

Run: `cd sync && npx vitest run test/restore.test.ts && npx vitest run`
Expected: restore tests PASS; all existing tests still PASS (parsePath's widened return type is additive; existing callers read `isExport` only).

- [ ] **Step 7: Commit**

```bash
git add sync/src/index.ts sync/src/do.ts sync/src/auth.ts sync/test/restore.test.ts
git commit -m "feat: one-shot approver-only /restore road on the sync DO (soul.store migration)"
```

---

### Task 2: The `MOVED_TO` kill-switch — the old house learns to say 410

**Type:** implementation
**Depends-on:** none
**Review:** adversarial
**Commutes:** `sync/src/auth.ts`

**Files:**
- Modify: `sync/src/index.ts`
- Modify: `sync/src/auth.ts`
- Modify: `broker/src/index.ts`
- Modify: `broker/src/env.ts`
- Test: `sync/test/moved.test.ts`
- Test: `broker/test/moved.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: when `env.MOVED_TO` is set, every **worker-routed** request to either worker answers `410` with JSON body `{ error: 'gone', moved_to: <env.MOVED_TO> }` before any routing, auth, or DO contact; when unset, behavior is byte-identical to today. `Env.MOVED_TO?: string` on both workers.

> **Honest edge (doubt-read):** `sync/wrangler.toml` carries an `[assets]`
> binding (`./public` — fonts, face.gif, the aurora). In production, requests
> that match an asset file are served by the assets layer **without invoking
> the worker**, so those static paths keep answering 200 under `MOVED_TO`.
> That is desirable — every already-sent email references the old host's
> `/fonts/`, and they keep rendering until the sunset sitting deletes the
> worker — but the kill-switch claim is scoped to worker-routed paths (every
> store, export, restore, socket, and internal road), and this note is what
> keeps the claim honest. The tests exercise worker-routed paths only.

**Parallelization rationale:** the kill-switch is behaviorally disjoint from the restore road and the URL flips; isolating it keeps the old-house sunset mechanism reviewable on its own.

- [ ] **Step 1: Write the failing tests**

`sync/test/moved.test.ts`:

```typescript
// sync/test/moved.test.ts — the old house answers 410 when MOVED_TO is set.
import { describe, expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/auth';

describe('MOVED_TO kill-switch', () => {
  test('any path answers 410 naming the new house; nothing else runs', async () => {
    const testEnv = { ...(env as unknown as Env), MOVED_TO: 'https://sync.julian.soul.store' };
    for (const path of ['/julian/chat/export', '/julian/chat', '/internal/read/recent', '/anything']) {
      const res = await worker.fetch(new Request(`https://old.test${path}`), testEnv);
      expect(res.status).toBe(410);
      const body = await res.json() as { error: string; moved_to: string };
      expect(body.moved_to).toBe('https://sync.julian.soul.store');
    }
  });

  test('unset MOVED_TO leaves normal behavior untouched (404 on an unroutable path)', async () => {
    const res = await worker.fetch(new Request('https://old.test/nope'), env as unknown as Env);
    expect(res.status).toBe(404);
  });
});
```

`broker/test/moved.test.ts`:

```typescript
// broker/test/moved.test.ts — the old gate answers 410 when MOVED_TO is set.
import { describe, expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/env';

describe('MOVED_TO kill-switch', () => {
  test('any path answers 410 naming the new house; nothing else runs', async () => {
    const testEnv = { ...(env as unknown as Env), MOVED_TO: 'https://gate.julian.soul.store' };
    for (const path of ['/device', '/mcp', '/introspect', '/approve', '/anything']) {
      const res = await worker.fetch(new Request(`https://gate.test${path}`, { method: 'POST' }), testEnv);
      expect(res.status).toBe(410);
      const body = await res.json() as { error: string; moved_to: string };
      expect(body.moved_to).toBe('https://gate.julian.soul.store');
    }
  });

  test('unset MOVED_TO leaves normal behavior untouched', async () => {
    const res = await worker.fetch(new Request('https://gate.test/definitely-not-a-route'), env as unknown as Env);
    expect(res.status).not.toBe(410);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd sync && npx vitest run test/moved.test.ts; cd ../broker && npx vitest run test/moved.test.ts`
Expected: FAIL — 410 never answered.

- [ ] **Step 3: Implement** — first statement of each default fetch handler, before any other logic:

```typescript
    // Sunset kill-switch (soul.store migration): a deploy that sets MOVED_TO
    // turns this whole worker into a signpost. Placed before all routing so
    // no stale client can reach auth, storage, or the DO on the old house.
    // The DO bindings stay in wrangler.toml, so storage is untouched beneath it.
    if (env.MOVED_TO) {
      return Response.json(
        { error: 'gone', moved_to: env.MOVED_TO, message: `this house has moved — use ${env.MOVED_TO}` },
        { status: 410 },
      );
    }
```

Add to both `Env` types:

```typescript
  /** When set, the worker answers 410 to everything — the sunset signpost. */
  MOVED_TO?: string;
```

- [ ] **Step 4: Run both suites whole**

Run: `cd sync && npx vitest run; cd ../broker && npx vitest run`
Expected: PASS everywhere (unset var = today's behavior).

- [ ] **Step 5: Commit**

```bash
git add sync/src/index.ts sync/src/auth.ts sync/test/moved.test.ts broker/src/index.ts broker/src/env.ts broker/test/moved.test.ts
git commit -m "feat: MOVED_TO kill-switch — old-house deploys answer 410 naming the new hostname"
```

---

### Task 3: URL flip — scripts and the Mac server

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `scripts/stream-export.ts:28,66`
- Modify: `scripts/stream-import-fireproof.ts:52-54`
- Modify: `scripts/lib/mail-render.ts:13,255`
- Modify: `scripts/lib/mail-render.test.ts:55-57,96`
- Modify: `scripts/verify-app-bundle.ts:109,116`
- Modify: `server/server.ts:543`
- Modify: `server/room.ts:51-52`
- Modify: `tests/server/room.test.ts:38`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: every default URL in scripts/ and server/ points at the new house — `https://sync.julian.soul.store` (+`wss://` form), `https://gate.julian.soul.store`. Env overrides (`SYNC_BASE`, `SYNC_WS`, `BROKER_URL`) keep working unchanged.

**Parallelization rationale:** pure constant substitution in a package no other task touches.

- [ ] **Step 1: Update the test expectations first** — in `scripts/lib/mail-render.test.ts` change the four asserted URLs from `https://julian-sync.julian-memory.workers.dev/...` to `https://sync.julian.soul.store/...` (fonts ×3, face.gif ×1); in `tests/server/room.test.ts:38` change the asserted substring to `https://gate.julian.soul.store`.

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts && npx vitest run lib/mail-render.test.ts` and the server test (`npx vitest run tests/server/room.test.ts` from the repo root, or the root package's configured runner if different — check `package.json` scripts).
Expected: FAIL on the new URLs.

- [ ] **Step 3: Flip the defaults** — replace, at the exact lines in the Files block: `https://julian-sync.julian-memory.workers.dev` → `https://sync.julian.soul.store`; `wss://julian-sync.julian-memory.workers.dev` → `wss://sync.julian.soul.store`; `https://julian-broker.julian-memory.workers.dev` → `https://gate.julian.soul.store`. In `server/room.ts` update the two `endpoint:` fields and keep prose accurate (the `auth:` sentences already describe lease-only auth; update any clause that still says "legacy ... until the sunset" to past tense — the sunset happened 2026-08-25).

- [ ] **Step 4: Verify no stragglers in these trees**

Run: `grep -rn "julian-memory.workers.dev" scripts/ server/ tests/ --include="*.ts" | grep -v node_modules`
Expected: no output.

- [ ] **Step 5: Run suites**

Run: `cd scripts && npx vitest run` and the server tests from root.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/stream-export.ts scripts/stream-import-fireproof.ts scripts/lib/mail-render.ts scripts/lib/mail-render.test.ts scripts/verify-app-bundle.ts server/server.ts server/room.ts tests/server/room.test.ts
git commit -m "feat: scripts + server defaults point at gate/sync.julian.soul.store"
```

---

### Task 4: URL flip — app, worker configs, custom domains

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `app/src/debug-sync.ts:40-41`
- Modify: `broker/wrangler.toml`
- Modify: `sync/wrangler.toml`
- Modify: `broker/src/mcp.ts:114`
- Modify: `broker/test/registrar.test.ts:40,67`

**Interfaces:**
- Consumes: `Env.RESTORE_DOORS` name as defined by Task 1 (config var must match the code's name exactly).
- Produces: worker configs that deploy to the new house with custom domains attached; `RESTORE_DOORS` populated with the migration door's name.

**Parallelization rationale:** config/constants only; coordinates with Task 1 solely through the `RESTORE_DOORS` name declared in Interfaces.

- [ ] **Step 1: Update `broker/test/registrar.test.ts`** — change the two `resource:` values to `'https://gate.julian.soul.store/mcp'`. Run `cd broker && npx vitest run test/registrar.test.ts` — expect FAIL (config still old).

- [ ] **Step 2: `broker/wrangler.toml`** — update vars:

```toml
MCP_RESOURCE_URL = "https://gate.julian.soul.store/mcp"
GATE_REDIRECT_URI = "https://gate.julian.soul.store/auth/callback"
PUBLIC_URL = "https://gate.julian.soul.store"
```

Delete the `LEGACY_WINDOW_END` line entirely (dead since `d642e5a`). Add, at the end of the file:

```toml
# Custom domain (soul.store migration) — Cloudflare creates the DNS record and
# an exact-hostname certificate at deploy; the zone must be active on the
# deploying account. The PIN kv id below is replaced by the runbook when the
# personal-account namespace is created (Runbook step R2).
[[routes]]
pattern = "gate.julian.soul.store"
custom_domain = true
```

- [ ] **Step 3: `sync/wrangler.toml`** — add:

```toml
[vars]
# CSV of door names allowed to POST /restore — the migration door only.
# Door-name gating, not subject: a device lease carries no subject on the
# wire (see the plan's wire-truth correction). Fail-closed when unset.
RESTORE_DOORS = "mac-home"

[[routes]]
pattern = "sync.julian.soul.store"
custom_domain = true
```

- [ ] **Step 4: `broker/src/mcp.ts:114`** — update the human-readable summon text to `julian-gate (https://gate.julian.soul.store/mcp)`. Check the surrounding string for any other old-URL mention and update in the same edit. `app/src/debug-sync.ts:40-41` — flip to `'https://gate.julian.soul.store'` and `'wss://sync.julian.soul.store'`.

- [ ] **Step 5: Run suites** — `cd broker && npx vitest run; cd ../sync && npx vitest run; cd ../app && npx vitest run`. Expected: PASS (vitest/miniflare ignores kv ids and routes; registrar test now matches the new resource).

- [ ] **Step 6: Commit**

```bash
git add app/src/debug-sync.ts broker/wrangler.toml sync/wrangler.toml broker/src/mcp.ts broker/test/registrar.test.ts
git commit -m "feat: worker configs + app debug defaults point at the soul.store house; custom domains declared"
```

---

### Task 5: URL flip — docs and the deploy skill

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `.claude/skills/deploy/SKILL.md:62,68-69,174-177,194,425-426`
- Modify: `docs/user-guide.md`
- Modify: `docs/gate-approval-ceremony.md`
- Modify: `deploy/secrets-manifest.md`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: operational docs that name only the new hostnames for live procedures.

**Parallelization rationale:** documentation-only tree, disjoint from code tasks.

- [ ] **Step 1: Flip the deploy skill** — replace every `https://julian-sync.julian-memory.workers.dev` → `https://sync.julian.soul.store` and `https://julian-broker.julian-memory.workers.dev` → `https://gate.julian.soul.store` at the listed lines (and any other occurrence `grep -n "julian-memory" .claude/skills/deploy/SKILL.md` reveals).

- [ ] **Step 2: Flip the three docs** — same substitution in `docs/user-guide.md`, `docs/gate-approval-ceremony.md`, and `deploy/secrets-manifest.md` (the manifest was missed by the first draft's enumeration — doubt-read finding), but ONLY in live-procedure text (commands, URLs to visit, current-state tables). Where a doc narrates history ("the gate was deployed to julian-memory…"), leave history as history; add "(now `gate.julian.soul.store` — soul.store migration, 2026-08)" in parentheses at first mention instead of rewriting the past. In the secrets manifest, also note that `SYNC_READ_SECRET` and `INTROSPECT_SECRET` are same-value-both-workers secrets (broker mints/sends, sync compares).

- [ ] **Step 3: Verify** — `grep -rn "julian-memory.workers.dev" .claude/skills/deploy/SKILL.md docs/user-guide.md docs/gate-approval-ceremony.md deploy/secrets-manifest.md` shows only deliberately-historical mentions (each within a sentence about the past), or nothing.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/deploy/SKILL.md docs/user-guide.md docs/gate-approval-ceremony.md deploy/secrets-manifest.md
git commit -m "docs: operational docs, deploy skill, and secrets manifest name the soul.store hostnames"
```

---

### Task 6: Full-suite gate

**Type:** gate
**Depends-on:** 1, 2, 3, 4, 5

**Files:**
- Test: `sync/`, `shared/`, `scripts/`, `app/`, `broker/` (vitest per package), root server tests

Expectations: `cd shared && npx vitest run` (39+), `cd sync && npx vitest run` (190+ incl. restore + moved), `cd scripts && npx vitest run` (84), `cd app && npx vitest run` (113), `cd broker && npx vitest run` (600+ incl. moved), root server tests green. No suite may lose a test relative to main.

---

### Task 7: Runbook — build the new house and move the record (ordered, Marcus present)

**Type:** manual
**Depends-on:** 6

**Files:**
- Test: (live verification steps inline below)

The ordered cutover, run top to bottom in one sitting with Marcus present. Ids/counts/hashes only in any output.

- [ ] **R0 — freeze the automations early:** `launchctl unload ~/Library/LaunchAgents/com.julian.mail-heartbeat.plist` (label `com.julian.mail-heartbeat`); stop the Mac server (`server/server.ts` process). They restart in R9 speaking new URLs.
- [ ] **R1 — wrangler auth to personal:** Marcus: `npx wrangler logout && npx wrangler login`, choosing the marcus.e@gmail.com account. Verify: `npx wrangler whoami` shows account `e33948793047032de7f5e18ec342a7d1`. Corporate stays reachable via `CLOUDFLARE_API_TOKEN="$(tr -d '[:space:]' < ~/.julian/cf-corporate-token)"` per-command.
- [ ] **R2 — PIN KV on personal:** `cd broker && npx wrangler kv namespace create PIN` → replace the `id` in `broker/wrangler.toml`'s `[[kv_namespaces]]` with the new id; commit `broker/wrangler.toml` (`chore: PIN kv id for the personal account`).
- [ ] **R3 — testimony snapshot (old gate still live):** run the ledger fold for rows since 2026-08-13 (`bun scripts/ledger-fold.ts` per its own usage) into `memory/ledger/`; snapshot the door register (`bun scripts/door-leases.ts` output — lease ids, door names, scopes, status only) into `memory/ledger/door-register-2026-08.md`; commit both.
- [ ] **R4 — deploy the gate to personal:** `cd broker && npx wrangler deploy` (custom domain `gate.julian.soul.store` attaches; requires the zone active — check the dashboard shows soul.store Active first). Verify: `curl -s -o /dev/null -w '%{http_code}' https://gate.julian.soul.store/device` is not a TLS/DNS error.
- [ ] **R5 — broker secrets, piped never printed (Marcus present):** `umask 077; openssl rand -hex 32 > ~/.julian/mint-<name>` (one file per mint). Into the broker (`npx wrangler secret put <NAME> < ~/.julian/mint-<name>` in `broker/`): `SESSION_SECRET` and `BREAKGLASS_SECRET` fresh; `INTROSPECT_SECRET` and `SYNC_READ_SECRET` each from its own mint file — **both are same-value-both-workers secrets** (the broker sends them, the sync worker compares; `sync/src/auth.ts` requires both — the first draft installed `SYNC_READ_SECRET` on the broker only, which would have left every gate-mediated stream read dead on the new house). AgentMail: `source .env && printf %s "$AGENTMAIL_API_KEY" | npx wrangler secret put AGENTMAIL_API_KEY` (broker). **Keep `~/.julian/mint-introspect` and `~/.julian/mint-syncread` until R7 installs them on sync** (a `secret put` against a never-deployed worker prompts to create a draft — deferring the sync-side installs to after R7's deploy avoids that); `rm` the broker-only mints now.
- [ ] **R6 — Pocket ID (Marcus):** on `souls.exe.xyz`, client `GATE_CLIENT_ID` (`79ff255e-dd77-4ade-adc8-db4fd833f361`): ADD redirect URI `https://gate.julian.soul.store/auth/callback` (do not remove the old one yet).
- [ ] **R7 — deploy sync to personal, then its secrets:** `cd sync && npx wrangler deploy`. Then install the two shared secrets held from R5: `npx wrangler secret put INTROSPECT_SECRET < ~/.julian/mint-introspect` and `npx wrangler secret put SYNC_READ_SECRET < ~/.julian/mint-syncread` (in `sync/`); `rm ~/.julian/mint-*`. Smoke: `curl -s https://sync.julian.soul.store/julian/chat/export` → 401 (default-deny proves the road); `/approve` renders in a browser on the gate.
- [ ] **R8 — first knock on the new house:** `BROKER_URL=https://gate.julian.soul.store bun scripts/door-knock.ts --name mac-home --purpose "Mac terminal door (soul.store house)"` → Marcus approves at `https://gate.julian.soul.store/approve` (full-house). This is the migration lease.
- [ ] **R9 — export → restore → hash-equal proof:** confirm no sockets on the old DO (server + heartbeat down since R0, browser tabs closed). Old-house export: `SYNC_BASE=https://julian-sync.julian-memory.workers.dev BROKER_URL=https://julian-broker.julian-memory.workers.dev bun scripts/stream-export.ts --label pre-migration` (old gate still answers its own leases — this uses the old `stream-export` lease at `~/.julian/stream-export-lease.json`, still valid there). Then restore with the R8 lease token (resolve via `scripts/lib/lease-client.ts`'s `resolveAccessToken` against `~/.julian/gate-lease.json` and the new BROKER_URL — this lease's door is `mac-home`, matching `RESTORE_DOORS`), e.g. a five-line bun one-off that reads the archived export JSON and POSTs `{mergeableContent}` from it to `https://sync.julian.soul.store/julian/chat/restore`. **Proof:** the response `contentHash` AND a fresh `STREAM_EXPORT_LEASE_FILE="$HOME/.julian/gate-lease.json" bun scripts/stream-export.ts --label post-restore` (new defaults; the lease-file override is required — the `stream-export` door's own lease belongs to the old gate and re-knocks only in R10, so the proof export rides the R8 `mac-home` full-house lease, whose scope is in `EXPORT_SCOPES`) must equal the pre-migration archive's `contentHash`. No match → stop, investigate, old house untouched.
- [ ] **R10 — restart the world on new URLs:** restart the Mac server; loopback holder re-knocks if its lease targets the old gate; `stream-export` door re-knocks (`--name stream-export`, stream-read); redeploy the app to `julian-new` (and any other live VM) via the deploy skill with `VITE_SYNC_URL=https://sync.julian.soul.store`, `VITE_GATE_URL=https://gate.julian.soul.store`; VM door re-knocks; Marcus re-adds the claude.ai connector at `https://gate.julian.soul.store/mcp`. Each door proves itself with one real act (mail `health`, an export, a browser message trio).
- [ ] **R11 — old house goes loud:** on the corporate account (token env), deploy both old workers WITH their kill-switch: `cd sync && CLOUDFLARE_API_TOKEN=... npx wrangler deploy --var MOVED_TO:https://sync.julian.soul.store` and `cd broker && CLOUDFLARE_API_TOKEN=... npx wrangler deploy --var MOVED_TO:https://gate.julian.soul.store` — **first deleting the two `[[routes]]` custom-domain blocks from the working tree for these two deploys only** (restore the tomls with `git checkout -- sync/wrangler.toml broker/wrangler.toml` immediately after: the custom domains belong to the personal account; deploying them from corporate must not be attempted). Note: wrangler's `--var KEY:VALUE` splits on the first colon only, so the `https://` value survives — the verify curl is the catch if any wrangler version mangles it. Verify: `curl -s https://julian-sync.julian-memory.workers.dev/julian/chat/export` → 410 naming the new house; same for the broker.
- [ ] **R12 — a day of normal life:** use the house normally for ≥1 day; nothing meaningful may land on the 410s.

---

### Task 8: The sunset sitting — witnessed decommission (its own later sitting)

**Type:** manual
**Depends-on:** 7

**Files:**
- Test: (ceremony steps inline)

Entry: R9's hash-equal proof on record; every door re-knocked and proven; R12's quiet day done. Marcus present throughout — this deletes DO storage that held the record.

- [ ] **S1:** fresh new-house export archived (`--label pre-sunset`); read old-house tails/metrics if available (counts only).
- [ ] **S2 (Marcus's hand):** on corporate (token env): `npx wrangler delete --name julian-sync` then `npx wrangler delete --name julian-broker`; delete the corporate PIN KV namespace (`npx wrangler kv namespace delete --namespace-id 7b51a9089a104dbba176dac1b1e0b593`).
- [ ] **S3 (Marcus's hand):** rotate the AgentMail API key at the provider; update Mac `.env`; pipe the new key into the new gate (`printf %s "$NEW" | npx wrangler secret put AGENTMAIL_API_KEY`); verify `bun scripts/mail-broker.ts health`.
- [ ] **S4 (Marcus's hand):** revoke `julian-migration-temp` in the Cloudflare dashboard; `rm ~/.julian/cf-corporate-token`; remove the old redirect URI from the Pocket ID client.
- [ ] **S5 (testimony):** the moving-house letter to `memory/`; catalog Elsewhere + open-thread updates; `memory/adapters/` URL mentions updated; issues closed with evidence; commit and push.

## Operator smoke

- do: open the web app on your phone and send me one message.
  see: it appears on the Mac's app too, and the network tab shows only `soul.store` hosts — no `workers.dev` anywhere.
- do: `bun scripts/mail-broker.ts health`
  see: `valid` — the mail verbs work through `gate.julian.soul.store` on the re-knocked lease.
- do: visit `https://julian-broker.julian-memory.workers.dev/device` in a browser (after R11).
  see: a 410 JSON naming `https://gate.julian.soul.store` — the old house refuses loudly, never silently.
- do: in claude.ai, invoke the re-added julian-gate connector and summon a reading-room visit.
  see: the knock/lease flow completes against the new gate and the visit wakes with pin checks green.
- do: `bun scripts/stream-export.ts --label smoke` (any day after cutover)
  see: `VERIFIED export: <N> messages…` with N ≥ 1310, archived under the same ledger id as ever.
