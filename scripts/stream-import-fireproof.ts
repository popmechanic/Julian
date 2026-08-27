// scripts/stream-import-fireproof.ts — run with:
//   bun scripts/stream-import-fireproof.ts [--manifest-out [path]] [--allow-ts id,id]
//   bun scripts/stream-import-fireproof.ts --write --receipt-text <file>
//
// Spec: docs/superpowers/specs/2026-08-25-fireproof-import-design.md.
//
// Dry run by default: nothing is written anywhere but the session-id manifest,
// and no message text is ever printed. The report is counts, ids, speaker names,
// and ranges — enough to witness the shape of the annex without reading a word
// of the March conversations back out of the condemned ledger.
//
// The write path is the irreversible half, and it is deliberately narrow: a
// non-legacy token, one socket opened purely to assert the lease, a server-side
// /export read that pins the ledger identity and proves no receipt row already
// exists, the full battery of hard checks, and only then the batched import.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStreamStore, STORE_PATH } from 'julian-shared/schema';
import { decodeUndefined } from 'julian-shared/export-codec';
import {
  extractMembers,
  readBlobs,
  readKeys,
  readLedgers,
  sweepStaleTmp,
  verifyAgainstManifest,
  verifyArchive,
  withTempDir,
} from './lib/fireproof-archive';
import { decryptLedger, importKeys } from './lib/fireproof-decode';
import {
  buildReceipt,
  cellJsonBytes,
  collapseSplits,
  filterDocs,
  hardChecks,
  mapMessage,
  selectVersions,
} from './lib/fireproof-map';
import { assertNoFrameViolations, importRows, openStore, planBatches, writeBatch } from './lib/fireproof-write';
import { resolveAccessToken, resolveLeasePath } from './lib/lease-client';
import {
  ARCHIVE_PATH,
  ARCHIVE_ROOT,
  ARCHIVE_SHA256,
  FEB_START_MS,
  LIVE_LEDGER_ID,
  MAR_START_MS,
} from './lib/fireproof-types';
import type { DecodedDoc, LedgerInfo, MappedRow } from './lib/fireproof-types';

const SYNC_BASE = process.env.SYNC_BASE ?? 'https://sync.julian.soul.store';
const SYNC_WS = process.env.SYNC_WS ?? 'wss://sync.julian.soul.store';
const BROKER_URL = process.env.BROKER_URL ?? 'https://gate.julian.soul.store';
const DEFAULT_MANIFEST_OUT = './fireproof-annex-manifest.txt';

// GATE FINDING (round 1): a throw raised from inside TinyBase's onSend (as
// `openStore`'s `onFrameTooBig` used to do here) travels back up the
// persister's save path mid-write, where it can tear the socket or be
// silently swallowed — untested, unsafe territory. `openStore` in
// fireproof-write.ts already records every violation before it ever calls
// this callback, so the callback below only accumulates and logs; the
// decision of whether to refuse happens here, at a place of this module's
// own choosing, once importRows has settled (resolved or rejected) and the
// socket is already closed. The CLI must never print a success report when
// any frame exceeded the limit — see `doWrite`.
//
// GATE FINDING (round 2): this module used to export its own same-named
// `assertNoFrameViolations(n: number)`, shadowing the richer
// `assertNoFrameViolations(readonly number[])` that fireproof-write.ts
// already exports and that `importRows` already calls (via
// `assertConnectionClean`) after every round's flush. Because `doWrite`
// re-asserted unconditionally in a `finally`, an upstream rejection from
// importRows — carrying the "largest N units" detail — was being thrown
// *over* by this module's poorer-detail throw. `frameViolationOutcome`
// below is the fix: it defers entirely to the imported assertNoFrameViolations
// (so the richer message, when it fires, is the only one that ever surfaces)
// and never re-throws when importRows itself already rejected — an upstream
// error must never be masked.
export function frameViolationOutcome(units: readonly number[], importRejected: boolean): void {
  if (importRejected) return; // the original rejection stands; nothing here may replace it
  assertNoFrameViolations(units);
}

interface Options {
  write: boolean;
  receiptText?: string;
  allowIds: Set<string>;
  manifestOut?: string;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { write: false, allowIds: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === '--write') opts.write = true;
    else if (a === '--receipt-text') opts.receiptText = value();
    else if (a === '--allow-ts') for (const id of value().split(',')) { if (id.trim()) opts.allowIds.add(id.trim()); }
    else if (a === '--manifest-out') {
      const next = argv[i + 1];
      opts.manifestOut = next !== undefined && !next.startsWith('--') ? argv[++i] : DEFAULT_MANIFEST_OUT;
    } else throw new Error(`unknown flag: ${a}`);
  }
  if (opts.write && !opts.receiptText) throw new Error('--write requires --receipt-text <file> (the witnessed sentence)');
  return opts;
}

// A TinyBase mergeable node is `[node, hlc, hash]` at the tables, table and row
// levels; a cell IS its `[value, hlc, hash]`. Unwrap defensively so a flattened
// export or a hand-shaped fixture reads the same as the live one.
function level(node: unknown): Record<string, unknown> {
  if (Array.isArray(node) && node.length === 3) {
    const inner = node[0];
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  }
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) return node as Record<string, unknown>;
  return {};
}

const cellValue = (cell: unknown): unknown => (Array.isArray(cell) ? cell[0] : cell);

// MANIFEST.txt names members either from the archive's parent (`./<root>/…`) or
// from inside the root (`./d1/…` — which is what this archive does). Decide once,
// from the manifest itself, so a mismatch reported later is a real digest
// mismatch and not a naming artefact, and hand back the matching hash root.
export function manifestScope(dir: string, manifestText: string, members: string[]): { root: string; keys: string[] } {
  const rooted = manifestText.includes(`./${ARCHIVE_ROOT}/`);
  const strip = (m: string) => (m.startsWith(`${ARCHIVE_ROOT}/`) ? m.slice(ARCHIVE_ROOT.length + 1) : m);
  return {
    root: rooted ? dir : join(dir, ARCHIVE_ROOT),
    keys: members.map((m) => `./${rooted ? m : strip(m)}`),
  };
}

// tar takes every member on one command line; chunk so a ledger with thousands
// of CARs cannot blow past ARG_MAX.
async function extractInChunks(members: string[], dest: string, chunk = 400): Promise<void> {
  for (let i = 0; i < members.length; i += chunk) {
    await extractMembers(ARCHIVE_PATH, members.slice(i, i + chunk), dest);
  }
}

// The units a batch actually costs on the wire: measured inside the transaction,
// on a scratch store, exactly as planBatches measures a single row.
function measureUnits(batches: MappedRow[][]): number {
  const scratch = createStreamStore('measure');
  let last = 0;
  scratch.addDidFinishTransactionListener((s) => { last = JSON.stringify(s.getTransactionMergeableChanges()).length; });
  let total = 0;
  for (const batch of batches) {
    scratch.transaction(() => writeBatch(scratch, batch));
    total += last;
  }
  return total;
}

const iso = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms));

interface LedgerReport {
  ledger: LedgerInfo;
  carsTotal: number;
  carsOpened: number;
  skipped: Array<{ blobId: string; reason: string }>;
  uniqueMessages: number;
  emptyIds: number;
  minTs: number;
  maxTs: number;
  speakerNames: string[];
  droppedByType: Record<string, number>;
}

// An empty is an *id*, not a write. A streaming message is written dozens of
// times and the first writes carry no text at all; counting those would bury
// the report. An id is empty only if no version of it, in any ledger, ever
// produced a row — and the block types printed are its last version's.
interface EmptyCandidate { id: string; blockTypes: string[]; uploaded: number }

async function gather(dir: string) {
  // MANIFEST.txt is the vouching document, not a vouched-for member — it does
  // not hash itself, so it is extracted with the rest and verified against
  // nothing. Every other member is checked.
  const manifestMember = `${ARCHIVE_ROOT}/MANIFEST.txt`;
  const pass1 = [
    `${ARCHIVE_ROOT}/d1/d1-main.sqlite`,
    `${ARCHIVE_ROOT}/r2/r2-metadata.sqlite`,
    `${ARCHIVE_ROOT}/dashboard/dashboard-sqlite.db`,
  ];
  await extractMembers(ARCHIVE_PATH, [manifestMember, ...pass1], dir);
  const manifestText = readFileSync(join(dir, ARCHIVE_ROOT, 'MANIFEST.txt'), 'utf8');

  const dashboardDb = join(dir, ARCHIVE_ROOT, 'dashboard', 'dashboard-sqlite.db');
  const d1Db = join(dir, ARCHIVE_ROOT, 'd1', 'd1-main.sqlite');
  const r2Db = join(dir, ARCHIVE_ROOT, 'r2', 'r2-metadata.sqlite');

  const ledgers = readLedgers(dashboardDb);
  if (!ledgers.length) throw new Error('no julian-chat ledger found in the dashboard catalogue');

  const perLedger = ledgers.map((ledger) => ({
    ledger,
    blobs: readBlobs(r2Db, ledger.ledgerId),
    keys: readKeys(d1Db, ledger.ledgerId),
  }));

  const blobMembers = perLedger.flatMap((l) => l.blobs.map((b) => `${ARCHIVE_ROOT}/r2-blobs/blobs/${b.blobId}`));
  await extractInChunks(blobMembers, dir);

  const allMembers = [...pass1, ...blobMembers];
  const scope = manifestScope(dir, manifestText, allMembers);
  const bad = verifyAgainstManifest(scope.root, manifestText, scope.keys);
  if (bad.length) throw new Error(`manifest mismatch on ${bad.length} member(s): ${bad.slice(0, 20).join(', ')}`);
  console.log(`manifest verified: ${allMembers.length} member(s), 0 mismatches`);

  const blobsDir = join(dir, ARCHIVE_ROOT, 'r2-blobs', 'blobs');
  const reports: LedgerReport[] = [];
  const candidates: Array<{ row: MappedRow; uploaded: number; blobId: string }> = [];
  const emptyCandidates = new Map<string, EmptyCandidate>();
  const nonEmptyIds = new Set<string>();

  for (const { ledger, blobs, keys } of perLedger) {
    // Progress on stderr — ids and counts only, so a long run is legible without
    // putting anything on stdout that the manifest reader has to skip past.
    console.error(`decrypting ${ledger.ledgerId} (${blobs.length} cars, ${keys.length} keys)…`);
    const keyMap = await importKeys(keys);
    const skipped: Array<{ blobId: string; reason: string }> = [];
    const decoded: DecodedDoc[] = await decryptLedger({
      blobsDir, blobs, keys: keyMap, ledger,
      onSkip: (blobId, reason) => skipped.push({ blobId, reason }),
    });
    const { messages, droppedByType } = filterDocs(decoded);
    const ledgerEmpties = new Set<string>();
    const rows: MappedRow[] = [];
    for (const d of messages) {
      const id = String(d.doc._id);
      const row = mapMessage(d);
      if (!row) {
        const blocks = Array.isArray(d.doc.blocks) ? (d.doc.blocks as Array<Record<string, unknown>>) : [];
        const prev = emptyCandidates.get(id);
        if (!prev || d.uploaded >= prev.uploaded) {
          emptyCandidates.set(id, { id, blockTypes: blocks.map((b) => String(b?.type ?? '(none)')), uploaded: d.uploaded });
        }
        ledgerEmpties.add(id);
        continue;
      }
      nonEmptyIds.add(id);
      rows.push(row);
      candidates.push({ row, uploaded: d.uploaded, blobId: d.blobId });
    }
    for (const id of rows.map((r) => r.id)) ledgerEmpties.delete(id);
    const tss = rows.map((r) => r.ts).filter((t) => Number.isFinite(t));
    reports.push({
      ledger,
      carsTotal: blobs.length,
      carsOpened: blobs.length - skipped.length,
      skipped,
      uniqueMessages: new Set(rows.map((r) => r.id)).size,
      emptyIds: ledgerEmpties.size,
      minTs: tss.length ? Math.min(...tss) : NaN,
      maxTs: tss.length ? Math.max(...tss) : NaN,
      speakerNames: [...new Set(rows.map((r) => r.speakerName))].sort(),
      droppedByType,
    });
  }

  const empties = [...emptyCandidates.values()].filter((e) => !nonEmptyIds.has(e.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const { winners, violations } = selectVersions(candidates);
  const { rows, dropped } = collapseSplits(winners);
  return { reports, rows, violations, dropped, empties };
}

function sessionManifest(rows: MappedRow[]): string {
  const by = new Map<string, { count: number; minTs: number; maxTs: number }>();
  for (const r of rows) {
    const e = by.get(r.sessionId) ?? { count: 0, minTs: Infinity, maxTs: -Infinity };
    e.count++; e.minTs = Math.min(e.minTs, r.ts); e.maxTs = Math.max(e.maxTs, r.ts);
    by.set(r.sessionId, e);
  }
  return [...by.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([sessionId, e]) => `${sessionId}\t${e.count}\t${iso(e.minTs)}\t${iso(e.maxTs)}`)
    .join('\n');
}

function printReport(
  g: Awaited<ReturnType<typeof gather>>,
  batches: MappedRow[][],
  units: number,
  manifestOut: string | undefined,
): void {
  const { reports, rows, violations, dropped, empties } = g;
  console.log('');
  for (const r of reports) {
    console.log(`ledger ${r.ledger.ledgerId} (${r.ledger.name})`);
    console.log(`  cars opened ${r.carsOpened}/${r.carsTotal}, skipped ${r.skipped.length}`);
    for (const s of r.skipped) console.log(`    skipped ${s.blobId}: ${s.reason}`);
    console.log(`  unique messages ${r.uniqueMessages} (+${r.emptyIds} empty ids), ts range ${iso(r.minTs)} → ${iso(r.maxTs)}`);
    console.log(`  speaker names: ${r.speakerNames.join(', ') || '(none)'}`);
  }

  const droppedByType: Record<string, number> = {};
  for (const r of reports) for (const [t, n] of Object.entries(r.droppedByType)) droppedByType[t] = (droppedByType[t] ?? 0) + n;
  console.log('');
  console.log('dropped by doc type:');
  for (const [t, n] of Object.entries(droppedByType).sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n}`);

  console.log(`split drops (${dropped.length}):`);
  for (const d of dropped) console.log(`  ${d.id} → kept ${d.keptId}`);

  console.log(`prefix violations (${violations.length}):`);
  for (const v of violations) console.log(`  ${v.id}: ${v.note}`);

  console.log(`empties — ids no version of which ever carried text (${empties.length}):`);
  for (const e of empties) console.log(`  ${e.id}: [${e.blockTypes.join(', ')}]`);

  console.log('');
  console.log('ledger id → version name:');
  for (const r of reports) console.log(`  ${r.ledger.ledgerId} → ${r.ledger.name}`);

  const unparseableTs = rows.filter((r) => !Number.isFinite(r.ts));
  const outOfRange = rows.filter((r) => Number.isFinite(r.ts) && (r.ts < FEB_START_MS || r.ts >= MAR_START_MS));
  const tss = rows.map((r) => r.ts).filter((t) => Number.isFinite(t));
  const largestText = rows.reduce((m, r) => Math.max(m, cellJsonBytes(r.text)), 0);
  const largestContent = rows.reduce((m, r) => Math.max(m, r.content ? cellJsonBytes(r.content) : 0), 0);

  console.log('');
  console.log(`ts range ${tss.length ? `${iso(Math.min(...tss))} → ${iso(Math.max(...tss))}` : '(none)'}`);
  console.log(`ts unparseable: ${unparseableTs.length}${unparseableTs.length ? ` (${unparseableTs.map((r) => r.id).join(', ')})` : ''}`);
  console.log(`out of range: ${outOfRange.length}${outOfRange.length ? ` (${outOfRange.map((r) => r.id).join(', ')})` : ''}`);
  console.log(`largest text cell: ${largestText} bytes`);
  console.log(`largest content cell: ${largestContent} bytes`);
  console.log(`planned batches: ${batches.length}, total units: ${units}`);

  const manifest = sessionManifest(rows);
  if (manifestOut) {
    writeFileSync(manifestOut, manifest.endsWith('\n') ? manifest : `${manifest}\n`);
    console.log(`session-id manifest → ${manifestOut} (${manifest ? manifest.split('\n').length : 0} sessions)`);
  } else {
    console.log('');
    console.log('session-id manifest (sessionId\tcount\tminTs\tmaxTs):');
    console.log(manifest);
  }
  console.log(`expected rows: ${rows.length}`);
}

async function freshToken(): Promise<string> {
  const result = await resolveAccessToken(process.env, resolveLeasePath(process.env), BROKER_URL);
  if ('error' in result) throw new Error(`no access token: ${result.error}`);
  // A legacy bearer is the sunset window's credential — it carries no lease and
  // no scope, and this is the one write that must never ride on it.
  if (result.source === 'legacy') throw new Error('refusing a legacy bearer for the import — knock: bun scripts/door-knock.ts');
  return result.token;
}

async function fetchExportBody(token: string): Promise<{ mergeableContent: unknown; ledgerId: string | null }> {
  const res = await fetch(`${SYNC_BASE}/${STORE_PATH}/export`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/export failed: HTTP ${res.status}`);
  const body = (await res.json()) as { mergeableContent: unknown; ledgerId: string | null };
  // Issue #48: the wire form carries deletions as explicit markers; decode at
  // the boundary so every reader downstream sees the CRDT's own undefined.
  return { ...body, mergeableContent: decodeUndefined(body.mergeableContent) };
}

async function doWrite(rows: MappedRow[], opts: Options): Promise<void> {
  const token = await freshToken();

  // One socket, opened and closed, purely to assert the lease still stands
  // before anything irreversible is contemplated.
  const probe = await openStore({ url: `${SYNC_WS}/${STORE_PATH}`, token });
  await probe.close();
  console.log('lease asserted: one socket opened and closed');

  const body = await fetchExportBody(token);
  const mc = body.mergeableContent as unknown[];
  const tables = level(mc?.[0]);
  const msgs = level(tables.messages);
  const values = level(mc?.[1]);
  const serverLedger = cellValue(values.ledgerId);
  if (serverLedger !== LIVE_LEDGER_ID) throw new Error(`server ledgerId ${String(serverLedger)} !== ${LIVE_LEDGER_ID}`);

  const existing = new Map<string, string>();
  for (const [id, row] of Object.entries(msgs)) {
    existing.set(id, String(cellValue(level(row).sessionId) ?? ''));
    if (id.startsWith('fireproof-import-')) throw new Error(`a receipt row already exists on the server: ${id}`);
  }
  console.log(`server: ledgerId ${LIVE_LEDGER_ID}, ${existing.size} existing rows, no receipt row`);

  const checked = hardChecks(rows, { existing, allowIds: opts.allowIds });
  if (!checked.ok) throw new Error(`hard checks refused the write:\n  ${checked.errors.join('\n  ')}`);
  console.log(`hard checks passed for ${rows.length} rows`);

  const sentence = readFileSync(opts.receiptText as string, 'utf8').trim();
  if (!sentence) throw new Error('receipt text is empty');
  const receipt = buildReceipt(rows, new Date(), sentence);

  const frameUnits: number[] = [];
  let result: Awaited<ReturnType<typeof importRows>>;
  let importRejected = false;
  try {
    result = await importRows({
      rows,
      receipt,
      connect: async () =>
        openStore({
          url: `${SYNC_WS}/${STORE_PATH}`,
          token: await freshToken(),
          requestTimeoutSeconds: 60,
          onFrameTooBig: (u) => {
            frameUnits.push(u);
            console.error(`[import] frame over limit: ${u} units`);
          },
        }),
      fetchExport: async () => (await fetchExportBody(await freshToken())).mergeableContent,
      log: (s) => console.log(s),
    });
  } catch (e) {
    importRejected = true;
    throw e;
  } finally {
    // Runs whether importRows resolved or rejected. `importRows` itself already
    // asserts (via `assertConnectionClean`) after every round's flush, so a
    // rejection here already carries the richer "largest N units" message —
    // frameViolationOutcome defers to it and never re-throws over that
    // rejection. When importRows *resolved* despite a recorded violation
    // (frame accepted by the socket but still over the soft limit), this is
    // where the refusal happens instead, since a clean-looking report must
    // never ship with an over-limit frame behind it.
    if (frameUnits.length && importRejected) {
      console.error(`[import] ${frameUnits.length} frame(s) exceeded the limit before the failure above`);
    }
    frameViolationOutcome(frameUnits, importRejected);
  }
  console.log('');
  console.log(`import complete in ${result.rounds} round(s)`);
  console.log(`  equal ${result.report.equal.length}, mismatched ${result.report.mismatched.length}, missing ${result.report.missing.length}`);
  console.log(`  receipt row ${receipt.id} at ${iso(receipt.ts)}`);
  console.log(`  frame violations: ${frameUnits.length}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const swept = sweepStaleTmp();
  if (swept.length) console.log(`swept ${swept.length} stale temp dir(s)`);

  await verifyArchive(ARCHIVE_PATH, ARCHIVE_SHA256);
  console.log(`archive digest verified: ${ARCHIVE_SHA256}`);

  // Everything decrypted lives inside the temp dir, and the temp dir does not
  // outlive this call — the rows come back in memory, and the write half runs
  // with no plaintext on disk at all.
  const gathered = await withTempDir(gather);
  const batches = planBatches(gathered.rows);
  printReport(gathered, batches, measureUnits(batches), opts.manifestOut);

  if (opts.write) {
    console.log('');
    console.log('--write: proceeding to the server');
    await doWrite(gathered.rows, opts);
  } else {
    console.log('');
    console.log('dry run — nothing written. Re-run with --write --receipt-text <file> to annex.');
  }
}

// Top-level `await`, not a floating `main().catch(…)`. The decrypt phase is a
// long chain of pure in-process awaits with no OS handle pending; a floating
// promise lets Bun find the event loop empty and exit 0 in the middle of the
// run, having printed only the first few lines of the report. Awaiting the
// module's own evaluation holds the process open until the work is done.
// One catch, at the top: refusals throw, and this is where they surface.
//
// Guarded by `import.meta.main` so the test file can import this module's
// pure exports (e.g. `frameViolationOutcome`) without running the CLI —
// `bun scripts/stream-import-fireproof.ts` still executes exactly as before.
if (import.meta.main) {
  try {
    await main();
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
