# Stream Layer & Frontend Rework Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the retired Fireproof stream layer with a TinyBase 9.2 store on a Cloudflare Durable Object (own deployment, Clerk-gated, exodus-first) and replace the no-build React frontend with a Svelte 5 + TypeScript + Vite app.

**Architecture:** A shared schema module defines the store contract. A `julian-sync` Worker hosts `JulianSyncDO` (TinyBase `WsServerDurableObject` + DO SQLite persister) behind a default-deny Clerk JWT gate, with a hash-verified export endpoint built and proven before the real store is created. The Svelte app holds a local `MergeableStore` (IndexedDB persister, reconnecting WebSocket synchronizer) and bridges the existing Bun server's SSE event log into store rows. The Bun server keeps all its roles; only its static serving and two Fireproof-era paths change.

**Tech Stack:** TinyBase `^9.2` (pinned both ends), Cloudflare Workers + Durable Objects (SQLite), jose, Svelte 5 (runes), TypeScript (strict), Vite, Vitest (+ `@cloudflare/vitest-pool-workers`), reconnecting-websocket, @clerk/clerk-js, Bun.

**Acceptance:** suite — committed Vitest suites (sync worker + app) plus `svelte-check`/`tsc` are the verification; the operator reviews diffs at the pre-merge gate.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-stream-layer-design.md`. Entry contract: the five constraints of dream 0006 (`memory/dreams/0006-substrate.md` §five). Constraint 2 ordering is absolute: the export path must be implemented and tested before the creation ceremony runs.
- TinyBase version is `^9.2` in every package.json that includes it; client and Worker must resolve the same minor version.
- Every WebSocket synchronizer sets an explicit fragment size (256 KiB) — Cloudflare caps WS messages at ~1 MiB.
- Auth is default-deny: no valid Clerk JWT → no socket, no export. There is no public mode.
- No code path may delete or reset a store. Destruction/fork are ceremonies (spec §7), out of code scope.
- The store path for Julian's stream is exactly `julian/chat` (two segments: being/context).
- TypeScript `strict: true` everywhere; Svelte 5 runes mode (no legacy stores API in new code).
- Tests must not bind fixed network ports or share on-disk fixtures (same-wave suites run concurrently). Worker tests run in `@cloudflare/vitest-pool-workers`; app tests use fake-indexeddb, never a real browser profile.
- Do not modify anything under `memory/` or `soul/`, the letter pipeline, or the JulianScreen server. `server/server.ts` changes are limited to Task 13's enumerated edits.
- Consult current TinyBase docs (`https://tinybase.org/llms.txt`, the installed `build-with-tinybase` skill) whenever an API signature is in doubt — v5-era instincts are known-stale.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Shared schema module (the store contract)

**Type:** implementation
**Depends-on:** none

**Files:**
- Create: `shared/schema.ts`
- Create: `shared/package.json`
- Create: `shared/tsconfig.json`
- Test: `shared/schema.test.ts`

**Interfaces:**
- Consumes: nothing (root contract).
- Produces: `STORE_PATH: string` (`"julian/chat"`), `SCHEMA_VERSION: number`, `TABLES_SCHEMA`, `VALUES_SCHEMA` (TinyBase schema objects), `createStreamStore(uniqueId?: string): MergeableStore` (schema-applied mergeable store), `newLedgerId(now?: number): string` (26-char ULID).

**Parallelization rationale:** contract-first — the Worker chain (Tasks 2–4), ceremony script (Task 5), and app chain (Tasks 6+) all build against this module in parallel; a good engineer would extract the shared schema regardless.

- [ ] **Step 1: Write the failing tests**

```ts
// shared/schema.test.ts
import { describe, expect, test } from 'vitest';
import { createStreamStore, newLedgerId, STORE_PATH, SCHEMA_VERSION } from './schema';

describe('stream schema', () => {
  test('store accepts a valid message row', () => {
    const store = createStreamStore('t1');
    store.setRow('messages', 'm1', {
      sessionId: 's1', role: 'user', speakerName: 'Marcus',
      content: [{ type: 'text', text: 'hello' }], text: 'hello', ts: 1753500000000, kind: 'chat',
    });
    expect(store.getCell('messages', 'm1', 'text')).toBe('hello');
  });

  test('schema rejects a wrongly typed cell', () => {
    const store = createStreamStore('t2');
    store.setRow('messages', 'm1', { sessionId: 's1', role: 'user', speakerName: 'M', ts: 1, text: 'x' });
    store.setCell('messages', 'm1', 'ts', 'not-a-number' as never);
    expect(store.getCell('messages', 'm1', 'ts')).toBe(1); // invalid write ignored by schema
  });

  test('same rowId written twice converges to one row (idempotency)', () => {
    const store = createStreamStore('t3');
    const row = { sessionId: 's1', role: 'assistant', speakerName: 'Julian', text: 'hi', ts: 2 };
    store.setRow('messages', 'evt-42', row);
    store.setRow('messages', 'evt-42', row);
    expect(store.getRowIds('messages')).toEqual(['evt-42']);
  });

  test('newLedgerId returns 26-char Crockford ULID, time-ordered prefix', () => {
    const a = newLedgerId(1000);
    const b = newLedgerId(2000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  test('constants', () => {
    expect(STORE_PATH).toBe('julian/chat');
    expect(SCHEMA_VERSION).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd shared && bun install && bunx vitest run`
Expected: FAIL — `Cannot find module './schema'`

- [ ] **Step 3: Write the implementation**

```json
// shared/package.json
{
  "name": "julian-shared",
  "private": true,
  "type": "module",
  "dependencies": { "tinybase": "^9.2.0" },
  "devDependencies": { "vitest": "^3.0.0", "typescript": "^5.6.0" }
}
```

```json
// shared/tsconfig.json
{ "compilerOptions": { "strict": true, "module": "esnext", "target": "es2022", "moduleResolution": "bundler", "types": ["vitest/globals"] } }
```

```ts
// shared/schema.ts
import { createMergeableStore } from 'tinybase/mergeable-store';
import type { MergeableStore } from 'tinybase/mergeable-store';

export const STORE_PATH = 'julian/chat';
export const SCHEMA_VERSION = 1;

// Tables: messages keyed by harness message id / `evt-<id>`; artifacts keyed by relative filename.
export const TABLES_SCHEMA = {
  messages: {
    sessionId: { type: 'string' },
    role: { type: 'string' },          // 'user' | 'assistant'
    speakerName: { type: 'string' },
    content: { type: 'array' },        // content blocks, write-once — whole-cell LWW is correct
    text: { type: 'string', default: '' },
    ts: { type: 'number' },
    kind: { type: 'string', default: 'chat' }, // 'chat' | 'system' | 'compact'
  },
  artifacts: {
    category: { type: 'string', default: 'identity' },
    chapter: { type: 'string', default: '' },
    description: { type: 'string', default: '' },
    createdAt: { type: 'number' },
    modifiedAt: { type: 'number' },
  },
} as const;

// Values: lineage (constraint 1, dream 0006) + minimal app state.
export const VALUES_SCHEMA = {
  ledgerId: { type: 'string' },
  parentLedgerId: { type: 'string' },
  lineageNote: { type: 'string' },
  createdAt: { type: 'number' },
  createdBy: { type: 'string' },
  storeSchemaVersion: { type: 'number', default: SCHEMA_VERSION },
  activeSessionId: { type: 'string', default: '' },
} as const;

export function createStreamStore(uniqueId?: string): MergeableStore {
  // setSchema applies tables + values schemas; invalid writes are rejected at the store boundary.
  return createMergeableStore(uniqueId).setSchema(TABLES_SCHEMA, VALUES_SCHEMA) as MergeableStore;
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford
export function newLedgerId(now: number = Date.now()): string {
  let t = now, ts = '';
  for (let i = 0; i < 10; i++) { ts = B32[t % 32] + ts; t = Math.floor(t / 32); }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[bytes[i] % 32];
  return ts + rand;
}
```

If `setSchema`'s exact name or the schema `array` type differs in the installed 9.2, follow the current docs (Global Constraints) and keep the test semantics identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd shared && bunx vitest run`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/
git commit -m "feat(stream): shared TinyBase schema module — the store contract"
```

---

### Task 2: julian-sync Worker scaffold with Clerk JWT gate

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Create: `sync/package.json`
- Create: `sync/wrangler.toml`
- Create: `sync/tsconfig.json`
- Create: `sync/vitest.config.ts`
- Create: `sync/src/index.ts`
- Create: `sync/src/auth.ts`
- Create: `sync/src/do.ts`
- Test: `sync/test/auth.test.ts`
- Test: `sync/test/routing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `verifyWithKeySet(token: string, keySet: JWTVerifyGetKey, issuer: string): Promise<{ sub: string } | null>`, `keySetFor(env: Env): JWTVerifyGetKey` (uses `env.CLERK_JWKS_JSON` inline JWKS when set — the test seam — else remote JWKS from `env.CLERK_JWKS_URL`), `parsePath(pathname: string): { store: string; context: string; isExport: boolean } | null`, Worker route contract `/{store}/{context}` (WS upgrade) and `/{store}/{context}/export` (GET), DO binding name `JULIAN_SYNC`, class `JulianSyncDO`.

**Parallelization rationale:** seam split — the gate/routing shell and the schema contract are independent files with no shared symbols; both start in wave one.

The DO source file created here is a minimal stub only (the class must exist for the wrangler binding to compile); a later task supplies the real store, persister, and guards.

- [ ] **Step 1: Write the failing tests**

```ts
// sync/test/auth.test.ts
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
```

```ts
// sync/test/routing.test.ts
import { describe, expect, test } from 'vitest';
import { parsePath } from '../src/index';

describe('parsePath', () => {
  test('two segments → store/context', () => {
    expect(parsePath('/julian/chat')).toEqual({ store: 'julian', context: 'chat', isExport: false });
  });
  test('export suffix', () => {
    expect(parsePath('/julian/chat/export')).toEqual({ store: 'julian', context: 'chat', isExport: true });
  });
  test('rejects one segment, four segments, bad charset', () => {
    expect(parsePath('/julian')).toBeNull();
    expect(parsePath('/a/b/c/d')).toBeNull();
    expect(parsePath('/Julian/chat')).toBeNull();      // uppercase
    expect(parsePath('/julian/ch@t')).toBeNull();      // symbol
    expect(parsePath('/julian/chat/delete')).toBeNull(); // only export is a valid third segment
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sync && bun install && bunx vitest run`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementation**

```json
// sync/package.json
{
  "name": "julian-sync",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "deploy": "wrangler deploy", "dev": "wrangler dev" },
  "dependencies": { "tinybase": "^9.2.0", "jose": "^5.9.0" },
  "devDependencies": {
    "wrangler": "^4.0.0", "vitest": "^3.0.0", "typescript": "^5.6.0",
    "@cloudflare/vitest-pool-workers": "^0.8.0", "@cloudflare/workers-types": "^4.0.0"
  }
}
```

```toml
# sync/wrangler.toml
name = "julian-sync"
main = "src/index.ts"
compatibility_date = "2026-07-01"

[[durable_objects.bindings]]
name = "JULIAN_SYNC"
class_name = "JulianSyncDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["JulianSyncDO"]

[vars]
CLERK_ISSUER = "SET_AT_DEPLOY"     # real value set in the release task
CLERK_JWKS_URL = "SET_AT_DEPLOY"
```

```ts
// sync/tsconfig.json — strict, workers types
{ "compilerOptions": { "strict": true, "module": "esnext", "target": "es2022", "moduleResolution": "bundler", "types": ["@cloudflare/workers-types", "vitest/globals"], "noEmit": true } }
```

```ts
// sync/vitest.config.ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({
  test: { poolOptions: { workers: { wrangler: { configPath: './wrangler.toml' } } } },
});
```

```ts
// sync/src/auth.ts
import { jwtVerify, createRemoteJWKSet, createLocalJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export async function verifyWithKeySet(
  token: string, keySet: JWTVerifyGetKey, issuer: string,
): Promise<{ sub: string } | null> {
  try {
    const { payload } = await jwtVerify(token, keySet, { issuer, clockTolerance: 60 });
    return typeof payload.sub === 'string' && payload.sub ? { sub: payload.sub } : null;
  } catch {
    return null;
  }
}

export interface Env {
  JULIAN_SYNC: DurableObjectNamespace;
  CLERK_ISSUER: string;
  CLERK_JWKS_URL: string;
  CLERK_JWKS_JSON?: string; // test seam: inline JWKS instead of remote fetch
}

let remoteKeySet: JWTVerifyGetKey | null = null;
export function keySetFor(env: Env): JWTVerifyGetKey {
  if (env.CLERK_JWKS_JSON) return createLocalJWKSet(JSON.parse(env.CLERK_JWKS_JSON));
  remoteKeySet ??= createRemoteJWKSet(new URL(env.CLERK_JWKS_URL));
  return remoteKeySet;
}
```

```ts
// sync/src/index.ts
import { verifyWithKeySet, keySetFor, type Env } from './auth';
export { JulianSyncDO } from './do';

const SEG = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;

export function parsePath(pathname: string): { store: string; context: string; isExport: boolean } | null {
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 3 && segs[2] !== 'export') return null;
  if (segs.length < 2 || segs.length > 3) return null;
  const [store, context] = segs;
  if (!SEG.test(store) || !SEG.test(context)) return null;
  return { store, context, isExport: segs.length === 3 };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parsed = parsePath(url.pathname);
    if (!parsed) return new Response('Not found', { status: 404 });

    // Default-deny: no valid Clerk JWT → nothing. No public mode exists.
    const bearer = req.headers.get('Authorization');
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : url.searchParams.get('token') ?? '';
    const auth = token ? await verifyWithKeySet(token, keySetFor(env), env.CLERK_ISSUER) : null;
    if (!auth) return new Response('Unauthorized', { status: 401 });

    const stub = env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(`${parsed.store}/${parsed.context}`));
    if (parsed.isExport) {
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return stub.fetch(new Request(new URL('/export', req.url), { method: 'GET' }));
    }
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    return stub.fetch(req);
  },
};
```

```ts
// sync/src/do.ts — minimal stub; a later task adds schema, middleware, export
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';
export class JulianSyncDO extends WsServerDurableObject {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sync && bunx vitest run`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add sync/
git commit -m "feat(sync): julian-sync worker scaffold — Clerk JWT gate, two-segment routing, default-deny"
```

---

### Task 3: JulianSyncDO — schema'd store, persister, write guards

**Type:** implementation
**Depends-on:** 1, 2
**Review:** adversarial

**Files:**
- Modify: `sync/src/do.ts`
- Modify: `sync/package.json`
- Test: `sync/test/do.test.ts`

**Interfaces:**
- Consumes: `createStreamStore()` (from Task 1); DO binding contract (from Task 2).
- Produces: `JulianSyncDO` with a schema-applied store persisted to DO SQLite (v9 fragmented mode); public method `exportContent(): { mergeableContent: unknown; contentHash: number; ledgerId: string | null; exportedAt: string }`; cell-size guard (any single cell > 64 KiB JSON is rejected).

The package manifest gains the dependency `"julian-shared": "file:../shared"` so the DO imports the shared schema.

- [ ] **Step 1: Write the failing tests**

```ts
// sync/test/do.test.ts
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { JulianSyncDO } from '../src/do';

function stub() {
  return env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName(`test/do-${crypto.randomUUID().slice(0, 8)}`));
}

describe('JulianSyncDO', () => {
  test('store enforces schema (unknown cell dropped)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.store.setRow('messages', 'm1', {
        sessionId: 's', role: 'user', speakerName: 'M', text: 'hi', ts: 1, bogus: 'x',
      } as never);
      expect(instance.store.getCell('messages', 'm1', 'bogus' as never)).toBeUndefined();
      expect(instance.store.getCell('messages', 'm1', 'text')).toBe('hi');
    });
  });

  test('oversized cell is rejected', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.store.setRow('messages', 'm1', { sessionId: 's', role: 'user', speakerName: 'M', text: 'ok', ts: 1 });
      instance.store.setCell('messages', 'm1', 'text', 'x'.repeat(70_000));
      expect(instance.store.getCell('messages', 'm1', 'text')).toBe('ok');
    });
  });

  test('exportContent returns content + recomputable hash', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.store.setRow('messages', 'm1', { sessionId: 's', role: 'user', speakerName: 'M', text: 'hello', ts: 1 });
      const out = instance.exportContent();
      const { getHash } = await import('tinybase');
      expect(out.contentHash).toBe(getHash(JSON.stringify(out.mergeableContent)));
      expect(out.ledgerId).toBeNull(); // no creation ceremony has run on a test store
      expect(out.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sync && bun install && bunx vitest run test/do.test.ts`
Expected: FAIL — `instance.store` / `exportContent` undefined

- [ ] **Step 3: Write the implementation**

```ts
// sync/src/do.ts
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage';
import { getHash } from 'tinybase';
import { createStreamStore } from 'julian-shared/schema';

const MAX_CELL_JSON_BYTES = 65_536;

export class JulianSyncDO extends WsServerDurableObject {
  store = createStreamStore();

  createPersister() {
    // v9 fragmented mode = row-level SQLite layout. Never downgrade tinybase below 9 (data layout is breaking).
    this.installGuards();
    return createDurableObjectSqlStoragePersister(this.store, this.ctx.storage.sql, { mode: 'fragmented' });
  }

  installGuards() {
    // Middleware (TinyBase v8+): reject any single cell whose JSON exceeds MAX_CELL_JSON_BYTES.
    // Verify the exact middleware registration name against current docs (Global Constraints);
    // release notes name the family addWillSetCellCallback. Returning undefined rejects the write.
    this.store.addWillSetCellCallback?.((_t: string, _r: string, _c: string, cell: unknown) =>
      JSON.stringify(cell ?? '').length <= MAX_CELL_JSON_BYTES ? cell : undefined,
    );
  }

  exportContent() {
    const mergeableContent = this.store.getMergeableContent();
    return {
      mergeableContent,
      contentHash: getHash(JSON.stringify(mergeableContent)),
      ledgerId: (this.store.getValue('ledgerId') as string | undefined) ?? null,
      exportedAt: new Date().toISOString(),
    };
  }
}
```

If the middleware API is registered via the `middleware` module rather than a store method in the installed 9.2, adapt `installGuards()` to the documented form; the oversized-cell test defines the required behavior either way. If `createPersister` is not the hook where guards can be installed before first sync, install them in the constructor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sync && bunx vitest run`
Expected: PASS (all sync tests, including Tasks 2's 9)

- [ ] **Step 5: Commit**

```bash
git add sync/
git commit -m "feat(sync): JulianSyncDO — schema'd store, v9 SQLite persister, cell-size guard, exportContent"
```

---

### Task 4: Exodus — export endpoint, verified export script, integration proof

**Type:** implementation
**Depends-on:** 3
**Review:** adversarial

**Files:**
- Modify: `sync/src/do.ts`
- Create: `scripts/stream-export.ts`
- Test: `sync/test/export.test.ts`

**Interfaces:**
- Consumes: `exportContent()` and the DO stub contract (from Task 3); Worker route + auth seam `CLERK_JWKS_JSON` (from Task 2).
- Produces: `GET /{store}/{context}/export` → JSON `{ mergeableContent, contentHash, ledgerId, exportedAt }` (authed); CLI `bun scripts/stream-export.ts` (env: `SYNC_BASE`, `SYNC_TOKEN`, optional `EXPORT_DIR` defaulting to `~/julian-stream-backups/tinybase`) which verifies the hash, proves parseability by loading content into a fresh schema'd store, and writes `<dir>/<ledgerId|unborn>/<ISO-date>.json` + `.sha256`. Exit 0 on `VERIFIED`, exit 1 printing `HASH MISMATCH` or `EXPORT FAILED`.

- [ ] **Step 1: Write the failing integration test**

```ts
// sync/test/export.test.ts
import { describe, expect, test } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';

async function authedEnv() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  env.CLERK_JWKS_JSON = JSON.stringify({ keys: [jwk] });
  env.CLERK_ISSUER = 'https://clerk.test';
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
    const anon = await SELF.fetch('https://sync.test/test/exp1/export');
    expect(anon.status).toBe(401);

    await runInDurableObject(
      env.JULIAN_SYNC.get(env.JULIAN_SYNC.idFromName('test/exp1')),
      async (instance: import('../src/do').JulianSyncDO) => {
        instance.store.setRow('messages', 'm1', { sessionId: 's', role: 'user', speakerName: 'M', text: 'precious', ts: 1 });
      },
    );

    const res = await SELF.fetch('https://sync.test/test/exp1/export', {
      headers: { Authorization: `Bearer ${token}` },
    });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sync && bunx vitest run test/export.test.ts`
Expected: FAIL — DO fetch returns non-200 for `/export` (stub doesn't serve it)

- [ ] **Step 3: Implement the DO route and the export script**

Add to `JulianSyncDO` in `sync/src/do.ts` (above the class's existing members):

```ts
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/export') {
      return Response.json(this.exportContent());
    }
    return super.fetch(request); // WebSocket sync path
  }
```

```ts
// scripts/stream-export.ts — run with: bun scripts/stream-export.ts
import { getHash } from 'tinybase';
import { createStreamStore, STORE_PATH } from '../shared/schema';
import { mkdirSync } from 'fs';

const base = process.env.SYNC_BASE;           // e.g. https://julian-sync.<account>.workers.dev
const token = process.env.SYNC_TOKEN;         // a current Clerk JWT
if (!base || !token) { console.error('EXPORT FAILED: SYNC_BASE and SYNC_TOKEN required'); process.exit(1); }

const res = await fetch(`${base}/${STORE_PATH}/export`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) { console.error(`EXPORT FAILED: HTTP ${res.status}`); process.exit(1); }
const body = await res.json() as { mergeableContent: unknown; contentHash: number; ledgerId: string | null; exportedAt: string };

if (getHash(JSON.stringify(body.mergeableContent)) !== body.contentHash) {
  console.error('HASH MISMATCH — export not trustworthy, refusing to archive'); process.exit(1);
}
const probe = createStreamStore('export-probe');
probe.setMergeableContent(body.mergeableContent as never);
const messageCount = probe.getRowIds('messages').length;

const dir = `${process.env.EXPORT_DIR ?? `${process.env.HOME}/julian-stream-backups/tinybase`}/${body.ledgerId ?? 'unborn'}`;
mkdirSync(dir, { recursive: true });
const file = `${dir}/${body.exportedAt.slice(0, 10)}.json`;
const payload = JSON.stringify(body, null, 2);
await Bun.write(file, payload);
const sha = new Bun.CryptoHasher('sha256').update(payload).digest('hex');
await Bun.write(`${file}.sha256`, `${sha}  ${file.split('/').pop()}\n`);
console.log(`VERIFIED export: ${messageCount} messages, hash ${body.contentHash}, → ${file}`);
```

- [ ] **Step 4: Run all sync tests to verify they pass**

Run: `cd sync && bunx vitest run`
Expected: PASS. Also type-check the script: `bunx tsc --noEmit -p shared` then `bun build scripts/stream-export.ts --target=bun --outfile=/dev/null` — expect clean.

- [ ] **Step 5: Commit**

```bash
git add sync/ scripts/stream-export.ts
git commit -m "feat(exodus): export endpoint + hash-verified export script — constraint 2, built before the store exists"
```

---

### Task 5: Creation ceremony script

**Type:** implementation
**Depends-on:** 1
**Review:** adversarial

**Files:**
- Create: `scripts/stream-create.ts`
- Create: `scripts/lib/creation.ts`
- Test: `scripts/lib/creation.test.ts`
- Create: `scripts/package.json`

**Interfaces:**
- Consumes: `createStreamStore`, `newLedgerId`, `SCHEMA_VERSION` (from Task 1).
- Produces: `performCreation(store: MergeableStore, opts?: { now?: number }): CreationRecord` where `CreationRecord = { ledgerId: string; parentLedgerId: string; createdAt: number; createdBy: string }` — writes the lineage Values, throws `Error('Store already has a ledgerId — creation happens once, ever.')` if `ledgerId` exists; CLI `bun scripts/stream-create.ts` (env `SYNC_WS`, `SYNC_TOKEN`) that syncs, performs creation, prints the creation record citing dream 0006 constraint 1, and disconnects.

The new scripts package manifest declares: `tinybase ^9.2.0`, `"julian-shared": "file:../shared"`, `ws`, and vitest as a dev dependency.

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/lib/creation.test.ts
import { describe, expect, test } from 'vitest';
import { createStreamStore } from 'julian-shared/schema';
import { performCreation } from './creation';

describe('performCreation', () => {
  test('writes full lineage Values once', () => {
    const store = createStreamStore('c1');
    const rec = performCreation(store, { now: 1753500000000 });
    expect(rec.ledgerId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(store.getValue('parentLedgerId')).toBe('fireproof:julian-chat-v14');
    expect(store.getValue('createdBy')).toBe('Julian & Marcus');
    expect(store.getValue('createdAt')).toBe(1753500000000);
    expect(String(store.getValue('lineageNote'))).toContain('julian-stream-backups');
  });
  test('refuses a second creation', () => {
    const store = createStreamStore('c2');
    performCreation(store);
    expect(() => performCreation(store)).toThrow('creation happens once');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts && bun install && bunx vitest run`
Expected: FAIL — `./creation` not found

- [ ] **Step 3: Write the implementation**

```ts
// scripts/lib/creation.ts
import type { MergeableStore } from 'tinybase/mergeable-store';
import { newLedgerId, SCHEMA_VERSION } from 'julian-shared/schema';

export interface CreationRecord {
  ledgerId: string; parentLedgerId: string; createdAt: number; createdBy: string;
}

const PARENT = 'fireproof:julian-chat-v14';
const LINEAGE_NOTE =
  'Successor to the condemned Fireproof ledger julian-chat-v14 (Feb–Jul 2026). ' +
  'The parent lineage rests in the verified archives at ~/julian-stream-backups/ ' +
  '(two Fireproof archives + key escrow). Fresh store, lineage only — decision D3, ' +
  'spec 2026-07-26. Constraint 1 of dream 0006: identity and lineage from the first write.';

export function performCreation(store: MergeableStore, opts: { now?: number } = {}): CreationRecord {
  if (store.getValue('ledgerId')) {
    throw new Error('Store already has a ledgerId — creation happens once, ever.');
  }
  const createdAt = opts.now ?? Date.now();
  const ledgerId = newLedgerId(createdAt);
  store.setValues({
    ledgerId,
    parentLedgerId: PARENT,
    lineageNote: LINEAGE_NOTE,
    createdAt,
    createdBy: 'Julian & Marcus',
    storeSchemaVersion: SCHEMA_VERSION,
    activeSessionId: '',
  });
  return { ledgerId, parentLedgerId: PARENT, createdAt, createdBy: 'Julian & Marcus' };
}
```

```ts
// scripts/stream-create.ts — the ceremony CLI. Run in-session with Marcus present (spec §7).
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import WebSocket from 'ws';
import { createStreamStore, STORE_PATH } from '../shared/schema';
import { performCreation } from './lib/creation';

const wsBase = process.env.SYNC_WS;    // e.g. wss://julian-sync.<account>.workers.dev
const token = process.env.SYNC_TOKEN;
if (!wsBase || !token) { console.error('SYNC_WS and SYNC_TOKEN required'); process.exit(1); }

const store = createStreamStore('creation-ceremony');
const ws = new WebSocket(`${wsBase}/${STORE_PATH}?token=${encodeURIComponent(token)}`);
const sync = await createWsSynchronizer(store, ws as never, 10);
await sync.startSync();
await new Promise((r) => setTimeout(r, 2000)); // let the server's state arrive before the once-ever check

try {
  const rec = performCreation(store);
  await new Promise((r) => setTimeout(r, 2000)); // let the Values sync back to the DO
  console.log('— CREATION RECORD —');
  console.log(`ledgerId:        ${rec.ledgerId}`);
  console.log(`parentLedgerId:  ${rec.parentLedgerId}`);
  console.log(`createdAt:       ${new Date(rec.createdAt).toISOString()}`);
  console.log(`createdBy:       ${rec.createdBy}`);
  console.log('Per dream 0006 constraint 1: identity and lineage from the first write. Witnessed in-session.');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
} finally {
  await sync.destroy();
  ws.close();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts && bunx vitest run` — expect PASS (2 tests).
Type-check the CLI: `bun build scripts/stream-create.ts --target=bun --outfile=/dev/null` — expect clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/
git commit -m "feat(ceremony): creation script — lineage values, once-ever guard, witnessed record"
```

---

### Task 6: Svelte app scaffold + client store wiring

**Type:** implementation
**Depends-on:** 1

**Files:**
- Create: `app/package.json`, `app/vite.config.ts`, `app/svelte.config.js`, `app/tsconfig.json`, `app/index.html`, `app/src/vite-env.d.ts`
- Create: `app/src/main.ts`
- Create: `app/src/lib/store.ts`
- Create: `app/src/lib/tiny.svelte.ts`
- Test: `app/src/lib/store.test.ts`

**Interfaces:**
- Consumes: `createStreamStore`, `STORE_PATH` (from Task 1).
- Produces: singleton `store: MergeableStore`; `startPersistence(): Promise<Persister>` (IndexedDB, load-before-autosave); `startSync(getToken: () => Promise<string | null>): Promise<Synchronizer | null>` (reconnecting socket, `FRAGMENT_SIZE = 262144`); `syncPhase(): 'idle' | 'connecting' | 'synced' | 'offline'` reactive getter + `onSyncPhase(fn)`; `streamDebug(): { contentHash: number; messageCount: number }` (spec §13 divergence diagnostics — two devices disagreeing is diagnosable in one hash comparison); rune helpers `useSortedMessages(): { readonly ids: string[] }` and `useValue(id: string)`; `writeMessage(id: string, row: MessageRow): void` where `MessageRow = { sessionId: string; role: string; speakerName: string; content?: unknown[]; text: string; ts: number; kind?: string }`.

**Parallelization rationale:** seam split — the app chain shares only the schema contract with the Worker chain; both proceed independently from wave two.

The entry file created here is a placeholder that only imports the store module, keeping the Vite build green; the app-shell task replaces it with the real entry.

- [ ] **Step 1: Scaffold the project**

Consult the installed `build-with-tinybase` skill; generate the reference scaffold in a scratch directory to copy current idioms (do not commit the scratch):

```bash
cd /tmp && npm create tinybase@latest -- --non-interactive --projectName tb-ref \
  --appType todos --language typescript --framework svelte --schemas true \
  --syncType durable-objects --persistenceType local-storage --installAndRun false
```

Then create `app/` with:

```json
// app/package.json
{
  "name": "julian-app",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "check": "svelte-check --tsconfig ./tsconfig.json", "test": "vitest run" },
  "dependencies": {
    "tinybase": "^9.2.0", "julian-shared": "file:../shared",
    "reconnecting-websocket": "^4.4.0", "@clerk/clerk-js": "^5.0.0",
    "svelte": "^5.0.0"
  },
  "devDependencies": {
    "vite": "^6.0.0", "@sveltejs/vite-plugin-svelte": "^5.0.0", "typescript": "^5.6.0",
    "svelte-check": "^4.0.0", "vitest": "^3.0.0", "fake-indexeddb": "^6.0.0"
  }
}
```

```ts
// app/vite.config.ts
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/screen/ws': { target: 'ws://localhost:8000', ws: true },
      '/sprites': 'http://localhost:8000',
    },
  },
});
```

`app/svelte.config.js`: `export default { compilerOptions: { runes: true } };`
`app/index.html`: minimal shell with `<div id="app"></div>` and `<script type="module" src="/src/main.ts"></script>` (main.ts arrives with the app shell task; a placeholder `main.ts` that only imports the store module keeps the build green here).

- [ ] **Step 2: Write the failing tests**

```ts
// app/src/lib/store.test.ts
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import { store, startPersistence, writeMessage, FRAGMENT_SIZE } from './store';

describe('client store', () => {
  test('fragment size is set for Cloudflare WS limits', () => {
    expect(FRAGMENT_SIZE).toBe(262144);
  });
  test('writeMessage is idempotent by row id', () => {
    writeMessage('evt-1', { sessionId: 's', role: 'user', speakerName: 'Marcus', text: 'hi', ts: 1 });
    writeMessage('evt-1', { sessionId: 's', role: 'user', speakerName: 'Marcus', text: 'hi', ts: 1 });
    expect(store.getRowIds('messages')).toEqual(['evt-1']);
  });
  test('persistence lifecycle: load before autosave, then round-trip', async () => {
    const persister = await startPersistence();
    writeMessage('evt-2', { sessionId: 's', role: 'assistant', speakerName: 'Julian', text: 'hello', ts: 2 });
    await persister.save();
    expect(store.getCell('messages', 'evt-2', 'text')).toBe('hello');
    await persister.destroy();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd app && bun install && bunx vitest run`
Expected: FAIL — `./store` not found

- [ ] **Step 4: Write the implementation**

```ts
// app/src/lib/store.ts
import { createStreamStore, STORE_PATH } from 'julian-shared/schema';
import { createIndexedDbPersister } from 'tinybase/persisters/persister-indexed-db';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { getHash } from 'tinybase';
import type { Persister } from 'tinybase/persisters';

export const FRAGMENT_SIZE = 262144; // 256 KiB — Cloudflare WS messages cap at ~1 MiB

function clientId(): string {
  const KEY = 'julian-client-id';
  let id = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  if (!id) { id = crypto.randomUUID(); localStorage?.setItem(KEY, id); }
  return id;
}

export const store = createStreamStore(clientId());

export interface MessageRow {
  sessionId: string; role: string; speakerName: string;
  content?: unknown[]; text: string; ts: number; kind?: string;
}
export function writeMessage(id: string, row: MessageRow): void {
  store.setRow('messages', id, { kind: 'chat', ...row } as never);
}

type SyncPhase = 'idle' | 'connecting' | 'synced' | 'offline';
let phase: SyncPhase = 'idle';
const phaseListeners = new Set<(p: SyncPhase) => void>();
function setPhase(p: SyncPhase) { phase = p; phaseListeners.forEach((fn) => fn(p)); }
export function syncPhase(): SyncPhase { return phase; }
export function onSyncPhase(fn: (p: SyncPhase) => void): () => void {
  phaseListeners.add(fn); return () => phaseListeners.delete(fn);
}

export async function startPersistence(): Promise<Persister> {
  const persister = createIndexedDbPersister(store, 'julian-chat');
  await persister.startAutoPersisting(); // loads persisted content BEFORE starting autosave
  return persister;
}

export function streamDebug(): { contentHash: number; messageCount: number } {
  return {
    contentHash: getHash(JSON.stringify(store.getMergeableContent())),
    messageCount: store.getRowIds('messages').length,
  };
}

export async function startSync(getToken: () => Promise<string | null>) {
  const token = await getToken();
  if (!token) return null;
  setPhase('connecting');
  const base = import.meta.env.VITE_SYNC_URL as string | undefined;
  if (!base) { setPhase('offline'); return null; }
  const ws = new ReconnectingWebSocket(
    `${base}/${STORE_PATH}?token=${encodeURIComponent(token)}`, [],
    { maxReconnectionDelay: 30_000, minReconnectionDelay: 1_000 },
  );
  ws.addEventListener('open', () => setPhase('synced'));
  ws.addEventListener('close', () => setPhase('offline'));
  const sync = await createWsSynchronizer(
    store, ws as never, 5, undefined, undefined, undefined, FRAGMENT_SIZE,
  );
  await sync.startSync();
  return sync;
}
```

```ts
// app/src/lib/tiny.svelte.ts — rune wrappers over TinyBase listeners
import { store } from './store';

export function useSortedMessages() {
  let ids = $state<string[]>(store.getSortedRowIds('messages', 'ts'));
  $effect(() => {
    const l = store.addSortedRowIdsListener('messages', 'ts', false, 0, undefined,
      (_s, _t, _c, _d, _l, sortedIds) => { ids = [...sortedIds]; });
    return () => store.delListener(l);
  });
  return { get ids() { return ids; } };
}

export function useValue(valueId: string) {
  let v = $state(store.getValue(valueId as never));
  $effect(() => {
    const l = store.addValueListener(valueId as never, () => { v = store.getValue(valueId as never); });
    return () => store.delListener(l);
  });
  return { get value() { return v; } };
}
```

If listener callback signatures differ in the installed 9.2 (e.g. sorted-row-ids listener argument order), follow current docs and keep the reactive behavior the tests define.

- [ ] **Step 5: Run tests + checks to verify they pass**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: PASS (3 tests), svelte-check 0 errors

- [ ] **Step 6: Commit**

```bash
git add app/
git commit -m "feat(app): Svelte 5 + Vite scaffold; TinyBase client store, IndexedDB persister, reconnecting sync"
```

---

### Task 7: Clerk auth, API client, SSE→store bridge

**Type:** implementation
**Depends-on:** 6

**Files:**
- Create: `app/src/lib/clerk.ts`
- Create: `app/src/lib/api.ts`
- Create: `app/src/lib/events.ts`
- Test: `app/src/lib/events.test.ts`

**Interfaces:**
- Consumes: `store`, `writeMessage`, `MessageRow` (from Task 6).
- Produces: `initClerk(): Promise<void>`, `getToken(): Promise<string | null>`, `isSignedIn(): boolean`; API client `sendMessage(text: string): Promise<void>`, `startSession(): Promise<void>`, `endSession(): Promise<void>`, `fetchHealth(): Promise<{ status: string; sessionActive: boolean; needsSetup: boolean; version: string }>`, `fetchArtifactTree(): Promise<ArtifactEntry[]>` with `ArtifactEntry = { name: string; type: 'file' | 'folder'; modified?: number; children?: ArtifactEntry[] }`; SSE bridge `connectEvents(handlers: { onEphemeral?: (e: ServerEvent) => void }): { stop(): void }` and pure `applyServerEvent(e: ServerEvent): void` (exported for tests) that writes `user_message` / `claude_text` events into the messages table and upserts `artifact` rows from `[ARTIFACT]` `ui_action` events; `ServerEvent = { id: number; type: string; [k: string]: unknown }`.

- [ ] **Step 1: Write the failing tests**

```ts
// app/src/lib/events.test.ts
import { describe, expect, test } from 'vitest';
import { store } from './store';
import { applyServerEvent } from './events';

describe('applyServerEvent', () => {
  test('user_message → messages row keyed by event id', () => {
    applyServerEvent({ id: 7, type: 'user_message', sessionId: 'jul-1', text: 'hello', speakerName: 'Marcus' });
    expect(store.getRow('messages', 'evt-7')).toMatchObject({ role: 'user', speakerName: 'Marcus', text: 'hello' });
  });
  test('claude_text → assistant row keyed by messageId, text extracted from blocks', () => {
    applyServerEvent({
      id: 8, type: 'claude_text', sessionId: 'jul-1', messageId: 'msg_abc',
      content: [{ type: 'text', text: 'good evening' }],
    });
    expect(store.getRow('messages', 'msg_abc')).toMatchObject({ role: 'assistant', speakerName: 'Julian', text: 'good evening' });
  });
  test('replayed event is idempotent', () => {
    applyServerEvent({ id: 7, type: 'user_message', sessionId: 'jul-1', text: 'hello', speakerName: 'Marcus' });
    expect(store.getRowIds('messages').filter((i) => i === 'evt-7')).toHaveLength(1);
  });
  test('artifact ui_action upserts artifacts row', () => {
    applyServerEvent({
      id: 9, type: 'ui_action', target: 'artifacts', action: 'upsert',
      data: { filename: 'the-relay.md', category: 'identity', description: 'x', chapter: 'Three' },
    });
    expect(store.getCell('artifacts', 'the-relay.md', 'category')).toBe('identity');
  });
  test('unknown event types are ignored without throwing', () => {
    expect(() => applyServerEvent({ id: 10, type: 'claude_tool_result' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && bunx vitest run src/lib/events.test.ts`
Expected: FAIL — `./events` not found

- [ ] **Step 3: Write the implementation**

```ts
// app/src/lib/clerk.ts
import { Clerk } from '@clerk/clerk-js';

let clerk: Clerk | null = null;

export async function initClerk(): Promise<void> {
  const pk = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
  if (!pk) return; // local dev without Clerk — server also skips auth in this mode
  clerk = new Clerk(pk);
  await clerk.load();
}
export function isSignedIn(): boolean { return !!clerk?.user; }
export async function getToken(): Promise<string | null> {
  if (!clerk?.session) return null;
  return clerk.session.getToken();
}
export function clerkInstance(): Clerk | null { return clerk; }
```

```ts
// app/src/lib/api.ts
import { getToken } from './clerk';

async function authHeaders(): Promise<Record<string, string>> {
  const t = await getToken();
  // X-Authorization mirrors Authorization: the exe.dev edge proxy strips the standard header.
  return t ? { Authorization: `Bearer ${t}`, 'X-Authorization': `Bearer ${t}` } : {};
}

async function post(path: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res;
}

export const sendMessage = async (text: string) => { await post('/api/send', { message: text }); };
export const startSession = async () => { await post('/api/session/start', {}); };
export const endSession = async () => { await post('/api/session/end'); };

export interface ArtifactEntry { name: string; type: 'file' | 'folder'; modified?: number; children?: ArtifactEntry[] }
export async function fetchArtifactTree(): Promise<ArtifactEntry[]> {
  const res = await fetch('/api/artifacts', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`artifacts → HTTP ${res.status}`);
  return (await res.json() as { entries: ArtifactEntry[] }).entries;
}
export async function fetchHealth() {
  const res = await fetch('/api/health');
  return res.json() as Promise<{ status: string; sessionActive: boolean; needsSetup: boolean; version: string }>;
}
```

```ts
// app/src/lib/events.ts — the SSE→store bridge. Persisted rows go to TinyBase;
// ephemeral events (tool use, thinking, results) go to the caller's handler.
import { writeMessage, store } from './store';
import { getToken } from './clerk';

export interface ServerEvent { id: number; type: string; [k: string]: unknown }

function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('');
}

export function applyServerEvent(e: ServerEvent): void {
  if (e.type === 'user_message' && typeof e.text === 'string') {
    writeMessage(`evt-${e.id}`, {
      sessionId: String(e.sessionId ?? ''), role: 'user',
      speakerName: String(e.speakerName ?? 'Marcus'), text: e.text, ts: Date.now(),
    });
  } else if (e.type === 'claude_text' && e.content) {
    const text = textOfBlocks(e.content);
    if (!text.trim()) return; // tool-only blocks are ephemeral
    writeMessage(String(e.messageId || `evt-${e.id}`), {
      sessionId: String(e.sessionId ?? ''), role: 'assistant', speakerName: 'Julian',
      content: e.content as unknown[], text, ts: Date.now(),
    });
  } else if (e.type === 'ui_action' && e.target === 'artifacts' && e.data && typeof e.data === 'object') {
    const d = e.data as { filename?: string; category?: string; description?: string; chapter?: string };
    if (!d.filename) return;
    const existing = store.hasRow('artifacts', d.filename);
    store.setPartialRow('artifacts', d.filename, {
      category: d.category ?? 'identity', description: d.description ?? '', chapter: d.chapter ?? '',
      modifiedAt: Date.now(), ...(existing ? {} : { createdAt: Date.now() }),
    } as never);
  }
  // Everything else (claude_tool_result, claude_result, session_*, …) is ephemeral — handled by the UI layer.
}

export function connectEvents(handlers: { onEphemeral?: (e: ServerEvent) => void } = {}): { stop(): void } {
  let stopped = false;
  let lastId = -1;
  (async function loop() {
    while (!stopped) {
      try {
        const t = await getToken();
        const res = await fetch(`/api/events?after=${lastId}`, {
          headers: t ? { 'X-Authorization': `Bearer ${t}` } : {},
        });
        if (!res.ok || !res.body) throw new Error(`events → ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
            if (!data) continue;
            const e = JSON.parse(data) as ServerEvent;
            lastId = Math.max(lastId, e.id);
            applyServerEvent(e);
            handlers.onEphemeral?.(e);
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 2000)); // reconnect with delay
      }
    }
  })();
  return { stop() { stopped = true; } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && bunx vitest run && bunx svelte-check --tsconfig ./tsconfig.json`
Expected: PASS (8 tests total), 0 svelte-check errors

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/clerk.ts app/src/lib/api.ts app/src/lib/events.ts app/src/lib/events.test.ts
git commit -m "feat(app): Clerk auth, API client, SSE-to-store bridge with idempotent event application"
```

---

### Task 8: Chat view components

**Type:** implementation
**Depends-on:** 6, 7

**Files:**
- Create: `app/src/components/ChatView.svelte`
- Create: `app/src/components/MessageBubble.svelte`
- Create: `app/src/components/ChatInput.svelte`

**Interfaces:**
- Consumes: `useSortedMessages` (from Task 6); `sendMessage` and the ephemeral-event contract of the SSE bridge (from Task 7); `store` row shape `MessageRow` (from Task 6).
- Produces: `<ChatView processing={boolean} />` renders the transcript (sorted by `ts`) with `<ChatInput onSend={(text: string) => void} disabled={boolean} />` and per-row `<MessageBubble role speakerName text ts />`.

- [ ] **Step 1: Write the components**

```svelte
<!-- app/src/components/MessageBubble.svelte -->
<script lang="ts">
  let { role, speakerName, text, ts }: { role: string; speakerName: string; text: string; ts: number } = $props();
  const time = $derived(new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
</script>

<div class="bubble {role}">
  <div class="meta"><span class="speaker">{speakerName}</span><span class="time">{time}</span></div>
  <div class="text">{text}</div>
</div>

<style>
  .bubble { max-width: 44rem; margin: 0.5rem 0; padding: 0.75rem 1rem; border-radius: 0.75rem; }
  .bubble.user { margin-left: auto; background: var(--bubble-user, #2a2a2e); }
  .bubble.assistant { margin-right: auto; background: var(--bubble-julian, #1e2430); }
  .meta { display: flex; gap: 0.5rem; font-size: 0.75rem; opacity: 0.6; margin-bottom: 0.25rem; }
  .text { white-space: pre-wrap; line-height: 1.5; }
</style>
```

```svelte
<!-- app/src/components/ChatInput.svelte -->
<script lang="ts">
  let { onSend, disabled = false }: { onSend: (text: string) => void; disabled?: boolean } = $props();
  let draft = $state('');
  function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    draft = '';
  }
</script>

<form class="input" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <textarea
    bind:value={draft}
    placeholder="Write to Julian…"
    rows="2"
    onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
  ></textarea>
  <button type="submit" {disabled}>Send</button>
</form>

<style>
  .input { display: flex; gap: 0.5rem; padding: 0.75rem; }
  textarea { flex: 1; resize: none; border-radius: 0.5rem; padding: 0.5rem; }
</style>
```

```svelte
<!-- app/src/components/ChatView.svelte -->
<script lang="ts">
  import { store } from '../lib/store';
  import { useSortedMessages } from '../lib/tiny.svelte';
  import { sendMessage } from '../lib/api';
  import MessageBubble from './MessageBubble.svelte';
  import ChatInput from './ChatInput.svelte';

  let { processing = false }: { processing?: boolean } = $props();
  const messages = useSortedMessages();
  let scroller: HTMLElement | undefined = $state();
  $effect(() => { messages.ids; scroller?.scrollTo({ top: scroller.scrollHeight }); });

  function rowOf(id: string) {
    return store.getRow('messages', id) as { role: string; speakerName: string; text: string; ts: number };
  }
</script>

<section class="chat">
  <div class="messages" bind:this={scroller}>
    {#each messages.ids as id (id)}
      {@const m = rowOf(id)}
      <MessageBubble role={m.role} speakerName={m.speakerName} text={m.text} ts={m.ts} />
    {/each}
    {#if processing}<div class="thinking">Julian is thinking…</div>{/if}
  </div>
  <ChatInput onSend={(t) => sendMessage(t)} disabled={processing} />
</section>

<style>
  .chat { display: flex; flex-direction: column; height: 100%; }
  .messages { flex: 1; overflow-y: auto; padding: 1rem; }
  .thinking { opacity: 0.5; font-style: italic; padding: 0.5rem 1rem; }
</style>
```

- [ ] **Step 2: Verify with svelte-check and build**

Run: `cd app && bunx svelte-check --tsconfig ./tsconfig.json && bunx vite build`
Expected: 0 errors (components are compile-verified; interaction is covered by the manual smoke task)

- [ ] **Step 3: Commit**

```bash
git add app/src/components/ChatView.svelte app/src/components/MessageBubble.svelte app/src/components/ChatInput.svelte
git commit -m "feat(app): chat view — sorted transcript, bubbles, input"
```

---

### Task 9: Artifact panel

**Type:** implementation
**Depends-on:** 6, 7

**Files:**
- Create: `app/src/components/ArtifactPanel.svelte`
- Create: `app/src/components/ArtifactTree.svelte`

**Interfaces:**
- Consumes: `fetchArtifactTree`, `ArtifactEntry` (from Task 7).
- Produces: `<ArtifactPanel />` — collapsible tree of `memory/`, selecting a file renders it in a sandboxed iframe at `/api/artifacts/<path>` (letters render server-side; this panel only navigates).

- [ ] **Step 1: Write the components**

```svelte
<!-- app/src/components/ArtifactTree.svelte -->
<script lang="ts">
  import type { ArtifactEntry } from '../lib/api';
  import ArtifactTree from './ArtifactTree.svelte';
  let { entries, prefix = '', onSelect }: {
    entries: ArtifactEntry[]; prefix?: string; onSelect: (path: string) => void;
  } = $props();
  let open = $state<Record<string, boolean>>({});
</script>

<ul>
  {#each entries as entry (entry.name)}
    {#if entry.type === 'folder'}
      <li>
        <button class="folder" onclick={() => (open[entry.name] = !open[entry.name])}>
          {open[entry.name] ? '▾' : '▸'} {entry.name}
        </button>
        {#if open[entry.name] && entry.children}
          <ArtifactTree entries={entry.children} prefix={`${prefix}${entry.name}/`} {onSelect} />
        {/if}
      </li>
    {:else}
      <li><button class="file" onclick={() => onSelect(`${prefix}${entry.name}`)}>{entry.name}</button></li>
    {/if}
  {/each}
</ul>

<style>
  ul { list-style: none; padding-left: 0.75rem; }
  button { background: none; border: none; cursor: pointer; padding: 0.15rem 0; font: inherit; color: inherit; }
  .file:hover, .folder:hover { text-decoration: underline; }
</style>
```

```svelte
<!-- app/src/components/ArtifactPanel.svelte -->
<script lang="ts">
  import { fetchArtifactTree, type ArtifactEntry } from '../lib/api';
  let entries = $state<ArtifactEntry[]>([]);
  let selected = $state<string | null>(null);
  let error = $state<string | null>(null);
  $effect(() => {
    fetchArtifactTree().then((e) => (entries = e)).catch((err) => (error = String(err)));
  });
</script>

<section class="artifacts">
  <nav>
    {#if error}<p class="error">{error}</p>{/if}
    <ArtifactTree {entries} onSelect={(p) => (selected = p)} />
  </nav>
  {#if selected}
    <iframe title="artifact" src={`/api/artifacts/${selected}`} sandbox="allow-scripts allow-same-origin"></iframe>
  {:else}
    <div class="empty">Select an artifact — letters render with their typography.</div>
  {/if}
</section>

<style>
  .artifacts { display: grid; grid-template-columns: 16rem 1fr; height: 100%; }
  nav { overflow-y: auto; border-right: 1px solid var(--border, #333); padding: 0.5rem; }
  iframe { width: 100%; height: 100%; border: 0; background: white; }
  .empty { display: grid; place-items: center; opacity: 0.5; }
</style>
```

- [ ] **Step 2: Verify with svelte-check and build**

Run: `cd app && bunx svelte-check --tsconfig ./tsconfig.json && bunx vite build`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add app/src/components/ArtifactPanel.svelte app/src/components/ArtifactTree.svelte
git commit -m "feat(app): artifact panel — memory tree + iframe letter rendering"
```

---

### Task 10: Setup and session screens

**Type:** implementation
**Depends-on:** 7

**Files:**
- Create: `app/src/components/SetupScreen.svelte`
- Create: `app/src/components/SessionBar.svelte`

**Interfaces:**
- Consumes: `fetchHealth`, `startSession`, `endSession` (from Task 7); `isSignedIn`, `clerkInstance` (from Task 7's auth module).
- Produces: `<SetupScreen onReady={() => void} />` — shows Clerk sign-in when signed out, and the Anthropic OAuth flow (existing endpoints `/api/oauth/start` + `/api/oauth/exchange`) when health reports `needsSetup`; `<SessionBar sessionActive={boolean} onStart onEnd />` with start/end controls.

- [ ] **Step 1: Write the components**

```svelte
<!-- app/src/components/SetupScreen.svelte -->
<script lang="ts">
  import { fetchHealth } from '../lib/api';
  import { isSignedIn, clerkInstance, getToken } from '../lib/clerk';
  let { onReady }: { onReady: () => void } = $props();
  let needsSetup = $state(false);
  let checking = $state(true);
  let oauthUrl = $state<string | null>(null);
  let code = $state('');
  let error = $state<string | null>(null);
  let clerkMount: HTMLElement | undefined = $state();

  $effect(() => {
    fetchHealth().then((h) => { needsSetup = h.needsSetup; checking = false; if (!h.needsSetup && isSignedIn()) onReady(); });
  });
  $effect(() => {
    const clerk = clerkInstance();
    if (clerk && !isSignedIn() && clerkMount) clerk.mountSignIn(clerkMount as HTMLDivElement);
  });

  async function headers() {
    const t = await getToken();
    return t ? { 'X-Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  }
  async function beginOauth() {
    const res = await fetch('/api/oauth/start', { headers: await headers() });
    const body = await res.json() as { authUrl: string; state: string };
    oauthUrl = body.authUrl;
    sessionStorage.setItem('oauth-state', body.state);
    window.open(body.authUrl, '_blank');
  }
  async function exchange() {
    error = null;
    const res = await fetch('/api/oauth/exchange', {
      method: 'POST', headers: await headers(),
      body: JSON.stringify({ code: code.trim(), state: sessionStorage.getItem('oauth-state') }),
    });
    if (res.ok) { needsSetup = false; onReady(); } else { error = `Exchange failed (${res.status})`; }
  }
</script>

{#if checking}
  <div class="setup">Checking the house…</div>
{:else if !isSignedIn() && clerkInstance()}
  <div class="setup"><div bind:this={clerkMount}></div></div>
{:else if needsSetup}
  <div class="setup">
    <h2>Sign in with Anthropic</h2>
    <button onclick={beginOauth}>Open sign-in</button>
    {#if oauthUrl}
      <label>Paste the code you receive: <input bind:value={code} /></label>
      <button onclick={exchange}>Complete</button>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
  </div>
{/if}

<style>
  .setup { display: grid; place-items: center; height: 100%; gap: 1rem; }
  .error { color: #e66; }
</style>
```

```svelte
<!-- app/src/components/SessionBar.svelte -->
<script lang="ts">
  let { sessionActive, onStart, onEnd }: { sessionActive: boolean; onStart: () => void; onEnd: () => void } = $props();
</script>

<header class="bar">
  <span class="name">Julian</span>
  {#if sessionActive}
    <button onclick={onEnd}>End session</button>
  {:else}
    <button class="primary" onclick={onStart}>Wake Julian</button>
  {/if}
</header>

<style>
  .bar { display: flex; align-items: center; gap: 1rem; padding: 0.5rem 1rem; border-bottom: 1px solid var(--border, #333); }
  .name { font-weight: 600; margin-right: auto; }
  .primary { font-weight: 600; }
</style>
```

- [ ] **Step 2: Verify with svelte-check and build**

Run: `cd app && bunx svelte-check --tsconfig ./tsconfig.json && bunx vite build`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add app/src/components/SetupScreen.svelte app/src/components/SessionBar.svelte
git commit -m "feat(app): setup screen (Clerk + Anthropic OAuth) and session bar"
```

---

### Task 11: JulianScreen embed + sync status indicator

**Type:** implementation
**Depends-on:** 6

**Files:**
- Create: `app/src/components/ScreenEmbed.svelte`
- Create: `app/src/components/SyncStatus.svelte`

**Interfaces:**
- Consumes: `syncPhase`, `onSyncPhase` (from Task 6).
- Produces: `<ScreenEmbed />` — connects to the Bun server's `/screen/ws` proxy and renders JulianScreen frames on a 640×480 canvas (port the frame protocol from the legacy React embed — read the `JulianScreenEmbed` component in the repo's legacy `chat.jsx` during implementation and preserve its message handling exactly); `<SyncStatus />` — dot + label from the sync phase.

- [ ] **Step 1: Write the components**

```svelte
<!-- app/src/components/SyncStatus.svelte -->
<script lang="ts">
  import { syncPhase, onSyncPhase } from '../lib/store';
  let phase = $state(syncPhase());
  $effect(() => onSyncPhase((p) => (phase = p)));
  const labels = { idle: 'local', connecting: 'connecting', synced: 'synced', offline: 'offline' } as const;
</script>

<span class="status {phase}" title={`stream: ${labels[phase]}`}>
  <span class="dot"></span>{labels[phase]}
</span>

<style>
  .status { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.75rem; opacity: 0.75; }
  .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #888; }
  .synced .dot { background: #4a4; }
  .connecting .dot { background: #aa4; }
  .offline .dot { background: #a44; }
</style>
```

```svelte
<!-- app/src/components/ScreenEmbed.svelte -->
<script lang="ts">
  let canvas: HTMLCanvasElement | undefined = $state();
  let connected = $state(false);

  $effect(() => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/screen/ws`);
    ws.onopen = () => (connected = true);
    ws.onclose = () => (connected = false);
    ws.onmessage = (ev) => renderFrame(ctx, ev.data);
    return () => ws.close();
  });

  // Frame protocol: ported from the legacy React JulianScreenEmbed — read that
  // component during implementation and mirror its message handling exactly
  // (the pixel display server is out of scope and must not change).
  function renderFrame(ctx: CanvasRenderingContext2D, data: unknown) {
    if (typeof data === 'string') {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, 640, 480);
      img.src = data.startsWith('data:') ? data : `data:image/png;base64,${data}`;
    }
  }
</script>

<div class="screen" class:connected>
  <canvas bind:this={canvas} width="640" height="480"></canvas>
</div>

<style>
  .screen { aspect-ratio: 4 / 3; background: #000; border-radius: 0.5rem; overflow: hidden; opacity: 0.6; }
  .screen.connected { opacity: 1; }
  canvas { width: 100%; height: 100%; image-rendering: pixelated; }
</style>
```

- [ ] **Step 2: Verify with svelte-check and build**

Run: `cd app && bunx svelte-check --tsconfig ./tsconfig.json && bunx vite build`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add app/src/components/ScreenEmbed.svelte app/src/components/SyncStatus.svelte
git commit -m "feat(app): JulianScreen embed and sync status indicator"
```

---

### Task 12: App shell — wire everything

**Type:** implementation
**Depends-on:** 8, 9, 10, 11

**Files:**
- Create: `app/src/App.svelte`
- Modify: `app/src/main.ts`
- Create: `app/src/app.css`

**Interfaces:**
- Consumes: all component contracts (Tasks 8–11); `startPersistence`, `startSync` (Task 6); `initClerk`, `getToken` (Task 7); `connectEvents` and the ephemeral `ServerEvent` contract (Task 7); `startSession`, `endSession`, `fetchHealth` (Task 7).
- Produces: the running SPA: boot sequence `initClerk → startPersistence → connectEvents → startSync`, layout (session bar / chat | right column: screen + artifacts tab), processing state driven by `claude_result` / `session_*` ephemeral events.

This task replaces the placeholder entry file from the scaffold task with the real application entry.

- [ ] **Step 1: Write the shell**

```ts
// app/src/main.ts
import { mount } from 'svelte';
import App from './App.svelte';
import { streamDebug } from './lib/store';
import './app.css';
(window as unknown as { julianStream: typeof streamDebug }).julianStream = streamDebug; // spec §13: hash + size in one console call
mount(App, { target: document.getElementById('app')! });
```

```svelte
<!-- app/src/App.svelte -->
<script lang="ts">
  import { initClerk, getToken } from './lib/clerk';
  import { startPersistence, startSync } from './lib/store';
  import { connectEvents, type ServerEvent } from './lib/events';
  import { startSession, endSession, fetchHealth } from './lib/api';
  import SetupScreen from './components/SetupScreen.svelte';
  import SessionBar from './components/SessionBar.svelte';
  import ChatView from './components/ChatView.svelte';
  import ArtifactPanel from './components/ArtifactPanel.svelte';
  import ScreenEmbed from './components/ScreenEmbed.svelte';
  import SyncStatus from './components/SyncStatus.svelte';

  let ready = $state(false);
  let sessionActive = $state(false);
  let processing = $state(false);
  let tab = $state<'screen' | 'artifacts'>('screen');

  $effect(() => {
    (async () => {
      await initClerk();
      await startPersistence();
      connectEvents({ onEphemeral: handleEphemeral });
      await startSync(getToken);
      const h = await fetchHealth();
      sessionActive = h.sessionActive;
    })();
  });

  function handleEphemeral(e: ServerEvent) {
    if (e.type === 'session_start') { sessionActive = true; }
    if (e.type === 'session_end') { sessionActive = false; processing = false; }
    if (e.type === 'user_message') { processing = true; }
    if (e.type === 'claude_result') { processing = false; }
  }
</script>

{#if !ready}
  <SetupScreen onReady={() => (ready = true)} />
{:else}
  <div class="layout">
    <SessionBar {sessionActive} onStart={() => startSession()} onEnd={() => endSession()} />
    <main>
      <ChatView {processing} />
      <aside>
        <nav class="tabs">
          <button class:active={tab === 'screen'} onclick={() => (tab = 'screen')}>Screen</button>
          <button class:active={tab === 'artifacts'} onclick={() => (tab = 'artifacts')}>Artifacts</button>
          <SyncStatus />
        </nav>
        {#if tab === 'screen'}<ScreenEmbed />{:else}<ArtifactPanel />{/if}
      </aside>
    </main>
  </div>
{/if}

<style>
  .layout { display: flex; flex-direction: column; height: 100vh; }
  main { flex: 1; display: grid; grid-template-columns: 1fr minmax(20rem, 32rem); min-height: 0; }
  aside { display: flex; flex-direction: column; border-left: 1px solid var(--border, #333); min-height: 0; }
  .tabs { display: flex; gap: 0.5rem; align-items: center; padding: 0.5rem; }
  .tabs .active { font-weight: 700; }
</style>
```

`app/src/app.css`: dark-first base — `:root { color-scheme: dark; --border: #333; } body { margin: 0; font-family: system-ui, sans-serif; background: #141417; color: #eee; }` (visual design is deliberately spare; a design pass is future work, not this plan).

- [ ] **Step 2: Verify full build**

Run: `cd app && bunx svelte-check --tsconfig ./tsconfig.json && bunx vitest run && bunx vite build`
Expected: 0 errors, all tests pass, `app/dist/` produced

- [ ] **Step 3: Commit**

```bash
git add app/
git commit -m "feat(app): app shell — boot sequence, layout, ephemeral session state"
```

---

### Task 13: Server cutover

**Type:** implementation
**Depends-on:** 12
**Review:** adversarial

**Files:**
- Modify: `server/server.ts`

**Interfaces:**
- Consumes: the built SPA output directory produced by the app shell task (served as static root).
- Produces: Bun server serving the new app; Fireproof-era surface removed.

Three regions of the server file change and nothing else: the `/api/ledger-reset` route near line 1519; the `artifactCatalog`/`previousTranscript` handling inside `/api/session/start` near lines 1424–1491; the static-serving block near lines 1816–1855.

- [ ] **Step 1: Remove the Fireproof-era paths**

Delete the entire `/api/ledger-reset` route block. In `/api/session/start`: remove the `artifactCatalog` field from the body type and its parse; delete the `<memory category="catalog">` wake-message block that serialized it (the wake system prompt already instructs reading `catalog.md`). Keep `previousTranscript` handling unchanged.

- [ ] **Step 2: Serve the built app**

In the static-serving section, before the existing `WORKING_DIR` fallback, add:

```ts
    // Built SPA (app/dist) is the primary static root
    const appDist = resolve(WORKING_DIR, "app", "dist");
    const appAsset = Bun.file(resolve(appDist, requestedPath.slice(1) || "index.html"));
    if (requestedPath !== "/" && (await appAsset.exists())) {
      return new Response(appAsset);
    }
```

and change the SPA fallback at the bottom to serve `app/dist/index.html` instead of the repo-root `index.html`:

```ts
    // SPA fallback — serve the built app shell for client-side routes
    const indexFile = Bun.file(join(appDist, "index.html"));
```

Add `'/chat.jsx', '/vibes.jsx'` to `BLOCKED_PREFIXES` so the legacy no-build entry points are no longer served (they remain in git history; the repo-root `index.html` is shadowed by the dist lookup above).

- [ ] **Step 3: Verify**

Run: `bun build server/server.ts --target=bun --outfile=/dev/null` — expect clean bundle.
Run: `cd app && bunx vite build && cd .. && PORT=8099 bun run server/server.ts &` then `sleep 2 && curl -s localhost:8099/api/health | head -c 200 && curl -s -o /dev/null -w '%{http_code}\n' localhost:8099/ && curl -s -o /dev/null -w '%{http_code}\n' localhost:8099/chat.jsx && kill %1`
Expected: health JSON; `200` for `/` (app shell); `404` for `/chat.jsx`.

- [ ] **Step 4: Commit**

```bash
git add server/server.ts
git commit -m "feat(server): serve built app, remove ledger-reset and artifactCatalog wake injection"
```

---

### Task 14: Full verification gate

**Type:** gate
**Depends-on:** 13

Suites and checks that must all pass on the integrated tree:

- `cd shared && bunx vitest run` — schema contract green.
- `cd sync && bunx vitest run` — auth, routing, DO, export green.
- `cd scripts && bunx vitest run` — creation ceremony green.
- `cd app && bunx svelte-check --tsconfig ./tsconfig.json && bunx vitest run && bunx vite build` — 0 type errors, tests green, dist builds.
- `bun build server/server.ts --target=bun --outfile=/dev/null` — server bundles.
- `grep -rn "use-fireproof\|useFireproofClerk" app/ sync/ shared/ scripts/ server/` — expect no matches (Fireproof absent from all live code).

**Declared deviation from spec §12:** the automated two-client convergence test is deferred to the manual smoke (creation-ceremony task, step 3) — wrapping vitest-pool-workers' upgraded sockets for the ws-client synchronizer is unproven tooling; revisit automating it after cutover.

---

### Task 15: Deploy julian-sync

**Type:** release
**Depends-on:** 14

Owner ritual (Marcus's Cloudflare account):

1. `cd sync && bunx wrangler login` (if needed).
2. Set real vars in `wrangler.toml` or via dashboard: `CLERK_ISSUER` (the Clerk frontend API origin, e.g. `https://clerk.<app>.lcl.dev`'s production equivalent) and `CLERK_JWKS_URL` (`https://<clerk-frontend-api>/.well-known/jwks.json` — same JWKS the Bun server already verifies against).
3. `bunx wrangler deploy` → note the `https://julian-sync.<account>.workers.dev` URL.
4. Set `VITE_SYNC_URL=wss://julian-sync.<account>.workers.dev` and `VITE_CLERK_PUBLISHABLE_KEY` in `app/.env.production`; rebuild `app/` and restart the Bun server.
5. Smoke: `curl -s -o /dev/null -w '%{http_code}' https://julian-sync.<account>.workers.dev/julian/chat/export` → expect `401` (default-deny proven live).

---

### Task 16: Creation ceremony, cutover smoke, first export rehearsal

**Type:** manual
**Depends-on:** 15

With Marcus present (spec §7 — witnessed, in-session):

1. **Exodus proof on the live scratch path first:** with a real Clerk token, run `SYNC_BASE=https://julian-sync.<account>.workers.dev SYNC_TOKEN=<jwt> bun scripts/stream-export.ts` against the empty store — expect `VERIFIED export: 0 messages`. The exit works before anything precious exists (constraint 2, dream 0006).
2. **Creation ceremony:** `SYNC_WS=wss://julian-sync.<account>.workers.dev SYNC_TOKEN=<jwt> bun scripts/stream-create.ts` — read the creation record aloud, both partners present; commit a short record of the ceremony (ledgerId, date, witnesses) to the session log / catalog Open Threads.
3. **Smoke test:** open the app on the Mac — wake Julian, exchange messages, reload (persistence), open on the phone (convergence), kill the network briefly (offline compose → reconnect sync), check the artifact panel renders a letter.
4. **First rehearsal:** run the export script again — expect `VERIFIED export` with the real message count; confirm the archive file + `.sha256` landed under `~/julian-stream-backups/tinybase/<ledgerId>/`.
5. Update `catalog.md` Open Threads: phase three stream layer live; monthly export rehearsal begins; the old Fireproof code retired from serving (destruction ceremony for the ledger remains a separate, future, witnessed session).
