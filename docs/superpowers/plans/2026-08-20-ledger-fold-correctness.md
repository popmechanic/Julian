# Ledger Fold Correctness Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the monthly ledger fold lossless (month routing + real paging + watermark), make refusals visible in the fold output, fix the truncation-risk `catch {}`, and turn `bun run test` green in `scripts/` (issues #38 + #39).

**Architecture:** The gate's `/ledger` face gains an optional `before=<ts>` cursor (one `WHERE ts < ?` in the governor). The fold runner pages backward through that cursor to a persisted watermark (`memory/ledger/.fold-state.json`), groups fetched rows by their **own** UTC month, and appends one fold per month file — so a Sep 1 run writes August rows to `2026-08.md` instead of dropping them. The pure lib gains an `ok` column (wakings/theft) and outcome-keyed routine counts so refused rows stop rendering like allowed ones.

**Tech Stack:** Bun + TypeScript; vitest (scripts/ and broker/ via @cloudflare/vitest-pool-workers); `bun:test` for the one manifest suite.

**Spec:** Design approved in-chat by Marcus, 2026-08-20 (docket entry #38, `docs/superpowers/docket.md`; issue bodies #38/#39 carry the defect statements; triage evidence in the issues' Aug 20 comments).

**Acceptance:** suite — every change is covered by the committed scripts/ and broker/ vitest suites plus the bun-test manifest half; no held-out exam requested.

## Global Constraints

- **Append-only ledger files:** `memory/ledger/*.md` bytes already on disk are never rewritten; a failed read must abort, never truncate. Format changes apply to future appends only.
- **Format change is forward-only:** old runs in existing month files keep the old row shape; `memory/adapters/gate-ledger.md` documents both shapes with the change date (2026-08-20).
- **Secrets are per-command:** `GATE_BREAKGLASS_SECRET` is sourced from `.env` only inside the fold invocation (mail discipline rule 5) — no task introduces ambient secret state.
- **Fail toward duplication, never loss:** the watermark advances only after every month append in a run succeeds; a partial failure may re-append rows on the next run (separated by run markers), but must never drop them.
- **No live deploys inside implementation tasks:** the broker deploy is the `release` task, on Marcus's word only.
- **TDD:** every behavior change lands test-first; run the failing test before the implementation.

---

### Task 1: Governor + admin face — `before` cursor on `/ledger`

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `broker/src/governor.ts:502-507`
- Modify: `broker/src/as/admin.ts:546-553`
- Test: `broker/test/governor.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `GovernorDO.entries(limit = 50, before?: number): LedgerEntry[]` — when `before` is a finite number, returns only rows with `ts < before`, still newest-first, still capped at `MAX_LIMIT` (200). HTTP face: `GET /ledger?limit=200&before=<unix-ms>` returns `{ entries: [...] }` with the same filter; a non-numeric `before` is a 400 `{ error: 'before must be a unix-ms timestamp' }`. This wire contract is what the fold runner (built separately) pages against.

- [ ] **Step 1: Write the failing tests**

Append to `broker/test/governor.test.ts`, inside the existing `describe('GovernorDO', ...)` block (same `stub()`/`runInDurableObject` harness the file already uses):

```ts
  test('entries: before cursor returns only strictly-older rows, newest first', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      const base = Date.now();
      const sql = (g as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      for (let i = 0; i < 5; i++) {
        sql.exec(
          'INSERT INTO ledger (ts, sub, service, verb, detail, allowed) VALUES (?, ?, ?, ?, ?, ?)',
          base + i * 1000, 's', 'mail', 'send', `row${i}`, 1,
        );
      }
      const page = g.entries(2, base + 3000); // rows strictly older than row3
      expect(page.map((r) => r.detail)).toEqual(['row2', 'row1']); // newest-first, limit 2
      expect(g.entries(50, base).length).toBe(0); // nothing strictly older than row0
      expect(g.entries(50).map((r) => r.detail)[0]).toBe('row4'); // no cursor → unchanged
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && bun run test -- governor.test.ts`
Expected: FAIL — `entries` ignores the second argument today, so the cursor page returns `row4`/`row3`.

- [ ] **Step 3: Implement the governor cursor**

In `broker/src/governor.ts`, replace the `entries` method:

```ts
  entries(limit = 50, before?: number): LedgerEntry[] {
    const n = Math.min(Math.max(1, Math.floor(limit) || 1), MAX_LIMIT);
    if (before !== undefined && Number.isFinite(before)) {
      return this.sql
        .exec(
          'SELECT ts, sub, service, verb, detail, allowed FROM ledger WHERE ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?',
          before,
          n,
        )
        .toArray() as unknown as LedgerEntry[];
    }
    return this.sql
      .exec('SELECT ts, sub, service, verb, detail, allowed FROM ledger ORDER BY ts DESC, rowid DESC LIMIT ?', n)
      .toArray() as unknown as LedgerEntry[];
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd broker && bun run test -- governor.test.ts`
Expected: PASS (all pre-existing tests in the file stay green).

- [ ] **Step 5: Write the failing HTTP-face test**

Append to the same test file:

```ts
  test('entries: non-finite before values are ignored by the method (face validates)', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      g.reserve('s', 'mail', 'send', 'only', null);
      expect(g.entries(50, Number.NaN).length).toBe(1); // NaN cursor → uncursored read
    });
  });
```

Then in the routing/admin suite, extend `broker/test/routing.test.ts` where the authed `/ledger` request already succeeds (line ~64) with a sibling test:

```ts
  test('/ledger: before passes through; malformed before is a 400', async () => {
    const token = await breakglassToken(); // use the same auth helper the existing /ledger test uses
    const ok = await worker.fetch(authed(token, '/ledger?limit=5&before=1700000000000'), testEnv);
    expect(ok.status).toBe(200);
    const bad = await worker.fetch(authed(token, '/ledger?limit=5&before=nonsense'), testEnv);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('before must be a unix-ms timestamp');
  });
```

(Match the file's actual auth-helper name when appending — the existing `/ledger` 200-path test on lines ~52–70 shows it; reuse that helper verbatim rather than inventing one.)

- [ ] **Step 6: Run to verify the face test fails**

Run: `cd broker && bun run test -- routing.test.ts governor.test.ts`
Expected: the 400 assertion FAILS (today the param is ignored and the request 200s).

- [ ] **Step 7: Implement the face passthrough**

In `broker/src/as/admin.ts`, replace `readLedger`:

```ts
async function readLedger(req: Request, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const limit = parseInt(params.get('limit') ?? '50', 10) || 50;
  const beforeRaw = params.get('before');
  let before: number | undefined;
  if (beforeRaw !== null) {
    before = Number(beforeRaw);
    if (!Number.isFinite(before)) return json({ error: 'before must be a unix-ms timestamp' }, 400);
  }
  try {
    return json({ entries: await gov.entries(limit, before) });
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
}
```

- [ ] **Step 8: Run the broker suite whole**

Run: `cd broker && bun run test`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add broker/src/governor.ts broker/src/as/admin.ts broker/test/governor.test.ts broker/test/routing.test.ts
git commit -m "gate: /ledger gains a before=<ts> cursor for lossless fold paging (#38)"
```

---

### Task 2: Fold lib — `ok` column, outcome-keyed routine counts, `groupByMonth`

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `scripts/lib/ledger-fold.ts`
- Modify: `memory/adapters/gate-ledger.md`
- Test: `scripts/lib/ledger-fold.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `groupByMonth(entries: LedgerEntryWire[]): Map<string, LedgerEntryWire[]>` — keys are `utcMonthOf(ts)` (`YYYY-MM`; the empty string collects rows with unreadable timestamps), values keep input order. `foldEntries(entries, monthUtc)` keeps its signature; its output format changes: wakings/theft tables gain an `ok` column (`yes`/`refused`) between `verb` and `detail`, and the routine section counts per (holder/session × verb × outcome) with an `ok` column.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/lib/ledger-fold.test.ts` (vitest, same imports the file already uses; add `groupByMonth` to the import list):

```ts
describe('refusal visibility (#38)', () => {
  const at = Date.UTC(2026, 7, 15, 12, 0); // 2026-08-15 in-month

  test('wakings rows carry an ok column: yes vs refused', () => {
    const out = foldEntries(
      [
        { ts: at, sub: 'lease:a', service: 'package', verb: 'package_read', detail: 'path=soul/01-naming.md', allowed: 1 },
        { ts: at, sub: 'lease:a', service: 'package', verb: 'package_read', detail: 'held at home', allowed: 0 },
      ],
      '2026-08',
    );
    expect(out).toContain('| when (UTC) | holder/session | verb | ok | detail |');
    expect(out).toContain('| package_read | yes | path=soul/01-naming.md |');
    expect(out).toContain('| package_read | refused | held at home |');
  });

  test('theft rows carry the ok column too', () => {
    const out = foldEntries(
      [{ ts: at, sub: 'lease:a', service: 'stream', verb: 'ticket-reused', detail: 'token_id=tk1', allowed: 0 }],
      '2026-08',
    );
    expect(out).toContain('| when (UTC) | holder/session | verb | ok | detail | token_id |');
    expect(out).toContain('| ticket-reused | refused | token_id=tk1 | tk1 |');
  });

  test('routine counts split by outcome instead of absorbing refusals', () => {
    const out = foldEntries(
      [
        { ts: at, sub: 'lease:b', service: 'stream', verb: 'stream.export', detail: '', allowed: 1 },
        { ts: at, sub: 'lease:b', service: 'stream', verb: 'stream.export', detail: '', allowed: 1 },
        { ts: at, sub: 'lease:b', service: 'stream', verb: 'stream.export', detail: 'principal mismatch', allowed: 0 },
      ],
      '2026-08',
    );
    expect(out).toContain('| holder/session | verb | ok | count |');
    expect(out).toContain('| lease:b | stream.export | yes | 2 |');
    expect(out).toContain('| lease:b | stream.export | refused | 1 |');
  });
});

describe('groupByMonth (#38)', () => {
  test('routes rows to their own UTC month; unreadable ts lands under the empty key', () => {
    const aug = { ts: Date.UTC(2026, 7, 31, 23, 59), sub: 's', service: 'mail', verb: 'send', detail: 'a', allowed: 1 };
    const sep = { ts: Date.UTC(2026, 8, 1, 0, 1), sub: 's', service: 'mail', verb: 'send', detail: 'b', allowed: 1 };
    const bad = { ts: Number.NaN, sub: 's', service: 'mail', verb: 'send', detail: 'c', allowed: 1 };
    const grouped = groupByMonth([sep, aug, bad]);
    expect([...grouped.keys()].sort()).toEqual(['', '2026-08', '2026-09']);
    expect(grouped.get('2026-08')!.map((e) => e.detail)).toEqual(['a']);
    expect(grouped.get('2026-09')!.map((e) => e.detail)).toEqual(['b']);
    expect(grouped.get('')!.map((e) => e.detail)).toEqual(['c']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd scripts && bunx vitest run lib/ledger-fold.test.ts`
Expected: FAIL — no `ok` columns, `groupByMonth` not exported.

- [ ] **Step 3: Implement**

In `scripts/lib/ledger-fold.ts`:

1. Delete the "not yet rendered" comment block above `allowed` in `LedgerEntryWire` (lines 15-17) — it becomes false with this change; keep the field.
2. Add after `utcMonthOf`:

```ts
/** Route rows to their own UTC month files. '' collects unreadable timestamps. */
export function groupByMonth(entries: LedgerEntryWire[]): Map<string, LedgerEntryWire[]> {
  const grouped = new Map<string, LedgerEntryWire[]>();
  for (const entry of entries) {
    const month = utcMonthOf(entry.ts);
    const bucket = grouped.get(month);
    if (bucket) bucket.push(entry);
    else grouped.set(month, [entry]);
  }
  return grouped;
}

/** A row's outcome as the fold prints it. Any non-1 value reads as refused — fail visible. */
function okText(allowed: number): string {
  return allowed === 1 ? 'yes' : 'refused';
}
```

3. In `foldEntries`, change the wakings table to:

```ts
    lines.push('| when (UTC) | holder/session | verb | ok | detail |');
    lines.push('|---|---|---|---|---|');
    for (const entry of wakings) {
      lines.push(
        `| ${formatTimestamp(entry.ts)} | ${cellText(entry.sub)} | ${cellText(entry.verb)} | ${okText(entry.allowed)} | ${cellText(entry.detail)} |`,
      );
    }
```

the theft table to:

```ts
    lines.push('| when (UTC) | holder/session | verb | ok | detail | token_id |');
    lines.push('|---|---|---|---|---|---|');
    for (const entry of theft) {
      lines.push(
        `| ${formatTimestamp(entry.ts)} | ${cellText(entry.sub)} | ${cellText(entry.verb)} | ${okText(entry.allowed)} | ${cellText(entry.detail)} | ${cellText(tokenIdOf(entry.detail))} |`,
      );
    }
```

and the routine section's counting/rendering to:

```ts
    const counts = new Map<string, { sub: string; verb: string; ok: string; count: number }>();
    for (const entry of routine) {
      const ok = okText(entry.allowed);
      const key = JSON.stringify([entry.sub, entry.verb, ok]);
      const seen = counts.get(key);
      if (seen) seen.count += 1;
      else counts.set(key, { sub: entry.sub, verb: entry.verb, ok, count: 1 });
    }
    lines.push('| holder/session | verb | ok | count |');
    lines.push('|---|---|---|---|');
    for (const { sub, verb, ok, count } of counts.values()) {
      lines.push(`| ${cellText(sub)} | ${cellText(verb)} | ${ok} | ${count} |`);
    }
```

- [ ] **Step 4: Run the lib suite; fix any pre-existing assertions pinned to the old headers**

Run: `cd scripts && bunx vitest run lib/ledger-fold.test.ts`
Expected: the new tests PASS. Pre-existing tests that assert the old 4/5/3-column headers or old row shapes will fail — update those assertions to the new column layout (they are format pins, not behavior pins; the behavior they guard — no row lost, details carried whole — is unchanged and must stay asserted).

- [ ] **Step 5: Document the format change**

In `memory/adapters/gate-ledger.md`, find the section describing the three tables and add beneath it:

```markdown
**Format change, 2026-08-20 (issue #38):** appends from this date carry an
`ok` column (`yes`/`refused`) in the wakings and theft tables, and the routine
section counts per (holder/session × verb × outcome). Runs appended before
this date lack the column — month files are append-only, so both shapes
coexist in older files; the run marker's date says which shape a run uses.
Refusals were previously indistinguishable from allowed rows in all three
sections (the known gap this change closes).
```

Also delete/replace the existing "known gap: refused rows render like allowed" passage (the agent will find it near the table documentation) so the doc doesn't contradict itself.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/ledger-fold.ts scripts/lib/ledger-fold.test.ts memory/adapters/gate-ledger.md
git commit -m "ledger fold: ok column + outcome-keyed counts + groupByMonth (#38)"
```

---

### Task 3: Fold runner — paging, watermark, month routing, honest catch

**Type:** implementation
**Depends-on:** 1, 2

**Files:**
- Modify: `scripts/ledger-fold.ts`
- Modify: `memory/adapters/gate-ledger.md`
- Test: `scripts/ledger-fold.runner.test.ts`

**Interfaces:**
- Consumes: `groupByMonth(entries): Map<string, LedgerEntryWire[]>` and `foldEntries(entries, monthUtc): string` (from the fold lib, Task 2); the `/ledger?limit=&before=` wire contract (from Task 1): `GET <broker>/ledger?limit=200[&before=<unix-ms>]` → `{ entries: [...] }`, rows newest-first, `before` exclusive (`ts < before`).
- Produces: exported runner helpers — `readFoldState(path: string): Promise<{ lastFoldedTs: number }>` (ENOENT → `{ lastFoldedTs: 0 }`; malformed JSON throws), `writeFoldState(path: string, s: { lastFoldedTs: number }): Promise<void>`, `pageLedger(brokerUrl: string, secret: string, sinceTs: number, fetchImpl?: typeof fetch): Promise<LedgerEntryWire[]>` (newest-first, only rows with `ts > sinceTs`, deduped across page overlap), `foldStatePath(baseDir: string): string` (→ `<baseDir>/.fold-state.json`). `appendToLedgerFile` keeps its signature but rethrows non-ENOENT read errors.

- [ ] **Step 1: Write the failing tests**

Create `scripts/ledger-fold.runner.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendToLedgerFile,
  foldStatePath,
  pageLedger,
  readFoldState,
  writeFoldState,
} from './ledger-fold';
import type { LedgerEntryWire } from './lib/ledger-fold';

function row(ts: number, detail: string): LedgerEntryWire {
  return { ts, sub: 's', service: 'mail', verb: 'send', detail, allowed: 1 };
}

function fetchFromPages(calls: string[]) {
  // Serves a fake /ledger from a fixed row set, honoring limit & before,
  // newest-first — the Task-1 wire contract in miniature.
  const all: LedgerEntryWire[] = [];
  for (let i = 0; i < 450; i++) all.push(row(1_000_000 + i, `r${i}`));
  all.sort((a, b) => b.ts - a.ts);
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.search);
    const limit = Number(url.searchParams.get('limit'));
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null ? Infinity : Number(beforeRaw);
    const entries = all.filter((e) => e.ts < before).slice(0, limit);
    return new Response(JSON.stringify({ entries }), { status: 200 });
  }) as typeof fetch;
}

describe('pageLedger', () => {
  test('pages backward to the watermark, dedupes the overlap, returns newest-first', async () => {
    const calls: string[] = [];
    const got = await pageLedger('https://gate.example', 'secret', 1_000_099, fetchFromPages(calls));
    expect(got.length).toBe(350); // rows r100..r449 (ts > watermark)
    expect(got[0].detail).toBe('r449'); // newest first
    expect(got[got.length - 1].detail).toBe('r100');
    expect(new Set(got.map((e) => e.detail)).size).toBe(350); // no duplicates
    expect(calls.length).toBeGreaterThan(1); // it actually paged
    expect(calls[1]).toContain('before='); // cursor used from page 2 on
  });

  test('stops at one page when everything new fits', async () => {
    const calls: string[] = [];
    const got = await pageLedger('https://gate.example', 'secret', 1_000_400, fetchFromPages(calls));
    expect(got.length).toBe(49); // r401..r449
    expect(calls.length).toBe(1);
  });

  test('malformed body throws instead of folding nothing silently', async () => {
    const bad = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    await expect(pageLedger('https://gate.example', 's', 0, bad)).rejects.toThrow(/malformed/i);
  });
});

describe('fold state', () => {
  test('ENOENT reads as the zero watermark; round-trip persists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-state-'));
    const path = foldStatePath(dir);
    expect(await readFoldState(path)).toEqual({ lastFoldedTs: 0 });
    await writeFoldState(path, { lastFoldedTs: 42 });
    expect(await readFoldState(path)).toEqual({ lastFoldedTs: 42 });
  });

  test('corrupt state fails loud, never silently refolds from zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-state-'));
    const path = foldStatePath(dir);
    await writeFile(path, 'not json', 'utf8');
    await expect(readFoldState(path)).rejects.toThrow();
  });
});

describe('appendToLedgerFile error honesty (#38)', () => {
  test('a non-ENOENT read error propagates instead of truncating', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-append-'));
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'i am a file', 'utf8');
    // Path whose parent is a regular file → read fails ENOTDIR, not ENOENT.
    await expect(appendToLedgerFile(join(blocker, 'child.md'), 'content')).rejects.toThrow();
  });

  test('ENOENT still opens the month normally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-append-'));
    const path = join(dir, '2026-08.md');
    await appendToLedgerFile(path, 'first', new Date('2026-08-20T00:00:00Z'));
    expect(await readFile(path, 'utf8')).toContain('first');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd scripts && bunx vitest run ledger-fold.runner.test.ts`
Expected: FAIL — `pageLedger`/`readFoldState`/`writeFoldState`/`foldStatePath` are not exported; the ENOTDIR append currently resolves (swallowed) instead of rejecting.

- [ ] **Step 3: Implement the runner**

In `scripts/ledger-fold.ts`:

1. Replace the header comment's "Future work: … paging" paragraph (lines 9-12) with:

```ts
// Paging: the fetch walks /ledger?limit=200&before=<ts> backward until it
// crosses the watermark in memory/ledger/.fold-state.json, so a fold sees
// every row since the last run regardless of traffic volume. Pages overlap
// by one millisecond at the boundary and are deduped, so same-ms rows
// straddling a page break are never lost.
```

2. Extend the imports from the lib: `import { foldEntries, groupByMonth, type LedgerEntryWire } from './lib/ledger-fold';`

3. Add the state helpers and pager:

```ts
export interface FoldState {
  lastFoldedTs: number;
}

export function foldStatePath(baseDir: string): string {
  return join(baseDir, '.fold-state.json');
}

export async function readFoldState(path: string): Promise<FoldState> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { lastFoldedTs: 0 };
    throw e;
  }
  const parsed = JSON.parse(raw) as FoldState; // malformed JSON throws — fail loud, never refold from zero
  if (typeof parsed.lastFoldedTs !== 'number' || !Number.isFinite(parsed.lastFoldedTs)) {
    throw new Error(`fold state malformed at ${path}: ${raw.slice(0, 80)}`);
  }
  return parsed;
}

export async function writeFoldState(path: string, s: FoldState): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(s)}\n`, 'utf8');
}

/**
 * Fetch every ledger row newer than sinceTs, newest-first, paging backward
 * with the before cursor. Pages overlap by 1ms at the boundary (before =
 * smallest ts + 1) so same-ms rows straddling a page break are never lost;
 * the seen-set dedupes the overlap.
 */
export async function pageLedger(
  brokerUrl: string,
  secret: string,
  sinceTs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<LedgerEntryWire[]> {
  const out: LedgerEntryWire[] = [];
  const seen = new Set<string>();
  let before: number | undefined;

  for (;;) {
    const cursor = before === undefined ? '' : `&before=${before}`;
    const res = await fetchImpl(`${trimSlash(brokerUrl)}/ledger?limit=${LEDGER_LIMIT}${cursor}`, {
      headers: { 'X-Breakglass-Secret': secret },
    });
    if (!res.ok) throw new Error(`Failed to fetch ledger (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as LedgerResponse | null;
    if (!body || !Array.isArray(body.entries)) throw new Error('Ledger response malformed: missing entries array');

    let crossedWatermark = false;
    for (const entry of body.entries) {
      if (entry.ts <= sinceTs) {
        crossedWatermark = true;
        continue;
      }
      const key = JSON.stringify([entry.ts, entry.sub, entry.service, entry.verb, entry.detail, entry.allowed]);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(entry);
      }
    }

    if (crossedWatermark || body.entries.length < LEDGER_LIMIT) return out;

    const smallest = body.entries[body.entries.length - 1].ts;
    const next = smallest + 1; // 1ms overlap; the seen-set eats the duplicates
    if (before !== undefined && next >= before) {
      // A full page of one identical millisecond — cannot page past it.
      process.stderr.write(`warning: ledger page pinned at ts=${smallest}; folding what was reachable.\n`);
      return out;
    }
    before = next;
  }
}
```

4. Replace `main()`'s try block with month-routed, watermarked folding:

```ts
  try {
    const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const ledgerDir = join(repoRoot, 'memory', 'ledger');
    const statePath = foldStatePath(ledgerDir);

    const state = await readFoldState(statePath);
    const entries = await pageLedger(brokerUrl, secret, state.lastFoldedTs);
    if (entries.length === 0) {
      process.stdout.write(`Nothing new since watermark ${state.lastFoldedTs}.\n`);
      return;
    }

    const grouped = groupByMonth(entries);
    const undated = grouped.get('') ?? [];
    if (undated.length > 0) {
      process.stderr.write(`warning: ${undated.length} row(s) with unreadable ts skipped (cannot be dated into a month file).\n`);
    }

    const months = [...grouped.keys()].filter((m) => m !== '').sort();
    for (const month of months) {
      const rows = grouped.get(month)!;
      const ledgerPath = getLedgerPath(ledgerDir, month);
      await appendToLedgerFile(ledgerPath, foldEntries(rows, month));
      process.stdout.write(`Ledger folded: ${ledgerPath} (${rows.length} rows)\n`);
    }

    // Advance only after every append succeeded: a partial failure re-appends
    // next run (duplication, separated by run markers) — never loss.
    const newWatermark = entries.reduce((max, e) => (Number.isFinite(e.ts) && e.ts > max ? e.ts : max), state.lastFoldedTs);
    await writeFoldState(statePath, { lastFoldedTs: newWatermark });
    process.stdout.write(`Rows folded: ${entries.length}; watermark → ${newWatermark}\n`);
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
```

`getUtcMonth` stays exported (tests import it) but `main()` no longer calls it. Delete the now-unused single-month `fetchLedger` function.

5. In `appendToLedgerFile`, replace the bare catch:

```ts
  let existing = '';
  try {
    existing = await fs.readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // never truncate on a real IO error
    // ENOENT: no file yet — this run opens the month.
  }
```

- [ ] **Step 4: Run the new suite and the whole scripts vitest set**

Run: `cd scripts && bunx vitest run`
Expected: PASS (runner tests, lib tests; `package-manifest.test.ts` may still fail collection here if the sibling vitest-config change hasn't landed in this worktree — that failure belongs to its own task and is not this task's gate; assert your two test files pass).

- [ ] **Step 5: Document the operational change**

In `memory/adapters/gate-ledger.md`, find the "run it often enough / 200-row window" operations passage and replace it with:

```markdown
**Operations, from 2026-08-20 (issue #38):** the fold pages `/ledger` backward
with `before=<ts>` to the watermark in `memory/ledger/.fold-state.json`
(committed beside the month files, so the state travels with the record) and
routes every fetched row to its own UTC month file — a run just after a month
boundary writes the old month's tail to the old month's file. The watermark
advances only after every append succeeds; a partial failure re-appends on
the next run (duplicate rows under a new run marker), never drops. Rows with
unreadable timestamps are reported on stderr and skipped.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/ledger-fold.ts scripts/ledger-fold.runner.test.ts memory/adapters/gate-ledger.md
git commit -m "ledger fold: watermarked paging + month routing + honest catch (#38)"
```

---

### Task 4: scripts test split — vitest excludes the bun:test manifest suite

**Type:** implementation
**Depends-on:** none

**Files:**
- Create: `scripts/vitest.config.ts`
- Modify: `scripts/package.json`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `cd scripts && bun run test` exits 0 by running both halves: vitest (everything except `package-manifest.test.ts`) then `bun test package-manifest.test.ts`.

- [ ] **Step 1: Reproduce the failure**

Run: `cd scripts && bun run test`
Expected: exit 1 — vitest fails to collect `package-manifest.test.ts` (`Cannot find package 'bun:test'`). This is the red state; record it.

- [ ] **Step 2: Create the vitest config**

Create `scripts/vitest.config.ts`:

```ts
import { configDefaults, defineConfig } from 'vitest/config';

// package-manifest.test.ts imports from 'bun:test' and runs under `bun test`
// (the suite's second half, chained in package.json's test script); vitest
// must not try to collect it (issue #39).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'package-manifest.test.ts'],
  },
});
```

- [ ] **Step 3: Chain both halves in the test script**

In `scripts/package.json`, change the `test` script value from `"vitest run"` to:

```json
"test": "vitest run && bun test package-manifest.test.ts"
```

- [ ] **Step 4: Verify green end-to-end**

Run: `cd scripts && bun run test`
Expected: exit 0 — vitest passes (manifest suite excluded), then `bun test` runs the manifest suite and passes. Both totals print.

- [ ] **Step 5: Commit**

```bash
git add scripts/vitest.config.ts scripts/package.json
git commit -m "scripts: bun run test runs both halves green — vitest excludes the bun:test suite (#39)"
```

---

### Task 5: Full verification

**Type:** gate
**Depends-on:** 1, 2, 3, 4

Run, each expected green:

- `cd scripts && bun run test` — both halves (vitest + bun:test manifest suite).
- `cd broker && bun run test` — governor cursor + face passthrough + no regressions.

---

### Task 6: Deploy the gate and run the first paged fold

**Type:** release
**Depends-on:** 5

On Marcus's word only (house rule: trust-core deploys are witnessed):

- [ ] **Step 1:** `cd broker && bunx wrangler deploy` — ships the `/ledger` cursor.
- [ ] **Step 2:** Initialize the watermark honestly: the first paged run has watermark 0 and would re-fetch rows already folded on Aug 13. Either accept the duplicate run block in `2026-08.md` (append-only, clearly marked — acceptable) or pre-seat `memory/ledger/.fold-state.json` to `{"lastFoldedTs":<max ts of the Aug 13 fold>}` read from the gate's ledger before running. Decide with Marcus at the deploy.
- [ ] **Step 3:** `source .env && bun scripts/ledger-fold.ts` — confirm paging output, month routing, and the new `ok` column in the appended run; commit the month file(s) and `.fold-state.json`.

---

## Self-review notes

- Spec coverage: #38's three defects → Tasks 3 (boundary + catch), 2 (refusal visibility), 1+3 (window/paging); #39 → Task 4; adapter-doc updates split by owning task (2: format, 3: operations). Watermark duplication-on-first-run handled in Task 6 Step 2.
- Type consistency: `LedgerEntryWire` (lib) is the single row type; runner helpers' signatures in Task 3's Produces match its test imports; `foldStatePath`/`FoldState` names used consistently.
- Test-asserted literals: every asserted header/row string in Tasks 1-3 appears verbatim in the implementation steps of the same task.
- Parallelism: Tasks 1, 2, 4 are wave 1 (independent); Task 3 waits on 1+2. No contract task was manufactured; the lib/runner split already existed.
