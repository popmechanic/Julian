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
