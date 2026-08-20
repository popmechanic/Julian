import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { promises as nodeFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendToLedgerFile,
  foldStatePath,
  nextWatermark,
  pageLedger,
  readFoldState,
  writeFoldState,
  type FoldState,
  type LedgerRowWire,
} from './ledger-fold';

const GATE = 'https://gate.example';

/** The watermark of a repo that has never folded. */
const FRESH: FoldState = { lastFoldedTs: 0, lastFoldedId: 0 };

function row(id: number, ts: number, detail: string): LedgerRowWire {
  return { id, ts, sub: 's', service: 'mail', verb: 'send', detail, allowed: 1 };
}

function idsOf(entries: LedgerRowWire[]): number[] {
  return entries.map((e) => e.id);
}

/**
 * A miniature of the gate's `/ledger` face (broker/src/as/admin.ts +
 * GovernorDO.entries): rows ordered `ts DESC, rowid DESC`, and the compound
 * cursor filtering `ts < before OR (ts = before AND id < beforeId)`. Serving
 * the real ordering and the real cursor is what makes the straddle test a
 * proof rather than a restatement of the runner's own assumptions.
 *
 * `pageCap` models a gate whose own clamp is smaller than the limit the
 * runner asks for — the coupling the pager must not depend on.
 */
function gateFrom(rows: LedgerRowWire[], calls: string[], pageCap = Infinity): typeof fetch {
  const sorted = [...rows].sort((a, b) => b.ts - a.ts || b.id - a.id);
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.search);
    const limit = Math.min(Number(url.searchParams.get('limit')), pageCap);
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
  const all: LedgerRowWire[] = [];
  for (let i = 0; i < 450; i++) all.push(row(i + 1, 1_000_000 + i, `r${i}`));
  return gateFrom(all, calls);
}

describe('pageLedger', () => {
  test('pages backward to the watermark, dedupes the overlap, returns newest-first', async () => {
    const calls: string[] = [];
    // The watermark a real prior run would have left: the (ts, id) of r99.
    const got = await pageLedger(
      GATE,
      'secret',
      { lastFoldedTs: 1_000_099, lastFoldedId: 100 },
      fetchFromPages(calls),
    );
    expect(got.length).toBe(350); // rows r100..r449 (above the compound watermark)
    expect(got[0].detail).toBe('r449'); // newest first
    expect(got[got.length - 1].detail).toBe('r100');
    expect(new Set(got.map((e) => e.detail)).size).toBe(350); // no duplicates
    expect(calls.length).toBeGreaterThan(1); // it actually paged
    expect(calls[1]).toContain('before='); // cursor used from page 2 on
    expect(calls[1]).toContain('beforeId='); // …and it is the compound cursor
  });

  test('stops as soon as a page reaches under the watermark', async () => {
    const calls: string[] = [];
    const got = await pageLedger(
      GATE,
      'secret',
      { lastFoldedTs: 1_000_400, lastFoldedId: 401 },
      fetchFromPages(calls),
    );
    expect(got.length).toBe(49); // r401..r449
    // One page: rows ordered ts DESC, so the first row at-or-below the
    // watermark proves everything after it is older still.
    expect(calls.length).toBe(1);
  });

  test('malformed body throws instead of folding nothing silently', async () => {
    const bad = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    await expect(pageLedger(GATE, 's', FRESH, bad)).rejects.toThrow(/malformed/i);
  });
});

describe('pageLedger same-millisecond rows (#38 redirect)', () => {
  test('three byte-identical rows in one millisecond all reach the fold', async () => {
    // Identical in every wire field except `id`. Keying the dedupe on the row
    // content collapsed these three real, separately-ledgered acts into one.
    const calls: string[] = [];
    const rows = [1, 2, 3].map((id) => row(id, 1_700_000_000_000, 'same'));
    const got = await pageLedger(GATE, 'secret', FRESH, gateFrom(rows, calls));

    expect(got.length).toBe(3);
    expect(idsOf(got)).toEqual([3, 2, 1]); // newest-first by (ts, id)
    // Two calls, not one: the walk ends on an empty page, never on page size.
    expect(calls.length).toBe(2);
  });

  test('a same-ts group straddling a page boundary pages losslessly', async () => {
    // 150 rows at distinct milliseconds, then 100 rows sharing ONE older
    // millisecond: the tie group opens inside page 1 (200 rows) and finishes
    // on page 2. A ts-only cursor must either re-serve or drop that group.
    const calls: string[] = [];
    const rows: LedgerRowWire[] = [];
    for (let i = 0; i < 150; i++) rows.push(row(1000 + i, 2_000_000 + i, `u${i}`));
    const tieTs = 1_999_999;
    for (let i = 0; i < 100; i++) rows.push(row(2000 + i, tieTs, `t${i}`));

    const got = await pageLedger(GATE, 'secret', FRESH, gateFrom(rows, calls));

    expect(got.length).toBe(250); // every row, exactly once
    expect(new Set(idsOf(got)).size).toBe(250);
    expect(calls.length).toBe(3); // 200 + 50 + the empty page that ends the walk
    // Page 2 is requested with the compound cursor pinned to the tie group's
    // boundary row — the only cursor that can land strictly inside a tie.
    expect(calls[1]).toContain(`before=${tieTs}`);
    expect(calls[1]).toContain('beforeId=2050');
    // All 100 tie rows survive, newest-id first.
    expect(idsOf(got).slice(150)).toEqual(Array.from({ length: 100 }, (_, i) => 2099 - i));
  });

  test('a gate serving rows without id aborts: deploy the broker first', async () => {
    // An id-less row means the deployed gate predates the compound-cursor
    // contract. Folding anyway risks collapsing distinct rows, so the runner
    // refuses rather than guessing (fail toward duplication, never loss).
    const legacy = (async () =>
      new Response(
        JSON.stringify({
          entries: [
            { ts: 1_700_000_000_000, sub: 's', service: 'mail', verb: 'send', detail: 'd', allowed: 1 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    await expect(pageLedger(GATE, 's', FRESH, legacy)).rejects.toThrow(/deploy the broker/i);
  });
});

describe('pageLedger compound watermark join (#38 final)', () => {
  const tied = [row(7, 5_000, 'a'), row(8, 5_000, 'b')];

  test('a row sharing the watermark ts but carrying a higher id is folded', async () => {
    const got = await pageLedger(
      GATE,
      's',
      { lastFoldedTs: 5_000, lastFoldedId: 7 },
      gateFrom(tied, []),
    );
    expect(idsOf(got)).toEqual([8]);
  });

  test('the row at exactly the watermark (ts, id) is never re-folded', async () => {
    const got = await pageLedger(
      GATE,
      's',
      { lastFoldedTs: 5_000, lastFoldedId: 8 },
      gateFrom(tied, []),
    );
    expect(got).toEqual([]);
  });

  test('an old ts-only state file reads as (N, 0), so same-ts rows re-fold rather than vanish', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-state-'));
    const path = foldStatePath(dir);
    await writeFile(path, `${JSON.stringify({ lastFoldedTs: 5_000 })}\n`, 'utf8');

    const state = await readFoldState(path);
    expect(state).toEqual({ lastFoldedTs: 5_000, lastFoldedId: 0 });

    // Duplication (both rows fold again under a fresh run marker) is the
    // correct failure here; the ts-only shape cannot say which of the tie
    // it already took.
    const got = await pageLedger(GATE, 's', state, gateFrom(tied, []));
    expect(idsOf(got)).toEqual([8, 7]);
  });
});

describe('pageLedger termination (#38 final)', () => {
  test('a gate clamping pages far below the requested limit still yields every row', async () => {
    // The gate's own MAX_LIMIT clamp lives in another package. Reading
    // `page.length < LEDGER_LIMIT` as "last page" would silently drop
    // everything older the day that clamp moved.
    const calls: string[] = [];
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, 9_000 + i, `c${i}`));
    const got = await pageLedger(GATE, 's', FRESH, gateFrom(rows, calls, 3));

    expect(idsOf(got)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(calls.length).toBeGreaterThanOrEqual(4); // 3 + 3 + 3 + 1 + the empty page
  });

  test('a gate that ignores the cursor fails loud instead of folding a partial set', async () => {
    // No-progress is a tripwire, not a code path: with the compound cursor it
    // cannot happen against an honest gate. If it does, resolving would fold a
    // partial set and advance the watermark past rows never reached.
    const stuck = (async () =>
      new Response(
        JSON.stringify({ entries: [row(3, 7_000, 'x'), row(2, 7_000, 'y'), row(1, 7_000, 'z')] }),
        { status: 200 },
      )) as typeof fetch;

    await expect(pageLedger(GATE, 's', FRESH, stuck)).rejects.toThrow(/not advancing/i);
  });
});

describe('nextWatermark', () => {
  test('takes the max ts and the max id among the rows at that ts', () => {
    expect(nextWatermark([row(4, 200, 'a'), row(9, 300, 'b'), row(2, 300, 'c')], FRESH)).toEqual({
      lastFoldedTs: 300,
      lastFoldedId: 9,
    });
  });

  test('never moves backward: a lower max ts keeps the prior watermark', () => {
    expect(nextWatermark([row(1, 100, 'a')], { lastFoldedTs: 300, lastFoldedId: 9 })).toEqual({
      lastFoldedTs: 300,
      lastFoldedId: 9,
    });
  });

  test('an unreadable ts cannot set the watermark', () => {
    expect(nextWatermark([row(5, Number.NaN, 'bad'), row(3, 100, 'ok')], FRESH)).toEqual({
      lastFoldedTs: 100,
      lastFoldedId: 3,
    });
  });
});

describe('fold state', () => {
  test('ENOENT reads as the zero watermark; round-trip persists both fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-state-'));
    const path = foldStatePath(dir);
    expect(await readFoldState(path)).toEqual({ lastFoldedTs: 0, lastFoldedId: 0 });
    await writeFoldState(path, { lastFoldedTs: 42, lastFoldedId: 7 });
    expect(await readFoldState(path)).toEqual({ lastFoldedTs: 42, lastFoldedId: 7 });
  });

  test('corrupt state fails loud, never silently refolds from zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-state-'));
    const path = foldStatePath(dir);
    await writeFile(path, 'not json', 'utf8');
    await expect(readFoldState(path)).rejects.toThrow();
  });

  test('a present-but-garbage lastFoldedId fails loud rather than defaulting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-state-'));
    const path = foldStatePath(dir);
    await writeFile(path, JSON.stringify({ lastFoldedTs: 5, lastFoldedId: 'seven' }), 'utf8');
    await expect(readFoldState(path)).rejects.toThrow(/malformed/i);
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
