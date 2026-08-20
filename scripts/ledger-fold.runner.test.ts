import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { promises as nodeFs } from 'node:fs';
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

/** The wire row as the redirected gate serves it — `id` is the sqlite rowid. */
interface WireRow extends LedgerEntryWire {
  id: number;
}

function row(id: number, ts: number, detail: string): WireRow {
  return { id, ts, sub: 's', service: 'mail', verb: 'send', detail, allowed: 1 };
}

/** Read back the ids pageLedger returned (its declared type hides the field). */
function idsOf(entries: LedgerEntryWire[]): number[] {
  return entries.map((e) => (e as WireRow).id);
}

/**
 * A miniature of the gate's `/ledger` face (broker/src/as/admin.ts +
 * GovernorDO.entries): rows ordered `ts DESC, rowid DESC`, and the compound
 * cursor filtering `ts < before OR (ts = before AND id < beforeId)`. Serving
 * the real ordering and the real cursor is what makes the straddle test a
 * proof rather than a restatement of the runner's own assumptions.
 */
function gateFrom(rows: WireRow[], calls: string[]): typeof fetch {
  const sorted = [...rows].sort((a, b) => b.ts - a.ts || b.id - a.id);
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.search);
    const limit = Number(url.searchParams.get('limit'));
    const beforeRaw = url.searchParams.get('before');
    const beforeIdRaw = url.searchParams.get('beforeId');

    let visible = sorted;
    if (beforeRaw !== null) {
      const before = Number(beforeRaw);
      if (beforeIdRaw !== null) {
        const beforeId = Number(beforeIdRaw);
        visible = sorted.filter((e) => e.ts < before || (e.ts === before && e.id < beforeId));
      } else {
        visible = sorted.filter((e) => e.ts < before);
      }
    }
    return new Response(JSON.stringify({ entries: visible.slice(0, limit) }), { status: 200 });
  }) as typeof fetch;
}

/** 450 rows, one per millisecond — the plain multi-page case. */
function fetchFromPages(calls: string[]): typeof fetch {
  const all: WireRow[] = [];
  for (let i = 0; i < 450; i++) all.push(row(i + 1, 1_000_000 + i, `r${i}`));
  return gateFrom(all, calls);
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
    expect(calls[1]).toContain('beforeId='); // …and it is the compound cursor
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

describe('pageLedger same-millisecond rows (#38 redirect)', () => {
  test('three byte-identical rows in one millisecond all reach the fold', async () => {
    // Identical in every wire field except `id`. Keying the dedupe on the row
    // content collapsed these three real, separately-ledgered acts into one.
    const calls: string[] = [];
    const rows = [1, 2, 3].map((id) => row(id, 1_700_000_000_000, 'same'));
    const got = await pageLedger('https://gate.example', 'secret', 0, gateFrom(rows, calls));

    expect(got.length).toBe(3);
    expect(idsOf(got)).toEqual([3, 2, 1]); // newest-first by (ts, id)
    expect(calls.length).toBe(1);
  });

  test('a same-ts group straddling a page boundary pages losslessly', async () => {
    // 150 rows at distinct milliseconds, then 100 rows sharing ONE older
    // millisecond: the tie group opens inside page 1 (200 rows) and finishes
    // on page 2. A ts-only cursor must either re-serve or drop that group.
    const calls: string[] = [];
    const rows: WireRow[] = [];
    for (let i = 0; i < 150; i++) rows.push(row(1000 + i, 2_000_000 + i, `u${i}`));
    const tieTs = 1_999_999;
    for (let i = 0; i < 100; i++) rows.push(row(2000 + i, tieTs, `t${i}`));

    const got = await pageLedger('https://gate.example', 'secret', 0, gateFrom(rows, calls));

    expect(got.length).toBe(250); // every row, exactly once
    expect(new Set(idsOf(got)).size).toBe(250);
    expect(calls.length).toBe(2);
    // Page 2 is requested with the compound cursor pinned to the tie group's
    // boundary row — the only cursor that can land strictly inside a tie.
    expect(calls[1]).toContain(`before=${tieTs}`);
    expect(calls[1]).toContain('beforeId=2050');
    // All 100 tie rows survive, newest-id first.
    expect(idsOf(got).slice(150)).toEqual(
      Array.from({ length: 100 }, (_, i) => 2099 - i),
    );
  });

  test('a gate serving rows without id aborts: deploy the broker first', async () => {
    // An id-less row means the deployed gate predates the compound-cursor
    // contract. Folding anyway risks collapsing distinct rows, so the runner
    // refuses rather than guessing (fail toward duplication, never loss).
    const legacy = (async () =>
      new Response(
        JSON.stringify({
          entries: [{ ts: 1_700_000_000_000, sub: 's', service: 'mail', verb: 'send', detail: 'd', allowed: 1 }],
        }),
        { status: 200 },
      )) as typeof fetch;

    await expect(pageLedger('https://gate.example', 's', 0, legacy)).rejects.toThrow(
      /deploy the broker/i,
    );
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
    const path = join(dir, '2026-08.md');
    const priorBytes = '*Appended run — 2026-08-19T00:00:00.000Z*\n\nrows already on disk\n';
    await writeFile(path, priorBytes, 'utf8');

    // Stub the exact readFile the runner calls so the fault lands in the catch
    // under test. A parent-is-a-file fixture would reject at the mkdir above
    // it (EEXIST) and never reach the read, satisfying the assertion by
    // accident — and any fixture that also breaks the write (e.g. a directory
    // in the month file's place) rejects even when the read is swallowed.
    // EACCES on read alone leaves the write viable, so a swallowing catch
    // would resolve here and truncate the month file.
    const spy = vi
      .spyOn(nodeFs, 'readFile')
      .mockRejectedValue(
        Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' }),
      );
    try {
      await expect(appendToLedgerFile(path, 'content')).rejects.toThrow(/EACCES/);
    } finally {
      spy.mockRestore();
    }

    // The bytes already on disk are exactly as they were: append-only holds
    // even when the read fails.
    expect(await readFile(path, 'utf8')).toBe(priorBytes);
  });

  test('ENOENT still opens the month normally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-append-'));
    const path = join(dir, '2026-08.md');
    await appendToLedgerFile(path, 'first', new Date('2026-08-20T00:00:00Z'));
    expect(await readFile(path, 'utf8')).toContain('first');
  });
});
