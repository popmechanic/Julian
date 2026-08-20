#!/usr/bin/env bun
// scripts/ledger-fold.ts — fetch the governor's ledger and fold it into
// dated markdown documents in memory/ledger/, one per UTC month, append-only.
//
// Authenticates with GATE_BREAKGLASS_SECRET, sourced from the Mac .env only
// inside this command (mail discipline rule 5: scope the secret, never as
// ambient session state) — e.g. `source .env && bun scripts/ledger-fold.ts`.
//
// Paging: the fetch walks /ledger?limit=200&before=<ts> backward until it
// crosses the watermark in memory/ledger/.fold-state.json, so a fold sees
// every row since the last run regardless of traffic volume. Pages overlap
// by one millisecond at the boundary and are deduped, so same-ms rows
// straddling a page break are never lost.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { foldEntries, groupByMonth, type LedgerEntryWire } from './lib/ledger-fold';

interface LedgerResponse {
  entries: LedgerEntryWire[];
}

const LEDGER_LIMIT = 200;

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

export function getUtcMonth(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function getLedgerPath(baseDir: string, monthUtc: string): string {
  return join(baseDir, `${monthUtc}.md`);
}

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
    if (!body || !Array.isArray(body.entries))
      throw new Error('Ledger response malformed: missing entries array');

    let crossedWatermark = false;
    for (const entry of body.entries) {
      if (entry.ts <= sinceTs) {
        crossedWatermark = true;
        continue;
      }
      const key = JSON.stringify([
        entry.ts,
        entry.sub,
        entry.service,
        entry.verb,
        entry.detail,
        entry.allowed,
      ]);
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
      process.stderr.write(
        `warning: ledger page pinned at ts=${smallest}; folding what was reachable.\n`,
      );
      return out;
    }
    before = next;
  }
}

/**
 * Append-only: a month file, once written, is never rewritten. A second run
 * lands after a horizontal rule and a dated run marker, leaving every byte
 * already on disk exactly where it was.
 */
export async function appendToLedgerFile(
  path: string,
  content: string,
  runAt: Date = new Date(),
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });

  let existing = '';
  try {
    existing = await fs.readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // never truncate on a real IO error
    // ENOENT: no file yet — this run opens the month.
  }

  // Every run — including the one that opens the month — is marked with its
  // own timestamp. The first run has no prior text to separate from, so it
  // skips the horizontal rule; every run after it gets one.
  const marker = `*Appended run — ${runAt.toISOString()}*`;
  const addition = existing ? `\n\n---\n\n${marker}\n\n${content}` : `${marker}\n\n${content}`;

  await fs.writeFile(path, existing + addition, 'utf8');
}

async function main(): Promise<void> {
  const brokerUrl = process.env.BROKER_URL;
  const secret = process.env.GATE_BREAKGLASS_SECRET;

  if (!brokerUrl) {
    process.stderr.write('BROKER_URL not set.\n');
    process.exit(2);
  }
  if (!secret) {
    process.stderr.write(
      'GATE_BREAKGLASS_SECRET not set — source .env for this command only, then retry.\n',
    );
    process.exit(2);
  }

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
      process.stderr.write(
        `warning: ${undated.length} row(s) with unreadable ts skipped (cannot be dated into a month file).\n`,
      );
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
    const newWatermark = entries.reduce(
      (max, e) => (Number.isFinite(e.ts) && e.ts > max ? e.ts : max),
      state.lastFoldedTs,
    );
    await writeFoldState(statePath, { lastFoldedTs: newWatermark });
    process.stdout.write(`Rows folded: ${entries.length}; watermark → ${newWatermark}\n`);
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

// Importable for tests; runs only when invoked as the command.
if (import.meta.main) {
  void main();
}
