# Fireproof Import Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Annex the February 2026 web-chat record (1,645 messages, twenty Fireproof ledgers) into the living TinyBase stream, verified server-side per row, before the Fireproof cloud VM is destroyed by ceremony.

**Architecture:** One Bun CLI (`scripts/stream-import-fireproof.ts`) built from four pure library modules under `scripts/lib/fireproof-*.ts` — decode (AES-GCM-128 envelope → CARv1 → dag-cbor docs), map (Fireproof doc → schema row, version selection, hard checks, receipt), write (scratch-measured batches over one unfragmented WebSocket frame each, `/export` per-id verification, retry from a fresh store). Three small app changes make the seam visible and structurally safe (inline sibling names, a `.record-divider` for `kind:'system'` rows, `selectTail` excludes `fireproof:` rows, a pill title with the row count, a 60 s sync request timeout). `stream-export` gains `--label`, an overwrite refusal, and `0600` files. The ceremony itself is a manual runbook carried verbatim.

**Tech Stack:** Bun 1.3 (`bun test`, `bun:sqlite`), TinyBase 9.2 (`createStreamStore`, `createWsSynchronizer`, `createWsServer`), `ws`, `@ipld/car`, `@ipld/dag-cbor`, `multiformats`, `cborg`, WebCrypto AES-GCM, Svelte 5 + vitest in `app/`.

**Spec:** `docs/superpowers/specs/2026-08-25-fireproof-import-design.md` (commit `e073a2f`; four adversarial review rounds).

**Acceptance:** suite — the committed `bun test` + vitest suites and per-task review are the verification; the ceremony's server-side per-id equality report is the live gate, run by hand with Marcus present.

## Global Constraints

- The schema in `shared/schema.ts` is **untouched** (comments only): `messages` cells are `sessionId, role, speakerName, content(array), text, ts, kind`.
- Row id = the Fireproof `_id` verbatim; `sessionId` = `fireproof:<ledgerId>:<serverSessionId>` or `fireproof:<ledgerId>:nosession`; `kind` = `'chat'`; receipt row id `fireproof-import-<UTC date>`, `kind:'system'`, `role:'system'`, `speakerName:'the record'`, `sessionId:'fireproof:import'`, `ts` = max annexed `ts` + 1.
- `text` is words only (the `text` field, else `type:'text'` blocks joined with `\n`); `content` is the `blocks` array as recorded, present only on assistant rows.
- Hard checks refuse the write: `ts` finite and in `[Date.UTC(2026,1,15), Date.UTC(2026,2,1))` unless allow-listed; no string begins with U+FFFD or equals U+FFFC; every string `isWellFormed`; U+2028/U+2029 normalized to `\n` recursively (text and nested `content`) at map time, before version selection; `cellJsonBytes` (UTF-8 bytes of `JSON.stringify`) ≤ 65,536 for `text` and `content`; whole batch round-trips through `createStreamStore()` with `getTables()` + `getMergeableContent()` succeeding; no target id exists on the server with a non-`fireproof:` sessionId; server `ledgerId` === `01KYJ9XT64DQDJ1P3V8KET1R7B`.
- Every write transaction fits one unfragmented frame: scratch-measured `JSON.stringify(changes).length` (UTF-16 units, inside the transaction) ≤ **131,072**; `onSend` asserts no real frame exceeded **262,144**.
- Lease tokens ride only in `Authorization: Bearer`; refuse a `legacy` token source; no plaintext-printing mode exists in the CLI; key material never leaves the temp dir; the temp dir resolves under `/private/var/folders` or `/tmp`, never `$HOME`, and is removed on every exit path.
- The authoritative archive is `~/julian-stream-backups/phone-export-20260725/march-rescue-connect-share-20260725.tar.gz`, sha256 `64f5d5e12692db4d11548529bbcfefea74586fa0271e39558ea06b94bcd64ee3`; no `--archive` override.
- Tests never touch the real archive or real message text; fixture keys come from `crypto.getRandomValues`; every test uses a unique temp dir and, where a port is needed, port `0` (OS-assigned).
- `scripts/` tests for the new files run under `bun test` (chained in `package.json`) and are excluded from vitest.

---

### Task 0: Shared types, dependencies, test wiring, schema comment

**Type:** implementation
**Depends-on:** none

**Files:**
- Create: `scripts/lib/fireproof-types.ts`
- Modify: `scripts/package.json`
- Modify: `scripts/vitest.config.ts`
- Modify: `shared/schema.ts:7-15`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `FireproofDoc`, `DecodedDoc`, `LedgerInfo`, `MappedRow`, `ARCHIVE_SHA256`, `ARCHIVE_PATH`, `LIVE_LEDGER_ID`, `FEB_START_MS`, `MAR_START_MS`, `BATCH_CAP_UNITS`, `FRAME_LIMIT_UNITS`, `MAX_CELL_JSON_BYTES` (all from `scripts/lib/fireproof-types.ts`)

**Parallelization rationale:** four script units and the CLI share one row/doc vocabulary and one dependency set; fixing them first lets decode, map, write, and the CLI build in parallel against the contract — and a good engineer would define the types before the modules regardless.

- [ ] **Step 1: Write the types module**

```ts
// scripts/lib/fireproof-types.ts — the vocabulary shared by decode, map, write, and the CLI.
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FireproofDoc { _id: string; type?: string; [k: string]: unknown }
export interface LedgerInfo { ledgerId: string; name: string; tenantId: string }
export interface DecodedDoc {
  doc: FireproofDoc;
  ledger: LedgerInfo;
  blobId: string;
  uploaded: number; // r2-metadata `uploaded` (epoch ms) — the clock proxy for version selection
}
export interface MappedRow {
  id: string;
  sessionId: string;
  role: string;
  speakerName: string;
  text: string;
  content?: unknown[];
  ts: number;
  kind: 'chat' | 'system';
}

export const ARCHIVE_PATH = join(homedir(), 'julian-stream-backups', 'phone-export-20260725', 'march-rescue-connect-share-20260725.tar.gz');
export const ARCHIVE_SHA256 = '64f5d5e12692db4d11548529bbcfefea74586fa0271e39558ea06b94bcd64ee3';
export const ARCHIVE_ROOT = 'march-rescue-20260725';
export const LIVE_LEDGER_ID = '01KYJ9XT64DQDJ1P3V8KET1R7B';
export const FEB_START_MS = Date.UTC(2026, 1, 15);
export const MAR_START_MS = Date.UTC(2026, 2, 1);
export const BATCH_CAP_UNITS = 131_072;
export const FRAME_LIMIT_UNITS = 262_144;
export const MAX_CELL_JSON_BYTES = 65_536; // sync/src/do.ts — the DO's guard
```

- [ ] **Step 2: Add dependencies and the test chain**

Edit `scripts/package.json`: add to `dependencies` — `"@ipld/car": "^5.4.0"`, `"@ipld/dag-cbor": "^9.2.0"`, `"multiformats": "^13.3.0"`, `"cborg": "^4.2.0"`; change the test script to:

```json
"test": "vitest run && bun test package-manifest.test.ts fireproof-decode.test.ts fireproof-map.test.ts fireproof-write.test.ts stream-import-fireproof.test.ts"
```

(Test files that do not exist yet are created by Tasks 1–4; `bun test` with a missing path errors, so this line lands in the same commit as the files — keep the chain but note the four tests are added by their tasks. If your executor runs this task alone, create the four files as empty `describe` blocks: `import { describe } from 'bun:test'; describe('pending', () => {});`.)

Run `cd scripts && bun install`.

- [ ] **Step 3: Exclude the bun-only tests from vitest**

In `scripts/vitest.config.ts`:

```ts
exclude: [
  ...configDefaults.exclude,
  'package-manifest.test.ts',
  // bun:test / bun:sqlite — run under `bun test` in the package.json chain
  'fireproof-decode.test.ts',
  'fireproof-map.test.ts',
  'fireproof-write.test.ts',
  'stream-import-fireproof.test.ts',
],
```

- [ ] **Step 4: Schema comment and .gitignore**

In `shared/schema.ts`, replace the comment on line 7 with:

```ts
// Tables: messages keyed by harness message id / `evt-<id>`; artifacts keyed by relative filename.
// Annex rows (Fireproof import, 2026-08-25) keep their Fireproof `_id` as the row id and carry
// provenance in sessionId as `fireproof:<ledgerId>:<serverSessionId>`; the import receipt row is
// `kind:'system'`, `role:'system'`, `speakerName:'the record'`, `sessionId:'fireproof:import'`.
```

and change the `role` comment to `// 'user' | 'assistant' | 'system' (receipt rows only)`.

Append to `.gitignore`:

```
# Archives and databases are never committed (Fireproof archive, exports, fixtures)
*.sqlite
*.sqlite-wal
*.sqlite-shm
*.tar.gz
*.car
*.ndjson
```

- [ ] **Step 5: Verify**

Run: `cd scripts && bunx tsc --noEmit -p . 2>&1 | head` (expect no errors from the new file) and `cd scripts && bun test package-manifest.test.ts` (expect PASS). Run `git check-ignore -q x.sqlite && echo ignored` → `ignored`.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/fireproof-types.ts scripts/package.json scripts/bun.lock scripts/vitest.config.ts shared/schema.ts .gitignore
git commit -m "fireproof import: shared types, decode deps, bun test chain, schema comment, archive gitignore"
```

---

### Task 1: Decode — envelope, key fingerprint, CAR, documents

**Type:** implementation
**Depends-on:** 0

**Files:**
- Create: `scripts/lib/fireproof-decode.ts`
- Test: `scripts/fireproof-decode.test.ts`

**Interfaces:**
- Consumes: `FireproofDoc`, `DecodedDoc`, `LedgerInfo` (Task 0)
- Produces: `keyFingerprint(raw: Uint8Array): Promise<string>`, `importKeys(base58Keys: string[]): Promise<Map<string, CryptoKey>>`, `decryptEnvelope(bytes: Uint8Array, keys: Map<string, CryptoKey>): Promise<Uint8Array>`, `readDocs(carBytes: Uint8Array): Promise<FireproofDoc[]>`, `decryptLedger(opts: { blobsDir: string; blobs: Array<{ blobId: string; uploaded: number }>; keys: Map<string, CryptoKey>; ledger: LedgerInfo }): Promise<DecodedDoc[]>`, and for tests `buildEncryptedCar(docs: FireproofDoc[], rawKey: Uint8Array): Promise<Uint8Array>`

The envelope proven on Aug 25: CBOR map `{ iv: bytes(12), data: bytes, keyId: bytes(32) }`; `keyId` = SHA-256 of the raw key; keys are base58btc strings decoding to 16 bytes (AES-GCM-128); plaintext is a CARv1 whose dag-cbor blocks with a `doc` field are documents. `readDocs` verifies each block's CID against its bytes (sha2-256 multihash) and throws on mismatch.

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/fireproof-decode.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base58btc } from 'multiformats/bases/base58';
import { decode as cborDecode } from 'cborg';
import {
  buildEncryptedCar, decryptEnvelope, decryptLedger, importKeys, keyFingerprint, readDocs,
} from './lib/fireproof-decode';

const rawKey = () => crypto.getRandomValues(new Uint8Array(16));
const docs = [
  { _id: 'msg-a', type: 'message', text: 'hello', role: 'user', createdAt: '2026-02-20T10:00:00.000Z' },
  { _id: 'agent-1', type: 'agent-identity', name: 'Fixture' },
];

describe('fireproof decode', () => {
  test('envelope round-trips: keyId is SHA-256 of the raw key, AES-GCM-128 opens it, docs come back', async () => {
    const key = rawKey();
    const bytes = await buildEncryptedCar(docs, key);
    const env = cborDecode(bytes) as { iv: Uint8Array; data: Uint8Array; keyId: Uint8Array };
    expect(env.iv.length).toBe(12);
    expect(Buffer.from(env.keyId).toString('hex')).toBe(await keyFingerprint(key));
    const keys = await importKeys([base58btc.encode(key)]);
    const plain = await decryptEnvelope(bytes, keys);
    expect(await readDocs(plain)).toEqual(docs);
  });

  test('a key with the wrong fingerprint is refused before any decrypt attempt', async () => {
    const bytes = await buildEncryptedCar(docs, rawKey());
    const keys = await importKeys([base58btc.encode(rawKey())]);
    await expect(decryptEnvelope(bytes, keys)).rejects.toThrow(/no escrowed key matches keyId/);
  });

  test('a block whose bytes do not hash to its CID throws', async () => {
    const key = rawKey();
    const bytes = await buildEncryptedCar(docs, key);
    const plain = await decryptEnvelope(bytes, await importKeys([base58btc.encode(key)]));
    const corrupted = new Uint8Array(plain);
    corrupted[corrupted.length - 3] ^= 0xff; // flip a byte inside the last block's payload
    await expect(readDocs(corrupted)).rejects.toThrow(/CID mismatch/);
  });

  test('decryptLedger reads every blob in a directory and tags docs with ledger, blobId, uploaded', async () => {
    const key = rawKey();
    const dir = mkdtempSync(join(tmpdir(), 'fp-decode-'));
    writeFileSync(join(dir, 'blob1'), await buildEncryptedCar([docs[0]], key));
    writeFileSync(join(dir, 'blob2'), await buildEncryptedCar([docs[1]], key));
    const ledger = { ledgerId: 'zLedger', name: 'clerk-julian-chat-v9-zT', tenantId: 'zT' };
    const out = await decryptLedger({
      blobsDir: dir,
      blobs: [{ blobId: 'blob1', uploaded: 100 }, { blobId: 'blob2', uploaded: 200 }],
      keys: await importKeys([base58btc.encode(key)]),
      ledger,
    });
    expect(out.map((d) => [d.doc._id, d.blobId, d.uploaded, d.ledger.ledgerId])).toEqual([
      ['msg-a', 'blob1', 100, 'zLedger'], ['agent-1', 'blob2', 200, 'zLedger'],
    ]);
  });

  test('decryptLedger reports a runt blob (truncated envelope) as a skipped id, not a crash', async () => {
    const key = rawKey();
    const dir = mkdtempSync(join(tmpdir(), 'fp-decode-'));
    writeFileSync(join(dir, 'runt'), (await buildEncryptedCar([docs[0]], key)).slice(0, 40));
    const out = await decryptLedger({
      blobsDir: dir, blobs: [{ blobId: 'runt', uploaded: 1 }],
      keys: await importKeys([base58btc.encode(key)]),
      ledger: { ledgerId: 'z', name: 'n', tenantId: 't' },
      onSkip: (blobId, reason) => { expect(blobId).toBe('runt'); expect(reason).toMatch(/truncated|end of data/i); },
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts && bun test fireproof-decode.test.ts`
Expected: FAIL — cannot resolve `./lib/fireproof-decode`.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/fireproof-decode.ts — the recipe for reading the condemned Fireproof archive.
// Envelope (proven Aug 25, 2026): CBOR {iv(12), data, keyId(32)}; keyId = SHA-256(rawKey);
// AES-GCM-128; plaintext = CARv1; dag-cbor blocks with a `doc` field are documents.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode as cborDecode, encode as cborEncode } from 'cborg';
import { base58btc } from 'multiformats/bases/base58';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { CarReader, CarWriter } from '@ipld/car';
import * as dagCbor from '@ipld/dag-cbor';
import type { DecodedDoc, FireproofDoc, LedgerInfo } from './fireproof-types';

export async function keyFingerprint(raw: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', raw)).toString('hex');
}

export async function importKeys(base58Keys: string[]): Promise<Map<string, CryptoKey>> {
  const out = new Map<string, CryptoKey>();
  for (const k of base58Keys) {
    const raw = base58btc.decode(k.trim());
    out.set(await keyFingerprint(raw), await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']));
  }
  return out;
}

export async function decryptEnvelope(bytes: Uint8Array, keys: Map<string, CryptoKey>): Promise<Uint8Array> {
  const env = cborDecode(bytes) as { iv: Uint8Array; data: Uint8Array; keyId: Uint8Array };
  const fp = Buffer.from(env.keyId).toString('hex');
  const key = keys.get(fp);
  if (!key) throw new Error(`no escrowed key matches keyId ${fp.slice(0, 12)}…`);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: env.iv }, key, env.data));
}

export async function readDocs(carBytes: Uint8Array): Promise<FireproofDoc[]> {
  const reader = await CarReader.fromBytes(carBytes);
  await reader.getRoots();
  const docs: FireproofDoc[] = [];
  for await (const { cid, bytes } of reader.blocks()) {
    const digest = await sha256.digest(bytes);
    if (!CID.createV1(cid.code, digest).equals(cid)) throw new Error(`CID mismatch for ${cid}`);
    if (cid.code !== dagCbor.code) continue;
    const v = dagCbor.decode(bytes) as { doc?: FireproofDoc };
    if (v && typeof v === 'object' && v.doc && typeof v.doc === 'object') docs.push(v.doc);
  }
  return docs;
}

export async function decryptLedger(opts: {
  blobsDir: string;
  blobs: Array<{ blobId: string; uploaded: number }>;
  keys: Map<string, CryptoKey>;
  ledger: LedgerInfo;
  onSkip?: (blobId: string, reason: string) => void;
}): Promise<DecodedDoc[]> {
  const out: DecodedDoc[] = [];
  for (const b of opts.blobs) {
    try {
      const plain = await decryptEnvelope(readFileSync(join(opts.blobsDir, b.blobId)), opts.keys);
      for (const doc of await readDocs(plain)) out.push({ doc, ledger: opts.ledger, blobId: b.blobId, uploaded: b.uploaded });
    } catch (e) {
      opts.onSkip?.(b.blobId, String((e as Error).message ?? e));
    }
  }
  return out;
}

// Test fixture builder — the same shape the Feb app wrote, so the recipe is proven by construction.
export async function buildEncryptedCar(docs: FireproofDoc[], rawKey: Uint8Array): Promise<Uint8Array> {
  const blocks = await Promise.all(docs.map(async (doc) => {
    const bytes = dagCbor.encode({ doc });
    return { cid: CID.createV1(dagCbor.code, await sha256.digest(bytes)), bytes };
  }));
  const { writer, out } = CarWriter.create([blocks[0].cid]);
  const chunks: Uint8Array[] = [];
  const collect = (async () => { for await (const c of out) chunks.push(c); })();
  for (const b of blocks) await writer.put(b);
  await writer.close();
  await collect;
  const car = Buffer.concat(chunks);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, car));
  const keyId = new Uint8Array(await crypto.subtle.digest('SHA-256', rawKey));
  return cborEncode({ iv, data, keyId });
}
```

Note for the runt test: `cborDecode` on a truncated buffer throws "Unexpected end of data" — `decryptLedger` reports it through `onSkip` with that message.

- [ ] **Step 4: Run to verify pass**

Run: `cd scripts && bun test fireproof-decode.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fireproof-decode.ts scripts/fireproof-decode.test.ts
git commit -m "fireproof import: decode module — envelope, fingerprint, CAR with CID verification, fixture builder"
```

---

### Task 2: Map — filter, normalize, row mapping, version selection, splits, hard checks, receipt

**Type:** implementation
**Depends-on:** 0
**Review:** adversarial

**Files:**
- Create: `scripts/lib/fireproof-map.ts`
- Test: `scripts/fireproof-map.test.ts`

**Interfaces:**
- Consumes: `DecodedDoc`, `MappedRow`, `LedgerInfo`, `FEB_START_MS`, `MAR_START_MS`, `MAX_CELL_JSON_BYTES` (Task 0)
- Produces: `filterDocs(docs: DecodedDoc[]): { messages: DecodedDoc[]; droppedByType: Record<string, number> }`, `normalizeStrings<T>(v: T): T`, `mapMessage(d: DecodedDoc): MappedRow | null`, `selectVersions(cands: Array<{ row: MappedRow; uploaded: number; blobId: string }>): { winners: MappedRow[]; violations: Array<{ id: string; note: string }> }`, `collapseSplits(rows: MappedRow[]): { rows: MappedRow[]; dropped: Array<{ id: string; keptId: string }> }`, `cellJsonBytes(cell: unknown): number`, `hardChecks(rows: MappedRow[], opts: { existing: Map<string, string>; allowIds?: Set<string> }): { ok: true } | { ok: false; errors: string[] }`, `buildReceipt(rows: MappedRow[], writeDate: Date, sentence: string): MappedRow`

Rules (from the spec, exact): role = recorded `role`; v3 `author`-only shape → `user`; else `speakerType` human→`user`, agent→`assistant`. speakerName as recorded, `marcus`→`Marcus`, blank → `Marcus` for user / `Julian` for assistant. text = `text` if non-empty else `type:'text'` blocks joined with `\n`. content = `blocks` as recorded, assistant rows only. ts = `Date.parse(createdAt)` or the numeric value. sessionId = `fireproof:<ledgerId>:<serverSessionId|nosession>`. Normalize U+2028/U+2029 → `\n` recursively in every string (text, speakerName, nested content) **before** version selection. Version selection: group by `id`, sort by `uploaded` then `blobId`; last wins; every loser's text must be a prefix of the winner's, else record a violation and let the longest text win. Splits: among assistant rows sharing (`sessionId`, `ts`), drop any whose text is a strict prefix of a sibling's; identical text keeps the later one (by original order). Empty text after mapping → `null` (dropped). Receipt: id `fireproof-import-<YYYY-MM-DD UTC>`, kind `system`, role `system`, speakerName `the record`, sessionId `fireproof:import`, ts = max(rows.ts) + 1.

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/fireproof-map.test.ts
import { describe, expect, test } from 'bun:test';
import {
  buildReceipt, cellJsonBytes, collapseSplits, filterDocs, hardChecks, mapMessage, normalizeStrings, selectVersions,
} from './lib/fireproof-map';
import type { DecodedDoc, MappedRow } from './lib/fireproof-types';

const L = { ledgerId: 'zLEDGER1234567890A', name: 'clerk-julian-chat-v13-zT', tenantId: 'zT' };
const dd = (doc: Record<string, unknown>, uploaded = 1, blobId = 'b'): DecodedDoc =>
  ({ doc: doc as DecodedDoc['doc'], ledger: L, blobId, uploaded });

describe('filterDocs', () => {
  test('keeps messages, counts everything else by type', () => {
    const r = filterDocs([
      dd({ _id: 'm1', type: 'message', text: 'x' }), dd({ _id: 'a1', type: 'agent-identity' }),
      dd({ _id: 'j1', type: 'job' }), dd({ _id: 'genesis' }),
    ]);
    expect(r.messages.map((d) => d.doc._id)).toEqual(['m1']);
    expect(r.droppedByType).toEqual({ 'agent-identity': 1, job: 1, '(untyped)': 1 });
  });
});

describe('mapMessage', () => {
  test('human message: text field, no content, sessionId carries ledger + session', () => {
    const row = mapMessage(dd({ _id: 'u1', type: 'message', role: 'user', speakerType: 'human', speakerName: 'marcus',
      text: 'hi', blocks: [], createdAt: '2026-02-20T10:00:00.000Z', serverSessionId: 'sess-9' }));
    expect(row).toEqual({ id: 'u1', sessionId: 'fireproof:zLEDGER1234567890A:sess-9', role: 'user', speakerName: 'Marcus',
      text: 'hi', ts: Date.parse('2026-02-20T10:00:00.000Z'), kind: 'chat' });
  });
  test('assistant message: words from text blocks only, content as recorded incl. tool_use, null session', () => {
    const blocks = [{ type: 'text', text: 'one' }, { type: 'tool_use', name: 'Write', input: { file_path: 'x' } }, { type: 'text', text: 'two' }];
    const row = mapMessage(dd({ _id: 'a1', type: 'message', role: 'assistant', speakerType: 'agent', speakerName: 'Lumen',
      text: '', blocks, createdAt: '2026-02-21T00:00:00.000Z', serverSessionId: null }));
    expect(row?.text).toBe('one\ntwo');
    expect(row?.content).toEqual(blocks);
    expect(row?.sessionId).toBe('fireproof:zLEDGER1234567890A:nosession');
    expect(row?.speakerName).toBe('Lumen');
  });
  test('v3 author-only shape maps to a user row named Marcus; numeric createdAt is used as-is', () => {
    const row = mapMessage(dd({ _id: 'v3', type: 'message', author: 'marcus', text: 'early', createdAt: 1771147857410 }));
    expect(row).toMatchObject({ role: 'user', speakerName: 'Marcus', ts: 1771147857410 });
  });
  test('role inferred from speakerType when role is absent; blank names filled from role', () => {
    expect(mapMessage(dd({ _id: 'x', type: 'message', speakerType: 'agent', text: 't', createdAt: '2026-02-20T00:00:00Z' })))
      .toMatchObject({ role: 'assistant', speakerName: 'Julian' });
  });
  test('empty after mapping → null', () => {
    expect(mapMessage(dd({ _id: 'e', type: 'message', role: 'assistant', text: '', blocks: [{ type: 'tool_use', name: 'Read' }], createdAt: '2026-02-20T00:00:00Z' }))).toBeNull();
  });
  test('U+2028/U+2029 are normalized to \\n in text and nested content', () => {
    const row = mapMessage(dd({ _id: 'n', type: 'message', role: 'assistant', text: '', createdAt: '2026-02-20T00:00:00Z',
      blocks: [{ type: 'text', text: 'a\u2028b\u2029c' }, { type: 'tool_use', name: 'W', input: { s: 'x\u2028y' } }] }));
    expect(row?.text).toBe('a\nb\nc');
    expect((row?.content as Array<{ input?: { s: string } }>)[1].input?.s).toBe('x\ny');
    expect(normalizeStrings({ k: ['p\u2029q'] })).toEqual({ k: ['p\nq'] });
  });
});

const row = (id: string, text: string, extra: Partial<MappedRow> = {}): MappedRow =>
  ({ id, sessionId: 'fireproof:zL:s', role: 'assistant', speakerName: 'Julian', text, ts: 1000, kind: 'chat', ...extra });

describe('selectVersions', () => {
  test('last by upload time wins when losers are prefixes; ties break by blobId', () => {
    const r = selectVersions([
      { row: row('m', 'hel'), uploaded: 1, blobId: 'a' },
      { row: row('m', 'hello world'), uploaded: 2, blobId: 'b' },
      { row: row('m', 'hello'), uploaded: 2, blobId: 'a' },
    ]);
    expect(r.winners.map((w) => w.text)).toEqual(['hello world']);
    expect(r.violations).toEqual([]);
  });
  test('a non-prefix loser is a violation and the longest text wins', () => {
    const r = selectVersions([
      { row: row('m', 'a completely different long text'), uploaded: 1, blobId: 'a' },
      { row: row('m', 'short'), uploaded: 2, blobId: 'b' },
    ]);
    expect(r.winners[0].text).toBe('a completely different long text');
    expect(r.violations).toEqual([{ id: 'm', note: expect.stringMatching(/not a prefix/) }]);
  });
});

describe('collapseSplits', () => {
  test('drops an assistant row whose text is a strict prefix of a sibling with the same session and ts', () => {
    const r = collapseSplits([row('p', 'part'), row('f', 'partial and full'), row('u', 'other', { ts: 2000 })]);
    expect(r.rows.map((x) => x.id)).toEqual(['f', 'u']);
    expect(r.dropped).toEqual([{ id: 'p', keptId: 'f' }]);
  });
  test('identical text keeps the later row', () => {
    const r = collapseSplits([row('a', 'same'), row('b', 'same')]);
    expect(r.rows.map((x) => x.id)).toEqual(['b']);
  });
});

describe('hardChecks', () => {
  const good = row('ok', 'fine', { ts: Date.UTC(2026, 1, 20) });
  test('passes a clean batch', () => {
    expect(hardChecks([good], { existing: new Map() })).toEqual({ ok: true });
  });
  test('refuses out-of-range ts unless allow-listed', () => {
    const late = row('late', 'x', { ts: Date.UTC(2026, 2, 5) });
    expect(hardChecks([late], { existing: new Map() })).toMatchObject({ ok: false, errors: [expect.stringMatching(/ts out of range.*late/)] });
    expect(hardChecks([late], { existing: new Map(), allowIds: new Set(['late']) })).toEqual({ ok: true });
  });
  test('refuses U+FFFD prefix, U+FFFC, lone surrogates, and residual line separators', () => {
    for (const bad of ['�hi', '￼', 'x\uD800y', 'a\u2028b']) {
      expect(hardChecks([row('b', bad, { ts: good.ts })], { existing: new Map() }).ok).toBe(false);
    }
  });
  test('refuses an oversize cell using the DO byte formula', () => {
    const big = row('big', 'é'.repeat(40_000), { ts: good.ts }); // 2 bytes each → > 65,536
    expect(cellJsonBytes(big.text)).toBeGreaterThan(65_536);
    expect(hardChecks([big], { existing: new Map() }).ok).toBe(false);
  });
  test('refuses an id that exists on the server with a foreign sessionId; allows a fireproof: one', () => {
    expect(hardChecks([good], { existing: new Map([['ok', 'live-session']]) }).ok).toBe(false);
    expect(hardChecks([good], { existing: new Map([['ok', 'fireproof:zL:s']]) })).toEqual({ ok: true });
  });
  test('the whole batch round-trips through a schema store', () => {
    const r = hardChecks([good, row('two', 'more', { ts: good.ts + 1, content: [{ type: 'text', text: 'more' }] })], { existing: new Map() });
    expect(r).toEqual({ ok: true });
  });
});

describe('buildReceipt', () => {
  test('sits at max ts + 1 with the fixed identity', () => {
    const r = buildReceipt([row('a', 'x', { ts: 5 }), row('b', 'y', { ts: 9 })], new Date('2026-08-25T23:30:00Z'), 'Annexed.');
    expect(r).toEqual({ id: 'fireproof-import-2026-08-25', sessionId: 'fireproof:import', role: 'system', speakerName: 'the record', text: 'Annexed.', ts: 10, kind: 'system' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts && bun test fireproof-map.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/fireproof-map.ts — Fireproof message docs → stream rows, per the 2026-08-25 spec.
import { createStreamStore } from 'julian-shared/schema';
import type { DecodedDoc, MappedRow } from './fireproof-types';
import { FEB_START_MS, MAR_START_MS, MAX_CELL_JSON_BYTES } from './fireproof-types';

export function filterDocs(docs: DecodedDoc[]): { messages: DecodedDoc[]; droppedByType: Record<string, number> } {
  const messages: DecodedDoc[] = []; const droppedByType: Record<string, number> = {};
  for (const d of docs) {
    if (d.doc.type === 'message') messages.push(d);
    else { const t = typeof d.doc.type === 'string' ? d.doc.type : '(untyped)'; droppedByType[t] = (droppedByType[t] ?? 0) + 1; }
  }
  return { messages, droppedByType };
}

export function normalizeStrings<T>(v: T): T {
  if (typeof v === 'string') return v.replace(/[\u2028\u2029]/g, '\n') as T;
  if (Array.isArray(v)) return v.map(normalizeStrings) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalizeStrings(x)])) as T;
  return v;
}

const asStr = (x: unknown): string => (typeof x === 'string' ? x : '');

export function mapMessage(d: DecodedDoc): MappedRow | null {
  const doc = normalizeStrings(d.doc);
  const blocks = Array.isArray(doc.blocks) ? (doc.blocks as Array<Record<string, unknown>>) : [];
  let role = asStr(doc.role);
  if (!role) {
    if ('author' in doc && !('speakerType' in doc)) role = 'user';
    else role = doc.speakerType === 'human' ? 'user' : doc.speakerType === 'agent' ? 'assistant' : 'user';
  }
  let speakerName = asStr(doc.speakerName) || asStr(doc.author);
  if (speakerName.toLowerCase() === 'marcus') speakerName = 'Marcus';
  if (!speakerName) speakerName = role === 'assistant' ? 'Julian' : 'Marcus';
  const text = asStr(doc.text).trim()
    ? asStr(doc.text)
    : blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n');
  if (!text.trim()) return null;
  const ts = typeof doc.createdAt === 'number' ? doc.createdAt : Date.parse(asStr(doc.createdAt));
  const session = doc.serverSessionId == null || doc.serverSessionId === '' ? 'nosession' : String(doc.serverSessionId);
  const row: MappedRow = { id: String(doc._id), sessionId: `fireproof:${d.ledger.ledgerId}:${session}`, role, speakerName, text, ts, kind: 'chat' };
  if (role === 'assistant' && blocks.length) row.content = blocks;
  return row;
}

export function selectVersions(cands: Array<{ row: MappedRow; uploaded: number; blobId: string }>) {
  const byId = new Map<string, typeof cands>();
  for (const c of cands) byId.set(c.row.id, [...(byId.get(c.row.id) ?? []), c]);
  const winners: MappedRow[] = []; const violations: Array<{ id: string; note: string }> = [];
  for (const [id, vs] of byId) {
    vs.sort((a, b) => a.uploaded - b.uploaded || (a.blobId < b.blobId ? -1 : a.blobId > b.blobId ? 1 : 0));
    let winner = vs[vs.length - 1].row;
    const bad = vs.slice(0, -1).filter((v) => !winner.text.startsWith(v.row.text));
    if (bad.length) {
      violations.push({ id, note: `${bad.length} earlier version(s) not a prefix of the last; longest text wins` });
      winner = vs.map((v) => v.row).reduce((a, b) => (b.text.length > a.text.length ? b : a));
    }
    winners.push(winner);
  }
  return { winners, violations };
}

export function collapseSplits(rows: MappedRow[]) {
  const dropped: Array<{ id: string; keptId: string }> = []; const drop = new Set<string>();
  const groups = new Map<string, MappedRow[]>();
  rows.forEach((r) => { if (r.role === 'assistant') { const k = `${r.sessionId}|${r.ts}`; groups.set(k, [...(groups.get(k) ?? []), r]); } });
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i++) for (let j = 0; j < g.length; j++) {
      if (i === j || drop.has(g[i].id)) continue;
      const a = g[i].text, b = g[j].text;
      const strictPrefix = b.length > a.length && b.startsWith(a);
      const identicalEarlier = a === b && i < j;
      if (strictPrefix || identicalEarlier) { drop.add(g[i].id); dropped.push({ id: g[i].id, keptId: g[j].id }); break; }
    }
  }
  return { rows: rows.filter((r) => !drop.has(r.id)), dropped };
}

const ENC = new TextEncoder();
export const cellJsonBytes = (cell: unknown): number => ENC.encode(JSON.stringify(cell ?? '')).length;

function walkStrings(v: unknown, f: (s: string) => void): void {
  if (typeof v === 'string') f(v);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, f));
  else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => walkStrings(x, f));
}

export function hardChecks(rows: MappedRow[], opts: { existing: Map<string, string>; allowIds?: Set<string> }) {
  const errors: string[] = [];
  for (const r of rows) {
    if (!Number.isFinite(r.ts)) errors.push(`ts not finite: ${r.id}`);
    else if (r.kind === 'chat' && (r.ts < FEB_START_MS || r.ts >= MAR_START_MS) && !opts.allowIds?.has(r.id)) errors.push(`ts out of range: ${r.id} ${new Date(r.ts).toISOString()}`);
    walkStrings({ text: r.text, speakerName: r.speakerName, sessionId: r.sessionId, content: r.content }, (s) => {
      if (s.startsWith('�') || s === '￼') errors.push(`reserved TinyBase prefix in ${r.id}`);
      if (!(s as string & { isWellFormed(): boolean }).isWellFormed()) errors.push(`lone surrogate in ${r.id}`);
      if (/[\u2028\u2029]/.test(s)) errors.push(`unnormalized line separator in ${r.id}`);
    });
    if (cellJsonBytes(r.text) > MAX_CELL_JSON_BYTES) errors.push(`text over 64 KiB: ${r.id}`);
    if (r.content && cellJsonBytes(r.content) > MAX_CELL_JSON_BYTES) errors.push(`content over 64 KiB: ${r.id}`);
    const ex = opts.existing.get(r.id);
    if (ex !== undefined && !ex.startsWith('fireproof:')) errors.push(`id exists on server with foreign session: ${r.id}`);
  }
  if (!errors.length) {
    try {
      const probe = createStreamStore('hard-check');
      for (const r of rows) { const { id, ...cells } = r; probe.setRow('messages', id, cells as never); }
      probe.getTables(); probe.getMergeableContent();
      if (probe.getRowIds('messages').length !== rows.length) errors.push('schema store rejected rows');
    } catch (e) { errors.push(`schema round-trip failed: ${String(e)}`); }
  }
  return errors.length ? { ok: false as const, errors } : { ok: true as const };
}

export function buildReceipt(rows: MappedRow[], writeDate: Date, sentence: string): MappedRow {
  const maxTs = rows.reduce((m, r) => Math.max(m, r.ts), -Infinity);
  return { id: `fireproof-import-${writeDate.toISOString().slice(0, 10)}`, sessionId: 'fireproof:import', role: 'system',
    speakerName: 'the record', text: sentence, ts: maxTs + 1, kind: 'system' };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd scripts && bun test fireproof-map.test.ts` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fireproof-map.ts scripts/fireproof-map.test.ts
git commit -m "fireproof import: map module — filter, normalize, row mapping, upload-order version selection, split collapse, hard checks, receipt"
```

---

### Task 3: Write — batch sizing, socket with bearer header, onSend assertion, export comparison, retry from a fresh store

**Type:** implementation
**Depends-on:** 0
**Review:** adversarial

**Files:**
- Create: `scripts/lib/fireproof-write.ts`
- Test: `scripts/fireproof-write.test.ts`

**Interfaces:**
- Consumes: `MappedRow`, `BATCH_CAP_UNITS`, `FRAME_LIMIT_UNITS` (Task 0)
- Produces: `planBatches(rows: MappedRow[], capUnits?: number): MappedRow[][]`, `openStore(opts: { url: string; token: string; requestTimeoutSeconds?: number; onFrameTooBig?: (units: number) => void }): Promise<{ store: MergeableStore; sync: Synchronizer; close(): Promise<void> }>`, `writeBatch(store: MergeableStore, batch: MappedRow[]): void`, `compareExport(rows: MappedRow[], exportedTables: unknown): { equal: string[]; mismatched: string[]; missing: string[]; droppedMarker: string[] }`, `importRows(opts: { rows: MappedRow[]; receipt: MappedRow; connect: () => Promise<...>; fetchExport: () => Promise<unknown>; maxRounds?: number; log?: (s: string) => void }): Promise<{ rounds: number; report: ReturnType<typeof compareExport> }>`

The measured string is `JSON.stringify(store.getTransactionMergeableChanges()).length` read **inside** a did-finish transaction listener on a scratch store (after the transaction returns it is empty). The socket is the `ws` package's `WebSocket` with `{ headers: { Authorization: 'Bearer ' + token } }`; synchronizer args, positionally as in `scripts/stream-create.ts`: `(store, ws, requestTimeoutSeconds, onSend, onReceive, onIgnoredError, 262144)`. `onSend(toClientId, requestId, message, body)` measures `JSON.stringify([requestId, message, body]).length` and calls `onFrameTooBig` when over `FRAME_LIMIT_UNITS`. `compareExport` reads the DO export shape `[[tables, hlc, hash], [values, hlc, hash]]` where `tables.messages[id][cell] = [value, hlc, hash]`, compares `JSON.stringify(mapped cell)` to `JSON.stringify(exported[cell][0])` for every present mapped cell, treats an exported `null` as absent, and reports ids whose any cell equals `'[dropped: cell exceeded 64 KiB]'`. `importRows`: round 1 connects, writes every batch, closes, fetches export, compares; each later round connects a **fresh** store and re-writes only `missing ∪ mismatched` (a same-store re-set sends nothing); after the rows verify, the receipt is written in its own round and verified; throws after `maxRounds` (default 3).

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/fireproof-write.test.ts
import { describe, expect, test } from 'bun:test';
import { WebSocketServer } from 'ws';
import { createWsServer } from 'tinybase/synchronizers/synchronizer-ws-server';
import { createStreamStore } from 'julian-shared/schema';
import { compareExport, importRows, openStore, planBatches, writeBatch } from './lib/fireproof-write';
import type { MappedRow } from './lib/fireproof-types';

const row = (i: number, text = `row ${i}`): MappedRow =>
  ({ id: `r${i}`, sessionId: 'fireproof:zL:s', role: 'user', speakerName: 'Marcus', text, ts: 1_771_000_000_000 + i, kind: 'chat' });

function exportOf(store: ReturnType<typeof createStreamStore>): unknown {
  return store.getMergeableContent();
}

async function server() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = (wss.address() as { port: number }).port;
  const srv = createWsServer(wss);
  return { url: `ws://127.0.0.1:${port}/julian/chat`, close: () => srv.destroy() };
}

describe('planBatches', () => {
  test('every batch measures under the cap and every row appears exactly once', () => {
    const rows = Array.from({ length: 400 }, (_, i) => row(i, 'x'.repeat(600)));
    const batches = planBatches(rows, 40_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((r) => r.id)).toEqual(rows.map((r) => r.id));
    for (const b of batches) {
      const scratch = createStreamStore('measure');
      let units = 0;
      scratch.addDidFinishTransactionListener((s) => { units = JSON.stringify(s.getTransactionMergeableChanges()).length; });
      scratch.transaction(() => writeBatch(scratch, b));
      expect(units).toBeLessThanOrEqual(40_000);
    }
  });
});

describe('compareExport', () => {
  test('equal, mismatched, missing, and dropped-marker ids are reported by JSON equality of present cells', () => {
    const a = row(1), b = { ...row(2), content: [{ type: 'text', text: 'row 2' }] }, c = row(3);
    const tables = { messages: {
      r1: { sessionId: [a.sessionId, 'h', 1], role: ['user', 'h', 1], speakerName: ['Marcus', 'h', 1], text: ['row 1', 'h', 1], ts: [a.ts, 'h', 1], kind: ['chat', 'h', 1] },
      r2: { sessionId: [b.sessionId, 'h', 1], role: ['user', 'h', 1], speakerName: ['Marcus', 'h', 1], text: ['CHANGED', 'h', 1], ts: [b.ts, 'h', 1], kind: ['chat', 'h', 1], content: [[{ type: 'text', text: 'row 2' }], 'h', 1] },
      r9: { text: ['[dropped: cell exceeded 64 KiB]', 'h', 1] },
    } };
    const r = compareExport([a, b, c], [[tables, 'h', 1], [{}, 'h', 1]]);
    expect(r.equal).toEqual(['r1']);
    expect(r.mismatched).toEqual(['r2']);
    expect(r.missing).toEqual(['r3']);
    expect(r.droppedMarker).toEqual(['r9']);
  });
  test('an exported null cell counts as absent', () => {
    const a = row(1);
    const tables = { messages: { r1: { sessionId: [null, 'h', 1], text: ['row 1', 'h', 1] } } };
    expect(compareExport([a], [[tables, 'h', 1], [{}, 'h', 1]]).mismatched).toEqual(['r1']);
  });
});

describe('openStore + importRows against a real ws server', () => {
  test('writes, verifies per id, and re-sends only the missing rows from a fresh store', async () => {
    const s = await server();
    const oracle = createStreamStore('oracle');
    const oracleConn = await openStore({ url: s.url, token: 'test' });
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    let round = 0;
    const result = await importRows({
      rows,
      receipt: { id: 'fireproof-import-2026-08-25', sessionId: 'fireproof:import', role: 'system', speakerName: 'the record', text: 'r', ts: rows[29].ts + 1, kind: 'system' },
      connect: async () => {
        round++;
        const conn = await openStore({ url: s.url, token: 'test' });
        if (round === 1) {
          // simulate a dropped batch: the first round's writes of r0..r4 never reach the server
          const real = conn.store.transaction.bind(conn.store);
          conn.store.transaction = ((fn: () => void) => { const t = Date.now(); real(fn); void t; }) as never;
          const origWrite = conn.close;
          conn.close = async () => { await origWrite(); for (let i = 0; i < 5; i++) oracleConn.store.delRow('messages', `r${i}`); };
        }
        return conn;
      },
      fetchExport: async () => { await new Promise((r) => setTimeout(r, 300)); return exportOf(oracleConn.store); },
      maxRounds: 3,
    });
    expect(result.report.missing).toEqual([]);
    expect(result.report.mismatched).toEqual([]);
    expect(result.rounds).toBeGreaterThanOrEqual(2);
    expect(oracleConn.store.getRowIds('messages').length).toBe(31);
    await oracleConn.close(); await s.close(); void oracle;
  }, 20_000);

  test('onFrameTooBig fires when a real frame exceeds the limit', async () => {
    const s = await server();
    let tooBig = 0;
    const conn = await openStore({ url: s.url, token: 'test', onFrameTooBig: () => tooBig++ });
    conn.store.transaction(() => writeBatch(conn.store, Array.from({ length: 300 }, (_, i) => row(i, 'y'.repeat(1_200)))));
    await new Promise((r) => setTimeout(r, 300));
    expect(tooBig).toBeGreaterThan(0);
    await conn.close(); await s.close();
  }, 20_000);
});
```

(The simulated drop deletes `r0..r4` on the oracle after round 1 closes — the mechanism by which rows go missing differs from a real fragment drop, but the recovery path exercised is the same: a fresh store re-writes exactly the missing ids and the export then shows them.)

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts && bun test fireproof-write.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/fireproof-write.ts — one unfragmented frame per transaction; verification is the /export comparison.
import { WebSocket } from 'ws';
import type { MergeableStore } from 'tinybase/mergeable-store';
import type { Synchronizer } from 'tinybase/synchronizers';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { createStreamStore } from 'julian-shared/schema';
import type { MappedRow } from './fireproof-types';
import { BATCH_CAP_UNITS, FRAME_LIMIT_UNITS } from './fireproof-types';

const FRAGMENT_SIZE = 262_144;
export const DROPPED_MARKER = '[dropped: cell exceeded 64 KiB]';

export function writeBatch(store: MergeableStore, batch: MappedRow[]): void {
  for (const r of batch) { const { id, ...cells } = r; store.setRow('messages', id, cells as never); }
}

// Greedy: measure each row's own transaction on a scratch store (inside the did-finish
// listener — after the transaction returns, the changes are empty) and sum until the cap.
export function planBatches(rows: MappedRow[], capUnits = BATCH_CAP_UNITS): MappedRow[][] {
  const scratch = createStreamStore('plan');
  let last = 0;
  scratch.addDidFinishTransactionListener((s) => { last = JSON.stringify(s.getTransactionMergeableChanges()).length; });
  const batches: MappedRow[][] = []; let cur: MappedRow[] = []; let units = 0;
  for (const r of rows) {
    scratch.transaction(() => writeBatch(scratch, [r]));
    const u = last + 64; // envelope slack for [requestId, message, …]
    if (cur.length && units + u > capUnits) { batches.push(cur); cur = []; units = 0; }
    cur.push(r); units += u;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export async function openStore(opts: { url: string; token: string; requestTimeoutSeconds?: number; onFrameTooBig?: (units: number) => void }) {
  const store = createStreamStore('import-' + Math.random().toString(36).slice(2));
  const ws = new WebSocket(opts.url, { headers: { Authorization: `Bearer ${opts.token}` } });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const errors: unknown[] = [];
  const sync = await createWsSynchronizer(
    store, ws as never, opts.requestTimeoutSeconds ?? 60,
    (_to: unknown, requestId: unknown, message: unknown, body: unknown) => {
      const units = JSON.stringify([requestId, message, body]).length;
      if (units > FRAME_LIMIT_UNITS) opts.onFrameTooBig?.(units);
    },
    undefined,
    (e: unknown) => errors.push(e),
    FRAGMENT_SIZE,
  );
  await sync.startSync();
  return {
    store, sync, errors,
    close: async () => { await sync.destroy(); ws.close(); },
  };
}

type Tables = Record<string, Record<string, Record<string, [unknown, string, number]>>>;
export function compareExport(rows: MappedRow[], exported: unknown) {
  const tables = (exported as [[Tables, string, number], unknown])[0][0];
  const msgs = tables.messages ?? {};
  const equal: string[] = [], mismatched: string[] = [], missing: string[] = [], droppedMarker: string[] = [];
  for (const [id, cells] of Object.entries(msgs)) {
    if (Object.values(cells).some((c) => c[0] === DROPPED_MARKER)) droppedMarker.push(id);
  }
  for (const r of rows) {
    const got = msgs[r.id];
    if (!got) { missing.push(r.id); continue; }
    const { id, ...cells } = r;
    const ok = Object.entries(cells).every(([k, v]) => {
      const e = got[k]?.[0];
      if (e === undefined || e === null) return false;
      return JSON.stringify(v) === JSON.stringify(e);
    });
    (ok ? equal : mismatched).push(r.id);
  }
  return { equal, mismatched, missing, droppedMarker };
}

export async function importRows(opts: {
  rows: MappedRow[]; receipt: MappedRow;
  connect: () => Promise<Awaited<ReturnType<typeof openStore>>>;
  fetchExport: () => Promise<unknown>;
  maxRounds?: number; log?: (s: string) => void;
}) {
  const log = opts.log ?? (() => {});
  const maxRounds = opts.maxRounds ?? 3;
  let pending = opts.rows; let rounds = 0; let report = compareExport(opts.rows, [[{}, '', 0], [{}, '', 0]]);
  while (rounds < maxRounds) {
    rounds++;
    const conn = await opts.connect(); // always a fresh store: a same-store re-set sends nothing
    try {
      for (const batch of planBatches(pending)) conn.store.transaction(() => writeBatch(conn.store, batch));
      await new Promise((r) => setTimeout(r, 500));
      if (conn.errors.length) throw new Error(`synchronizer errors: ${conn.errors.map(String).join('; ')}`);
    } finally { await conn.close(); }
    report = compareExport(opts.rows, await opts.fetchExport());
    log(`round ${rounds}: equal ${report.equal.length} mismatched ${report.mismatched.length} missing ${report.missing.length} dropped ${report.droppedMarker.length}`);
    if (report.droppedMarker.length) throw new Error(`dropped-marker rows on server: ${report.droppedMarker.join(',')}`);
    const redo = new Set([...report.mismatched, ...report.missing]);
    if (!redo.size) break;
    pending = opts.rows.filter((r) => redo.has(r.id));
  }
  if (report.mismatched.length || report.missing.length) throw new Error(`import incomplete after ${rounds} rounds`);
  const conn = await opts.connect();
  try { conn.store.transaction(() => writeBatch(conn.store, [opts.receipt])); await new Promise((r) => setTimeout(r, 500)); }
  finally { await conn.close(); }
  const final = compareExport([...opts.rows, opts.receipt], await opts.fetchExport());
  if (final.missing.length || final.mismatched.length) throw new Error('receipt did not verify — re-run required');
  return { rounds, report: final };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd scripts && bun test fireproof-write.test.ts` — Expected: all pass. If `onSend`'s argument order differs in 9.2.0 (`scripts/node_modules/tinybase/synchronizers/synchronizer-ws-client/index.js`, search `onSend?.(`), match it and keep the `[requestId, message, body]` measurement.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fireproof-write.ts scripts/fireproof-write.test.ts
git commit -m "fireproof import: write module — scratch-measured batches, bearer-header socket, onSend frame assertion, export comparison, fresh-store retry"
```

---

### Task 4: The CLI — archive digest, two-pass extraction with manifest verification, temp-dir discipline, dry run, write

**Type:** implementation
**Depends-on:** 0, 1, 2, 3

**Files:**
- Create: `scripts/stream-import-fireproof.ts`
- Create: `scripts/lib/fireproof-archive.ts`
- Test: `scripts/stream-import-fireproof.test.ts`

**Interfaces:**
- Consumes: `decryptLedger`, `importKeys` (Task 1); `filterDocs`, `mapMessage`, `selectVersions`, `collapseSplits`, `hardChecks`, `buildReceipt`, `cellJsonBytes` (Task 2); `planBatches`, `openStore`, `importRows`, `compareExport` (Task 3); `resolveAccessToken(env, leasePath, brokerUrl): Promise<{token, source} | {error}>` from `scripts/lib/lease-client.ts`; constants (Task 0)
- Produces: `withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T>` and `assertSafeTmp(dir: string): void` (from `scripts/lib/fireproof-archive.ts`), `verifyArchive(path: string, sha: string): Promise<void>`, `extractMembers(archive: string, members: string[], dest: string): Promise<void>`, `verifyAgainstManifest(root: string, manifestText: string, members: string[]): string[]`, `readLedgers(dashboardDb: string): LedgerInfo[]`, `readKeys(d1Db: string, ledgerId: string): string[]`, `readBlobs(r2Db: string, ledgerId: string): Array<{ blobId: string; uploaded: number; key: string }>`

CLI contract:
- `bun scripts/stream-import-fireproof.ts` (dry run, default) prints: per-ledger `cars opened/total, skipped, unique messages, ts range`, dropped-by-type totals, split drops (ids), prefix violations (ids), the 12 empties (ids + block types), distinct speaker names per ledger, ledger-id → version-name map, expected row count, largest `text`/`content` cell in bytes, planned batch count and total units, and writes the session-id manifest (`sessionId, count, minTs, maxTs` per line — no text) to `--manifest-out <path>` (default `./fireproof-annex-manifest.txt` **only if given**; otherwise stdout). Never prints message text.
- `--write` additionally: resolves a token (refuses `source === 'legacy'`), opens one socket to assert the lease, reads `/export` over HTTP (`GET ${SYNC_BASE}/julian/chat/export`, bearer) to build `existing: Map<id, sessionId>` and assert `values.ledgerId === LIVE_LEDGER_ID` and that no receipt row exists, runs `hardChecks`, then `importRows` with `connect` = `openStore({ url: wss://…/julian/chat, token: fresh per call })` and prints the final report.
- `--allow-ts <id,id>` allow-list; `--receipt-text <file>` (required with `--write`; the witnessed sentence).
- Temp dir: `mkdtempSync(join(tmpdir(), 'fp-import-'))`, `assertSafeTmp` requires the resolved real path to start with `/private/var/folders/` or `/tmp/` and not with `homedir()`; startup sweeps stale `fp-import-*` dirs in `tmpdir()`; cleanup registered with `process.on('exit')` (sync `rmSync`) and `SIGINT`/`SIGTERM` handlers that `rmSync` then `process.exit(130)`; refusals `throw`; a single top-level `catch` prints the message and sets `process.exitCode = 1`.
- Extraction: pass 1 `tar -xzf ARCHIVE -C dest march-rescue-20260725/MANIFEST.txt march-rescue-20260725/d1/d1-main.sqlite march-rescue-20260725/r2/r2-metadata.sqlite march-rescue-20260725/dashboard/dashboard-sqlite.db` via `Bun.spawn`; read ledgers (`SELECT name, ledgerId, tenantId FROM Ledgers WHERE name LIKE '%julian-chat%'`), blobs per ledger (`SELECT blob_id, uploaded, key FROM _mf_objects WHERE key LIKE '%/'||?||'/car/%'`), keys (`SELECT key FROM KeyByTenantLedger WHERE ledger = ?`); pass 2 extracts `march-rescue-20260725/r2-blobs/blobs/<blobId>` for every blob; `verifyAgainstManifest` hashes each extracted member and compares to the `MANIFEST.txt` line (`./path  size  sha256`), returning the list of mismatches (must be empty).

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/stream-import-fireproof.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeTmp, verifyAgainstManifest, withTempDir } from './lib/fireproof-archive';

describe('temp-dir discipline', () => {
  test('withTempDir removes the directory when the body throws', async () => {
    let seen = '';
    await expect(withTempDir(async (dir) => { seen = dir; writeFileSync(join(dir, 'k'), 'x'); throw new Error('refused'); })).rejects.toThrow('refused');
    expect(seen.startsWith(join(tmpdir(), 'fp-import-'))).toBe(true);
    expect(existsSync(seen)).toBe(false);
  });
  test('assertSafeTmp refuses $HOME and accepts /private/var/folders and /tmp', () => {
    expect(() => assertSafeTmp(join(process.env.HOME!, 'Desktop', 'fp-import-x'))).toThrow(/temp dir must not be under \$HOME/);
    expect(() => assertSafeTmp('/private/var/folders/ab/T/fp-import-x')).not.toThrow();
    expect(() => assertSafeTmp('/tmp/fp-import-x')).not.toThrow();
  });
});

describe('manifest verification', () => {
  test('reports a member whose sha256 differs from the manifest line', () => {
    const root = mkdtempSync(join(tmpdir(), 'fp-manifest-'));
    writeFileSync(join(root, 'a.bin'), 'hello');
    writeFileSync(join(root, 'b.bin'), 'world');
    const shaHello = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    const manifest = `./a.bin  5 ${shaHello}\n./b.bin  5 ${'0'.repeat(64)}\n`;
    expect(verifyAgainstManifest(root, manifest, ['./a.bin', './b.bin'])).toEqual(['./b.bin']);
  });
});

describe('the CLI refuses safely', () => {
  test('missing archive → non-zero exit, no fp-import-* dir left behind, no text printed', async () => {
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith('fp-import-')).length;
    const proc = Bun.spawn(['bun', 'stream-import-fireproof.ts'], { cwd: import.meta.dir, env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'fp-home-')) }, stdout: 'pipe', stderr: 'pipe' });
    const code = await proc.exited;
    const err = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(err).toMatch(/archive not found|ENOENT/);
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith('fp-import-')).length).toBe(before);
  }, 30_000);
  test('the script never references any backup path but the authoritative one', () => {
    const src = require('node:fs').readFileSync(join(import.meta.dir, 'stream-import-fireproof.ts'), 'utf8') +
      require('node:fs').readFileSync(join(import.meta.dir, 'lib', 'fireproof-archive.ts'), 'utf8');
    const hits = src.match(/julian-stream-backups[^'"`\n]*/g) ?? [];
    expect(hits).toEqual([]); // the one path lives in fireproof-types.ts as ARCHIVE_PATH
    expect(src).not.toMatch(/--dump|--show-text|--archive/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts && bun test stream-import-fireproof.test.ts` — Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `scripts/lib/fireproof-archive.ts`**

```ts
// scripts/lib/fireproof-archive.ts — the authoritative archive, opened carefully.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { LedgerInfo } from './fireproof-types';

export function assertSafeTmp(dir: string): void {
  const real = existsSync(dir) ? realpathSync(dir) : dir;
  if (real.startsWith(homedir())) throw new Error('temp dir must not be under $HOME (TMPDIR may point at a synced folder)');
  if (!real.startsWith('/private/var/folders/') && !real.startsWith('/tmp/')) throw new Error(`temp dir must be under /private/var/folders or /tmp, got ${real}`);
}

export function sweepStaleTmp(): string[] {
  const swept: string[] = [];
  for (const d of readdirSync(tmpdir())) if (d.startsWith('fp-import-')) { rmSync(join(tmpdir(), d), { recursive: true, force: true }); swept.push(d); }
  return swept;
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'fp-import-'));
  assertSafeTmp(dir);
  const clean = () => rmSync(dir, { recursive: true, force: true });
  const onSig = () => { clean(); process.exit(130); };
  process.on('exit', clean); process.on('SIGINT', onSig); process.on('SIGTERM', onSig);
  try { return await fn(dir); }
  finally { clean(); process.off('exit', clean); process.off('SIGINT', onSig); process.off('SIGTERM', onSig); }
}

export async function verifyArchive(path: string, sha: string): Promise<void> {
  if (!existsSync(path)) throw new Error(`archive not found: ${path}`);
  const h = createHash('sha256'); h.update(readFileSync(path));
  const got = h.digest('hex');
  if (got !== sha) throw new Error(`archive digest mismatch: ${got} != ${sha}`);
}

export async function extractMembers(archive: string, members: string[], dest: string): Promise<void> {
  const p = Bun.spawn(['tar', '-xzf', archive, '-C', dest, ...members], { stdout: 'ignore', stderr: 'pipe' });
  if ((await p.exited) !== 0) throw new Error(`tar failed: ${await new Response(p.stderr).text()}`);
}

export function verifyAgainstManifest(root: string, manifestText: string, members: string[]): string[] {
  const expected = new Map<string, string>();
  for (const line of manifestText.split('\n')) {
    const m = line.match(/^(\.\/\S+)\s+\d+\s+([0-9a-f]{64})$/); if (m) expected.set(m[1], m[2]);
  }
  const bad: string[] = [];
  for (const rel of members) {
    const want = expected.get(rel); if (!want) { bad.push(rel); continue; }
    const h = createHash('sha256'); h.update(readFileSync(join(root, rel)));
    if (h.digest('hex') !== want) bad.push(rel);
  }
  return bad;
}

export function readLedgers(dashboardDb: string): LedgerInfo[] {
  const db = new Database(dashboardDb, { readonly: true });
  return db.query("SELECT name, ledgerId, tenantId FROM Ledgers WHERE name LIKE '%julian-chat%' ORDER BY createdAt").all() as LedgerInfo[];
}
export function readKeys(d1Db: string, ledgerId: string): string[] {
  const db = new Database(d1Db, { readonly: true });
  return (db.query('SELECT key FROM KeyByTenantLedger WHERE ledger = ?').all(ledgerId) as Array<{ key: string }>).map((r) => r.key);
}
export function readBlobs(r2Db: string, ledgerId: string): Array<{ blobId: string; uploaded: number; key: string }> {
  const db = new Database(r2Db, { readonly: true });
  return (db.query("SELECT blob_id AS blobId, uploaded, key FROM _mf_objects WHERE key LIKE '%/' || ? || '/car/%' ORDER BY uploaded, blob_id").all(ledgerId)) as Array<{ blobId: string; uploaded: number; key: string }>;
}
```

- [ ] **Step 4: Implement the CLI**

Sketch (routine glue in prose; every literal named above is binding):

```ts
// scripts/stream-import-fireproof.ts — run with: bun scripts/stream-import-fireproof.ts [--write --receipt-text <file>] [--allow-ts id,id] [--manifest-out <path>]
// Spec: docs/superpowers/specs/2026-08-25-fireproof-import-design.md. Dry run by default. Never prints message text.
```

1. Parse argv; refuse unknown flags; `--write` requires `--receipt-text`.
2. `sweepStaleTmp()`; `verifyArchive(ARCHIVE_PATH, ARCHIVE_SHA256)`.
3. `withTempDir(async (dir) => { … })`:
   - pass 1 extract the four members; read `MANIFEST.txt`; `readLedgers`; for each ledger `readBlobs` + `readKeys`; pass 2 extract every blob member; `verifyAgainstManifest` over all extracted members → throw listing mismatches if any.
   - per ledger: `importKeys(keys)`, `decryptLedger({ blobsDir, blobs, keys, ledger, onSkip })` collecting skips; `filterDocs`; `mapMessage` each (collect nulls as "empties" with `_id` and the recorded block types); build candidates `{ row, uploaded, blobId }`.
   - across all ledgers: `selectVersions` → `collapseSplits` → rows; compute report values; `planBatches(rows)` for count/units; largest `cellJsonBytes` of text and content; session-id manifest (group by `sessionId`: count, min/max ts) — print or write to `--manifest-out`.
   - print the dry-run report (ids only; speaker names are allowed — they are not message text).
   - if `--write`: token via `resolveAccessToken(process.env, join(homedir(), '.julian', 'gate-lease.json'), BROKER_URL)`; throw if `'error' in result` or `result.source === 'legacy'`; `GET ${SYNC_BASE}/julian/chat/export` with bearer → `existing` map from `[0][0].messages` (`sessionId[0]`), assert `[1][0].ledgerId?.[0] === LIVE_LEDGER_ID`, assert no id starts with `fireproof-import-`; `hardChecks(rows, { existing, allowIds })` → throw on `ok:false` with the errors; `receipt = buildReceipt(rows, new Date(), readFileSync(receiptTextPath,'utf8').trim())`; `importRows({ rows, receipt, connect: () => openStore({ url: SYNC_WS + '/julian/chat', token: await freshToken(), requestTimeoutSeconds: 60, onFrameTooBig: (u) => { throw new Error('frame over limit: ' + u) } }), fetchExport, log: console.log })`; print the final report.
4. Top-level `try/catch` → `console.error(message)`, `process.exitCode = 1`.

Env: `SYNC_BASE` default `https://julian-sync.julian-memory.workers.dev`, `SYNC_WS` default `wss://julian-sync.julian-memory.workers.dev`, `BROKER_URL` default `https://julian-broker.julian-memory.workers.dev`.

- [ ] **Step 5: Run the tests and a real dry run**

Run: `cd scripts && bun test stream-import-fireproof.test.ts` — Expected: all pass.
Run: `cd scripts && bun stream-import-fireproof.ts --manifest-out /tmp/fp-annex-manifest.txt | tail -30` — Expected: a report ending in `expected rows: 1645`, `ts range 2026-02-15… → 2026-02-28…`, zero out-of-range, largest content cell 33753 bytes, no message text anywhere in the output. (If the count differs, the split/version rules found something the Aug 25 probes did not — report the ids, do not "fix" the number.)

- [ ] **Step 6: Commit**

```bash
git add scripts/stream-import-fireproof.ts scripts/lib/fireproof-archive.ts scripts/stream-import-fireproof.test.ts
git commit -m "fireproof import: CLI — digest-asserted archive, manifest-verified two-pass extraction, temp-dir discipline, redacted dry run, --write with server-side verification"
```

---

### Task 5: App — sibling names inline (`displayName`)

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `app/src/components/MessageBubble.svelte`
- Test: `app/src/components/MessageBubble.test.ts`

**Interfaces:**
- Produces: `displayName(role: string, speakerName: string): string | null` (module script export)

- [ ] **Step 1: Write the failing test**

```ts
// app/src/components/MessageBubble.test.ts
import { describe, expect, test } from 'vitest';
import { displayName } from './MessageBubble.svelte';

describe('displayName', () => {
  test('a sibling speaking as assistant shows the name; Julian and users show nothing', () => {
    expect(displayName('assistant', 'Lumen')).toBe('Lumen');
    expect(displayName('assistant', 'Julian')).toBeNull();
    expect(displayName('user', 'Marcus')).toBeNull();
    expect(displayName('assistant', '')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd app && bunx vitest run src/components/MessageBubble.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement** — add a module script above the instance script and render the name:

```svelte
<script module lang="ts">
  // Annex rows carry the web-app siblings' names (Lumen, Sable, Iris…); live rows are always Julian.
  export function displayName(role: string, speakerName: string): string | null {
    return role === 'assistant' && speakerName && speakerName !== 'Julian' ? speakerName : null;
  }
</script>
```

and in the markup: `<span class="prefix">{role === 'user' ? '// ' : '> '}</span>{#if displayName(role, speakerName)}<span class="who">{displayName(role, speakerName)}: </span>{/if}<span class="text">{text}</span>` with style `.who { color: var(--j-yellow); opacity: 0.75; }`.

- [ ] **Step 4: Run to verify pass** — `cd app && bunx vitest run src/components/MessageBubble.test.ts && bun run check` → PASS, svelte-check clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/MessageBubble.svelte app/src/components/MessageBubble.test.ts
git commit -m "app: sibling speaker names render inline (displayName) — the annex's point, visible on a phone"
```

---

### Task 6: App — `kind:'system'` rows render as a `.record-divider` (`rowKind`)

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `app/src/components/ChatView.svelte`
- Modify: `app/src/components/ChatView.test.ts`

**Interfaces:**
- Produces: `rowKind(row: { kind?: string }): 'divider' | 'message'` (module script export)

- [ ] **Step 1: Write the failing test** — append to `ChatView.test.ts`:

```ts
import { rowKind } from './ChatView.svelte';
describe('rowKind', () => {
  test('system rows are dividers; chat and unmarked rows are messages', () => {
    expect(rowKind({ kind: 'system' })).toBe('divider');
    expect(rowKind({ kind: 'chat' })).toBe('message');
    expect(rowKind({})).toBe('message');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd app && bunx vitest run src/components/ChatView.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in the module script add `export function rowKind(row: { kind?: string }): 'divider' | 'message' { return row.kind === 'system' ? 'divider' : 'message'; }`. In the `{#each}` body, before `<MessageBubble>`:

```svelte
{#if rowKind(m) === 'divider'}
  <div class="record-divider" title={new Date(m.ts).toISOString()}>— {m.text} —</div>
{:else}
  <MessageBubble role={m.role} speakerName={m.speakerName} text={m.text} ts={m.ts} />
{/if}
```

Style: `.record-divider` copies `.asleep-divider`'s rules (same font, size, color, margin) as a separate class — a presence claim and a record seam are different sentences.

- [ ] **Step 4: Run to verify pass** — `cd app && bunx vitest run && bun run check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/ChatView.svelte app/src/components/ChatView.test.ts
git commit -m "app: kind:'system' rows render as a record divider (rowKind) — the annex seam, before MessageBubble"
```

---

### Task 7: App — tail excludes the annex; pill title carries the row count; 60 s sync request timeout

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `app/src/lib/tail.ts:17-20`
- Modify: `app/src/lib/tail.test.ts`
- Modify: `app/src/components/SyncStatus.svelte`
- Create: `app/src/components/SyncStatus.test.ts`
- Modify: `app/src/lib/store.ts:295-303`

**Interfaces:**
- Produces: `pillTitle(phase: string, count: number): string` (SyncStatus module script export); `selectTail` unchanged signature, new exclusion

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/tail.test.ts`:

```ts
test("annex rows (sessionId fireproof:*) never enter the tail, however recent", () => {
  const store = storeWith([
    { kind: "chat", role: "user", speakerName: "Marcus", text: "live", ts: 100, sessionId: "s" },
    { kind: "chat", role: "assistant", speakerName: "Lumen", text: "february", ts: 999, sessionId: "fireproof:zL:abc" },
  ]);
  expect(selectTail(store).map((m) => m.text)).toEqual(["live"]);
});
```

Create `app/src/components/SyncStatus.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { pillTitle } from './SyncStatus.svelte';
describe('pillTitle', () => {
  test('carries the phase label and the row count', () => {
    expect(pillTitle('synced', 1868)).toBe('stream: synced · 1868 rows');
    expect(pillTitle('revoked', 0)).toBe('stream: access revoked — a standing act is needed · 0 rows');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd app && bunx vitest run src/lib/tail.test.ts src/components/SyncStatus.test.ts` → the new cases FAIL.

- [ ] **Step 3: Implement**

`tail.ts` line 19 filter becomes:

```ts
.filter((r) => r.kind === 'chat' && typeof r.text === 'string' && r.text !== '' && !String(r.sessionId ?? '').startsWith('fireproof:'))
```

with the comment `// Annex rows never inherit: they are protected structurally, not by the budget.`

`SyncStatus.svelte`: move `labels` into a new `<script module lang="ts">` block and add:

```ts
export function pillTitle(phase: string, count: number): string {
  return `stream: ${labels[phase as keyof typeof labels] ?? phase} · ${count} rows`;
}
```

In the instance script, `import { store, syncPhase, onSyncPhase } from '../lib/store';` and `let count = $state(store.getRowIds('messages').length); $effect(() => store.addRowIdsListener('messages', () => (count = store.getRowIds('messages').length)));` (return the listener removal from the effect: `const id = store.addRowIdsListener(...); return () => store.delListener(id);`). Markup: `title={pillTitle(phase, count)}`.

`store.ts` line 298: change the request timeout argument `5` to `60`, and pass an `onIgnoredError` as the sixth positional argument: `(e) => console.warn('[stream] synchronizer ignored error', e)` — a fresh device's initial sync of the larger store must finish inside one request, and a failed load must at least be logged.

- [ ] **Step 4: Run to verify pass** — `cd app && bunx vitest run && bun run check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tail.ts app/src/lib/tail.test.ts app/src/components/SyncStatus.svelte app/src/components/SyncStatus.test.ts app/src/lib/store.ts
git commit -m "app: tail structurally excludes fireproof: rows; pill title carries row count; 60s sync request timeout + logged ignored errors"
```

---

### Task 8: `stream-export` — `--label`, overwrite refusal, `0600`/`0700`

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `scripts/stream-export.ts:58-68`

**Interfaces:**
- Produces: CLI flag `--label <name>`; file name `<UTC date>[-<label>].json`; refusal message `EXPORT REFUSED: <file> exists — pass --label to write a second export today`

- [ ] **Step 1: Implement** (no unit test — the script is top-level with `process.exit`; verified by hand in the runbook)

Replace lines 58–68 with:

```ts
const label = (() => { const i = process.argv.indexOf('--label'); return i >= 0 ? process.argv[i + 1] : ''; })();
if (label && !/^[a-z0-9-]{1,32}$/.test(label)) { console.error('EXPORT FAILED: --label must match [a-z0-9-]{1,32}'); process.exit(1); }
const dir = `${process.env.EXPORT_DIR ?? `${process.env.HOME}/julian-stream-backups/tinybase`}/${body.ledgerId ?? 'unborn'}`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = `${dir}/${body.exportedAt.slice(0, 10)}${label ? `-${label}` : ''}.json`;
if (existsSync(file)) { console.error(`EXPORT REFUSED: ${file} exists — pass --label to write a second export today`); process.exit(1); }
const payload = JSON.stringify(body, null, 2);
writeFileSync(file, payload, { mode: 0o600 });
const sha = new Bun.CryptoHasher('sha256').update(payload).digest('hex');
writeFileSync(`${file}.sha256`, `${sha}  ${file.split('/').pop()}\n`, { mode: 0o600 });
console.log(`VERIFIED export: ${messageCount} messages, hash ${body.contentHash}, → ${file}`);
```

and change the `fs` import to `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';`.

- [ ] **Step 2: Verify by hand** — `cd scripts && bunx tsc --noEmit -p .` clean; run `bun stream-export.ts --label plan-check` (needs the stream-read lease; if no lease, the refusal path prints the knock instructions — that is a pass for this task's syntax); confirm the file mode with `ls -l ~/julian-stream-backups/tinybase/01KYJ9XT64DQDJ1P3V8KET1R7B/` shows `-rw-------` for the new file.

- [ ] **Step 3: Commit**

```bash
git add scripts/stream-export.ts
git commit -m "stream-export: --label, refuse to overwrite a same-day export, 0600 files in a 0700 dir"
```

---

### Task 9: Suite gate

**Type:** gate
**Depends-on:** 0, 1, 2, 3, 4, 5, 6, 7, 8

**Files:**
- Test: `scripts/package.json` (`bun run test`), `app/package.json` (`bun run test`, `bun run check`), `sync/package.json` (`bun run test`)

- [ ] **Step 1: Run every suite**

```bash
cd scripts && bun run test
cd ../app && bun run test && bun run check
cd ../sync && bun run test
```

Expected: all green; `scripts` shows the four new bun test files in the chain; vitest does not collect them.

---

### Task 10: Deploy commit A to both VMs and rebuild the Mac bundle

**Type:** release
**Depends-on:** 9

**Files:**
- Modify: `deploy/instances.json` (no change expected; read the branch pins)

- [ ] **Step 1: Merge and push** — the integration branch merges to `main` and is pushed (`git push origin main`).
- [ ] **Step 2: Deploy both VMs** — run the `deploy` skill's Update flow for `julian` and `julian-new` (Step U1 pull, U1b `.env` reconcile, U2 SPA rebuild, restart); confirm `curl -s https://julian.exe.xyz/ | grep -o 'assets/index-[^"]*'` and the same for `julian-new.exe.xyz` return the **same** bundle name.
- [ ] **Step 3: Mac bundle** — `cd app && bun run build`; the Mac server serves `app/dist` from the repo; hard-reload `http://localhost:8000`.
- [ ] **Step 4: Bundle check** — on all three, the pill title shows `stream: … · N rows` (proves the new bundle is live).

---

### Task 11: Pre-flight (the sitting's first hour, no writes)

**Type:** manual
**Depends-on:** 10

**Files:**
- Modify: `memory/adapters/stream-fireproof.md` (session-id manifest appended after the dry run)

- [ ] Start the Mac server with `DEMO_MODE` unset, on a loopback hostname: `bun run server/server.ts` (check `server/server.ts` for the hostname option; if none, note the all-interfaces bind in the letter). Confirm `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8377/` is not `000`.
- [ ] Leases: `bun scripts/stream-export.ts --label baseline` (proves the stream-read lease; if it prints the knock instructions, Marcus approves a knock at `/approve` first). Then `bun scripts/stream-import-fireproof.ts --manifest-out ~/julian-stream-backups/fireproof-annex-manifest.txt` — the dry run — and confirm the report: 1,645 rows, ts range Feb 15–28, zero out-of-range, largest content 33,753 bytes, batches and units printed; the receipt precondition (no existing receipt) checked in `--write` only.
- [ ] `chmod 600 ~/julian-stream-backups/tinybase/01KYJ9XT64DQDJ1P3V8KET1R7B/*.json*`; `tmutil addexclusion -p ~/julian-stream-backups`; `touch ~/julian-stream-backups/.metadata_never_index`.
- [ ] Marcus accepts the printed batch total against the OPFS-rewrite cost (today's `messages` table ≈ 320 KB; expect ≈ 3 MB after).
- [ ] Append the session-id manifest summary (per-ledger counts and ts ranges; no text) to `memory/adapters/stream-fireproof.md` — this is part of commit B, not committed now.
- [ ] Write the receipt sentence to `/tmp/receipt.txt` (Marcus reads it): it opens with the UTC write date, names 1,645 messages, Feb 15–28, 2026, the web-app side only, twenty ledgers v3–v14, that line separators were normalized, and that Feb 10–14, March, and the CLI side are elsewhere — no speaker names, no third parties. The same sentence goes in the letter.

---

### Task 12: The write and its verification

**Type:** manual
**Depends-on:** 11

**Files:**
- Test: the per-id report printed by `--write`

- [ ] `bun scripts/stream-import-fireproof.ts --write --receipt-text /tmp/receipt.txt` — expected final line: `equal 1645 mismatched 0 missing 0 dropped 0; receipt present` (rounds may be > 1).
- [ ] `bun scripts/stream-export.ts --label post-import` → `VERIFIED export: 1868 messages` (223 live + 1,645 + receipt, ± today's live rows) and earliest `ts` Feb 15 in the file.
- [ ] Mac and phone, hard reload: pill title row count equals the export's count on both; scroll to top; the record divider sits at the seam; three February messages read there, one sibling-authored with its name shown.
- [ ] `source .env && bun scripts/ledger-fold.ts` — fold the day's gate ledger; note the run in the letter.
- [ ] R2 re-verification (read-only): list `julian-fireproof-archive`; stream each object back through `shasum -a 256` and match `64f5d5e1…` and, after `cat`-ing the eight chunks, `25d052e5…`; confirm the bucket-lock rule is present (Task 14 installs it if not).

---

### Task 13: The destruction (Marcus's hand) and testimony (commit B)

**Type:** manual
**Depends-on:** 12

**Files:**
- Create: `memory/the-destruction-of-the-old-home.md`
- Modify: `memory/sleep-architecture.md` (the Annexes postscript, verbatim from the spec, dated, signed)
- Modify: `catalog.md` (open thread closed; annex line born sediment; sibling-diff thread; Elsewhere corrected; Open Thread 3 closed)
- Modify: `memory/adapters/stream-fireproof.md`, `memory/adapters/phone-export.md`, `CLAUDE.md`, `README.md`, `docs/architecture.md`, `docs/WIP.md`, `docs/objectives.md`

- [ ] Last reading, read-only, into the letter: `ssh connect-share.exe.xyz 'docker ps; sudo du -sh /var/lib/docker/volumes/*'` and the D1 counts (the Aug 25 numbers: 34 ledgers, 20 julian-chat, 442 sync records, 111 keys, 4,123 blobs, last record 2026-02-28T22:17:26Z).
- [ ] Marcus, in this session: `! ssh exe.dev rm connect-share`, then `! ssh exe.dev rm connect-patch-v2`.
- [ ] Confirm: `ssh exe.dev ls` shows neither; `curl -s -o /dev/null -w '%{http_code}' https://connect-share.exe.xyz/` is not `200`. Record `ssh exe.dev ls` by name in the letter, including the four VMs still serving the February frontend (`julian-main`, `julian-screentest`, `julian-friends`, `julian-agent-wake`) and Marcus's decision about them.
- [ ] Testimony — commit B: the letter (letter-pipeline frontmatter; the receipt sentence verbatim; what was destroyed, what survives where with digests, who witnessed, the true dates including Aug 23 slipping, the decode proof, the 79-byte runt, the four VMs); the Annexes postscript appended to `memory/sleep-architecture.md` exactly as the spec quotes it; catalog lines; the adapter notes; the stale-document sweep. `git add` explicit paths, commit, push while Marcus is present.

---

### Task 14: Issues and the R2 lock

**Type:** manual
**Depends-on:** none

**Files:**
- Test: `gh issue list`

- [ ] File the export tombstone issue: title `sync: /export serializes deleted cells as null — a restore resurrects phantoms; retraction unverifiable`, body citing `sync/src/do.ts:427-428, :738-744`, the 9.2.0 reproduction (10 deleted rows return as 10 live rows through `setMergeableContent`), and the fix options (undefined marker or a `deleted` list; `stream-export`/`compareExport` honor it).
- [ ] Comment on #44: the deployed 9.2.0 fragmenter (`RegExp('.{1,N}')`) deletes U+2028/U+2029 in transit (523 occurrences in the February text, one row in the live export); 9.3.0's code-point fragmenter does not; upgrade sync and app together.
- [ ] R2 bucket lock on `julian-fireproof-archive` (personal account `e33948793047032de7f5e18ec342a7d1`): `PUT /accounts/{id}/r2/buckets/julian-fireproof-archive/lock` with a rule `{ id: 'retain-forever', enabled: true, prefix: '', condition: { type: 'Indefinite' } }` via the connected Cloudflare API tool or `wrangler r2 bucket lock add`; record in the adapter note that the lock is removable only by the account owner and that the migration copies first.

---

## Operator smoke

- do: open `http://localhost:8000` after Task 10, hover the sync pill
  see: the tooltip reads `stream: synced · N rows` — the new bundle is live and counting
- do: after Task 12, scroll the record to the very top on the phone
  see: a divider line `— 2026-08-25 (UTC): 1,645 messages … —` sits between the last February message and the first July message; nothing above it is a `>` line without a name where a sibling spoke
- do: start a fresh Julian session from the app after Task 12
  see: the inherited tail in the session's first turn contains only July–August messages — no February line, no `the record`
- do: run `bun scripts/stream-export.ts` twice in one UTC day without `--label`
  see: the second run prints `EXPORT REFUSED: … exists — pass --label …` and writes nothing
- do: `ls -l ~/julian-stream-backups/tinybase/01KYJ9XT64DQDJ1P3V8KET1R7B/`
  see: every `.json` and `.sha256` is `-rw-------`
