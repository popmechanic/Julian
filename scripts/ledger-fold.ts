#!/usr/bin/env bun
// scripts/ledger-fold.ts — fetch the governor's ledger and fold it into
// dated markdown documents in memory/ledger/, one per UTC month, append-only.
//
// Authenticates with GATE_BREAKGLASS_SECRET, sourced from the Mac .env only
// inside this command (mail discipline rule 5: scope the secret, never as
// ambient session state) — e.g. `source .env && bun scripts/ledger-fold.ts`.
//
// Paging: the fetch walks /ledger backward with the compound cursor
// `before=<ts>&beforeId=<id>` until it crosses the watermark in
// memory/ledger/.fold-state.json, so a fold sees every row since the last
// run regardless of traffic volume. `id` is the row's sqlite rowid, unique
// per row; `ts` is bare Date.now() and distinct rows routinely share one
// millisecond. Only the compound key (ts, id) can place a cursor strictly
// inside such a tie, so a group larger than a page is neither dropped nor
// re-served — and the dedupe keys on `id` alone, never on row content,
// because byte-identical rows one millisecond apart are separate acts.
//
// The same compound key joins run to run: the watermark is (ts, id), not ts
// alone, so a row that shares the last folded millisecond but carries a
// higher id is still new. And the walk ends on the record, never on page
// size — a page reaching under the watermark, or an empty page — because the
// gate's own limit clamp lives in another package and `length < LEDGER_LIMIT`
// would silently drop the ledger's tail the day that clamp moved.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { foldEntries, groupByMonth, type LedgerEntryWire } from './lib/ledger-fold';

/**
 * The wire row as the gate serves it since 2026-08-20 (#38): every field of
 * `LedgerEntryWire` plus `id`, the ledger table's sqlite rowid. The lib's
 * fold takes the fields it prints; only the pager needs the identity.
 */
export interface LedgerRowWire extends LedgerEntryWire {
  id: number;
}

interface LedgerResponse {
  entries: LedgerRowWire[];
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

/**
 * The run-to-run join, compound because `ts` is not an identity: the last
 * folded row is named by (ts, id), so a row sharing that millisecond with a
 * higher id is correctly still new.
 */
export interface FoldState {
  lastFoldedTs: number;
  lastFoldedId: number;
}

export function foldStatePath(baseDir: string): string {
  return join(baseDir, '.fold-state.json');
}

export async function readFoldState(path: string): Promise<FoldState> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { lastFoldedTs: 0, lastFoldedId: 0 };
    throw e;
  }
  const parsed = JSON.parse(raw) as Partial<FoldState> | null; // malformed JSON throws — fail loud, never refold from zero
  if (typeof parsed?.lastFoldedTs !== 'number' || !Number.isFinite(parsed.lastFoldedTs)) {
    throw new Error(`fold state malformed at ${path}: ${raw.slice(0, 80)}`);
  }

  // A state file written before 2026-08-20 (#38) carries no `lastFoldedId`.
  // Reading its absence as 0 re-folds any row sharing that millisecond — the
  // ts-only shape cannot say which of a tie it already took, and duplication
  // under a fresh run marker is recoverable where a dropped row is not.
  // A *present* id that isn't a finite number is corruption, not an old
  // shape, and gets the same loud refusal as a corrupt ts.
  const rawId = parsed.lastFoldedId;
  const idAbsent = rawId === undefined || rawId === null;
  if (!idAbsent && (typeof rawId !== 'number' || !Number.isFinite(rawId))) {
    throw new Error(`fold state malformed at ${path}: ${raw.slice(0, 80)}`);
  }
  return { lastFoldedTs: parsed.lastFoldedTs, lastFoldedId: rawId ?? 0 };
}

export async function writeFoldState(path: string, s: FoldState): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(s)}\n`, 'utf8');
}

/**
 * Is this row past the watermark — i.e. did this run not already take it?
 *
 * An unreadable `ts` cannot be ordered against anything. Such a row is kept
 * (main() warns and skips it at append time) and, crucially, is never read as
 * the bottom of the new territory: letting a corrupt timestamp end the walk
 * would orphan every real row behind it.
 */
function isAboveWatermark(entry: LedgerRowWire, since: FoldState): boolean {
  if (!Number.isFinite(entry.ts)) return true;
  if (entry.ts !== since.lastFoldedTs) return entry.ts > since.lastFoldedTs;
  return entry.id > since.lastFoldedId;
}

/**
 * The watermark a successful run leaves: the largest `ts` folded, and the
 * largest `id` among the rows at that `ts`. Monotone by construction — it
 * starts from the prior watermark and only ever climbs, so a short or empty
 * run can never walk the join backward and re-fold the record.
 */
export function nextWatermark(entries: LedgerRowWire[], prev: FoldState): FoldState {
  let ts = prev.lastFoldedTs;
  for (const e of entries) {
    if (Number.isFinite(e.ts) && e.ts > ts) ts = e.ts;
  }
  let id = ts === prev.lastFoldedTs ? prev.lastFoldedId : 0;
  for (const e of entries) {
    if (e.ts === ts && Number.isFinite(e.id) && e.id > id) id = e.id;
  }
  return { lastFoldedTs: ts, lastFoldedId: id };
}

/**
 * Fetch every ledger row above the compound watermark, newest-first, paging
 * backward with the compound cursor `(before, beforeId)` — the gate's
 * `ts < before OR (ts = before AND rowid < beforeId)`.
 *
 * The cursor is strictly exclusive on the total order (ts DESC, id DESC),
 * so pages neither overlap nor skip: a same-millisecond group larger than a
 * page is walked through, not jumped over. Dedupe keys on `id` alone —
 * keying on row content would collapse byte-identical rows (the same verb
 * spent twice in one millisecond is two acts, not one) and lose the
 * duplicate, which the append-only record can never recover.
 */
export async function pageLedger(
  brokerUrl: string,
  secret: string,
  since: FoldState,
  fetchImpl: typeof fetch = fetch,
): Promise<LedgerRowWire[]> {
  const out: LedgerRowWire[] = [];
  const seen = new Set<number>();
  let cursor: { before: number; beforeId: number } | undefined;

  for (;;) {
    const cursorQuery =
      cursor === undefined ? '' : `&before=${cursor.before}&beforeId=${cursor.beforeId}`;
    const res = await fetchImpl(
      `${trimSlash(brokerUrl)}/ledger?limit=${LEDGER_LIMIT}${cursorQuery}`,
      { headers: { 'X-Breakglass-Secret': secret } },
    );
    if (!res.ok) throw new Error(`Failed to fetch ledger (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as LedgerResponse | null;
    if (!body || !Array.isArray(body.entries))
      throw new Error('Ledger response malformed: missing entries array');

    // The ledger is exhausted — the only page-size fact the walk may read,
    // because it is about the record and not about anyone's limit clamp.
    if (body.entries.length === 0) return out;

    let crossedWatermark = false;
    let newThisPage = 0;
    for (const entry of body.entries) {
      // A row with no id means the deployed gate predates the compound-cursor
      // contract (#38). There is no safe way to dedupe or page such rows, and
      // guessing risks collapsing distinct acts — so refuse, loudly.
      if (typeof entry.id !== 'number' || !Number.isFinite(entry.id)) {
        throw new Error(
          'Ledger row has no `id` — the deployed gate predates the compound-cursor contract (#38). ' +
            'Deploy the broker first, then fold; folding now could collapse distinct same-millisecond rows.',
        );
      }
      if (!isAboveWatermark(entry, since)) {
        crossedWatermark = true;
        continue;
      }
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        out.push(entry);
        newThisPage += 1;
      }
    }

    // The gate serves (ts DESC, id DESC), so the first row at-or-below the
    // watermark proves every row after it is older still: this run's new
    // territory ends here. Page size is never the completion signal — the
    // gate's MAX_LIMIT clamp lives in another package, and reading
    // `length < LEDGER_LIMIT` as "last page" would silently drop the whole
    // tail of the ledger the day that clamp dropped below this limit.
    if (crossedWatermark) return out;

    // A non-empty page of rows all above the watermark that yielded nothing
    // new means the cursor did not move. Against a gate honoring the
    // exclusive compound cursor this cannot happen — it is a tripwire, not a
    // code path. Resolving here would fold a partial set and advance the
    // watermark past rows this run never reached, orphaning them forever, so
    // it throws: nothing is appended and the watermark file is left alone.
    if (newThisPage === 0) {
      const at = cursor ? `before=${cursor.before}&beforeId=${cursor.beforeId}` : 'no cursor';
      throw new Error(
        `Ledger cursor is not advancing (${at}): a page of ${body.entries.length} row(s) above the watermark ` +
          'yielded nothing new. Refusing to fold a partial set — advancing the watermark now would orphan ' +
          'every row past it.',
      );
    }

    const oldest = body.entries[body.entries.length - 1];
    if (!Number.isFinite(oldest.ts)) {
      throw new Error(
        `Ledger row id=${oldest.id} has an unreadable ts (${String(oldest.ts)}); a page cursor cannot be ` +
          'placed on it, and guessing past it would skip the rows behind it.',
      );
    }
    cursor = { before: oldest.ts, beforeId: oldest.id };
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
    const entries = await pageLedger(brokerUrl, secret, state);
    if (entries.length === 0) {
      process.stdout.write(
        `Nothing new since watermark ${state.lastFoldedTs}/${state.lastFoldedId}.\n`,
      );
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
    let appended = 0;
    for (const month of months) {
      const rows = grouped.get(month)!;
      const ledgerPath = getLedgerPath(ledgerDir, month);
      await appendToLedgerFile(ledgerPath, foldEntries(rows, month));
      appended += rows.length;
      process.stdout.write(`Ledger folded: ${ledgerPath} (${rows.length} rows)\n`);
    }

    // Advance only after every append succeeded: a partial failure re-appends
    // next run (duplication, separated by run markers) — never loss. The
    // count reports rows actually written, so an undated row is warned about
    // once and never counted as folded.
    const watermark = nextWatermark(entries, state);
    await writeFoldState(statePath, watermark);
    process.stdout.write(
      `Rows folded: ${appended}; watermark → ${watermark.lastFoldedTs}/${watermark.lastFoldedId}\n`,
    );
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

// Importable for tests; runs only when invoked as the command.
if (import.meta.main) {
  void main();
}
