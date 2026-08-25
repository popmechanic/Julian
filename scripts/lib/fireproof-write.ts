// scripts/lib/fireproof-write.ts — one unfragmented frame per transaction; verification is the /export comparison.
import { WebSocket } from 'ws';
import type { MergeableStore } from 'tinybase/mergeable-store';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { createStreamStore } from 'julian-shared/schema';
import type { MappedRow } from './fireproof-types';
import { BATCH_CAP_UNITS, FRAME_LIMIT_UNITS } from './fireproof-types';

// Global constraint: every WebSocket synchronizer sets an explicit 256 KiB
// fragment size (7th positional arg) — Cloudflare caps WS messages at ~1 MiB.
const FRAGMENT_SIZE = 262_144;
// Bounds the initial pull in openStore — see the comment there for why it is short.
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 5;
// close() waits for the socket's send queue to empty before it tears the socket down.
const DRAIN_POLL_MS = 50;
const DRAIN_TIMEOUT_MS = 30_000;
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

// Poll a socket until it has nothing left queued. `ws.close()` (and the
// synchronizer's own destroy, which calls it) can cut an in-flight frame, and a
// half-sent frame is indistinguishable from a dropped one at the far end — it
// just burns a retry round. Draining first makes the close deliberate.
export async function awaitDrain(
  ws: { bufferedAmount: number },
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? DRAIN_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DRAIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (ws.bufferedAmount > 0) {
    if (Date.now() >= deadline) throw new Error(`socket did not drain: ${ws.bufferedAmount} bytes buffered`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// The frame guard is structural rather than a throwing callback: a throw raised
// inside TinyBase's onSend travels back up the persister's save path mid-write,
// where it either tears the socket or is silently swallowed. openStore records
// each violation instead, and the caller fails loud at a place of its own
// choosing — after the writes are flushed and the socket closed.
export function assertNoFrameViolations(violations: readonly number[]): void {
  if (!violations.length) return;
  throw new Error(
    `frame over limit: ${violations.length} frame(s) exceeded ${FRAME_LIMIT_UNITS} units ` +
    `(largest ${Math.max(...violations)} units)`,
  );
}

export async function openStore(opts: { url: string; token: string; requestTimeoutSeconds?: number; onFrameTooBig?: (units: number) => void }) {
  const store = createStreamStore('import-' + Math.random().toString(36).slice(2));
  // The lease token rides only in the Authorization header — never in the URL,
  // where it would land in proxy and server logs.
  const ws = new WebSocket(opts.url, { headers: { Authorization: `Bearer ${opts.token}` } });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const errors: unknown[] = [];
  const frameViolations: number[] = [];
  const sync = await createWsSynchronizer(
    store, ws as never, opts.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS,
    (_to: unknown, requestId: unknown, message: unknown, body: unknown) => {
      const units = JSON.stringify([requestId, message, body]).length;
      // Record first, notify second — a caller-supplied callback that throws must
      // not be able to lose the violation it was told about.
      if (units > FRAME_LIMIT_UNITS) { frameViolations.push(units); opts.onFrameTooBig?.(units); }
    },
    undefined,
    (e: unknown) => errors.push(e),
    FRAGMENT_SIZE,
  );
  // startSync() holds the persister in its Loading status — suppressing every
  // save, and registering no receive listener — until its initial pull settles.
  // That pull is a GetContentHashes request nobody answers when we are alone on
  // the path, so it settles only on the request timeout: the whole store is inert
  // until then. Hence the short default. It costs nothing here — this client only
  // ever pushes, its sends are fire-and-forget, and delivery is proven by the
  // export comparison, not by the pull.
  await sync.startSync();
  return {
    store, sync, ws, errors, frameViolations,
    // Drain before destroying: sync.destroy() closes the socket, and a close that
    // lands on a partly-written frame loses it silently.
    close: async () => { await awaitDrain(ws); await sync.destroy(); ws.close(); },
  };
}

type CellStamp = [unknown, string, number];

// The DO's `/export` returns `store.getMergeableContent()`, whose tables, table
// and row levels are each a stamp `[node, hlc, hash]`; a level that arrives as a
// plain object (a flattened export, or a hand-written fixture) is passed through
// unchanged. Cell level is never unwrapped — a cell IS its `[value, hlc, hash]`.
function level(node: unknown): Record<string, unknown> {
  if (Array.isArray(node) && node.length === 3) {
    const inner = node[0];
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  }
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) return node as Record<string, unknown>;
  return {};
}

export function compareExport(rows: MappedRow[], exported: unknown) {
  const tables = level((exported as unknown[] | undefined)?.[0]);
  const msgs = level(tables.messages);
  const equal: string[] = [], mismatched: string[] = [], missing: string[] = [], droppedMarker: string[] = [];
  for (const r of rows) {
    const got = msgs[r.id];
    if (got === undefined) { missing.push(r.id); continue; }
    const cells = level(got);
    // Scoped to the rows being compared: the live store already holds rows this
    // annex never wrote, and a marker on one of those is somebody else's history,
    // not a fault in this write — reporting it would abort an otherwise clean import.
    if (Object.values(cells).some((c) => (c as CellStamp | undefined)?.[0] === DROPPED_MARKER)) droppedMarker.push(r.id);
    const { id, ...mapped } = r; void id;
    const ok = Object.entries(mapped).every(([k, v]) => {
      const e = (cells[k] as CellStamp | undefined)?.[0];
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
    } finally { await conn.close(); }
    // Both checks run after the writes are flushed and the socket is closed, and
    // before the export is fetched: an oversize frame or a synchronizer error
    // means this round's picture of the server cannot be trusted at all.
    assertNoFrameViolations(conn.frameViolations);
    if (conn.errors.length) throw new Error(`synchronizer errors: ${conn.errors.map(String).join('; ')}`);
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
  assertNoFrameViolations(conn.frameViolations);
  if (conn.errors.length) throw new Error(`synchronizer errors: ${conn.errors.map(String).join('; ')}`);
  const final = compareExport([...opts.rows, opts.receipt], await opts.fetchExport());
  if (final.missing.length || final.mismatched.length) throw new Error('receipt did not verify — re-run required');
  return { rounds, report: final };
}
