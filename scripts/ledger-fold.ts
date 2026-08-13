#!/usr/bin/env bun
// scripts/ledger-fold.ts — fetch the governor's ledger and fold it into
// dated markdown documents in memory/ledger/, one per UTC month, append-only.
//
// Authenticates with GATE_BREAKGLASS_SECRET, sourced from the Mac .env only
// inside this command (mail discipline rule 5: scope the secret, never as
// ambient session state) — e.g. `source .env && bun scripts/ledger-fold.ts`.
//
// Future work: `/ledger?limit=200` returns the most recent 200 rows. When a
// month's traffic outruns that window the fetch needs paging (a `before=<ts>`
// cursor on the gate's /ledger face); until then a fold can silently see only
// the tail, so run it often enough that 200 rows still cover the gap.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { foldEntries, type LedgerEntryWire } from './lib/ledger-fold';

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

async function fetchLedger(brokerUrl: string, secret: string): Promise<LedgerEntryWire[]> {
  const res = await fetch(`${trimSlash(brokerUrl)}/ledger?limit=${LEDGER_LIMIT}`, {
    headers: { 'X-Breakglass-Secret': secret },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ledger (${res.status}): ${await res.text()}`);
  }

  const body = (await res.json()) as LedgerResponse | null;
  if (!body || !Array.isArray(body.entries)) {
    throw new Error('Ledger response malformed: missing entries array');
  }

  return body.entries;
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
  } catch {
    // No file yet — this run opens the month.
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
    const entries = await fetchLedger(brokerUrl, secret);
    const monthUtc = getUtcMonth();
    const folded = foldEntries(entries, monthUtc);

    const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const ledgerPath = getLedgerPath(join(repoRoot, 'memory', 'ledger'), monthUtc);

    await appendToLedgerFile(ledgerPath, folded);

    process.stdout.write(`Ledger folded: ${ledgerPath}\n`);
    process.stdout.write(`Rows fetched: ${entries.length} (limit ${LEDGER_LIMIT})\n`);
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

// Importable for tests; runs only when invoked as the command.
if (import.meta.main) {
  void main();
}
