// sync/src/do.ts — JulianSyncDO: schema'd store, v9 fragmented SQLite persister,
// cell-size guard, and the witnessed export path (dream 0006, constraint 2).
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage';
import { createMiddleware, getHash } from 'tinybase';
import type { Middleware, Cell, Changes } from 'tinybase';
import type { MergeableStore } from 'tinybase/mergeable-store';
import { createStreamStore } from 'julian-shared/schema';

// Cloudflare's WS message cap is ~1 MiB; every synchronizer sets an explicit fragment size.
const FRAGMENT_SIZE = 262_144; // 256 KiB
// Any single cell whose JSON serialization exceeds this many bytes is rejected at the write boundary.
const MAX_CELL_JSON_BYTES = 65_536; // 64 KiB

// Written in place of a cell the guard rejected, so the drop leaves a receipt
// in the record instead of an indistinguishable empty string.
const DROPPED_MARKER = '[dropped: cell exceeded 64 KiB]';

const ENCODER = new TextEncoder();
const cellJsonBytes = (cell: Cell): number => ENCODER.encode(JSON.stringify(cell ?? '')).length;

export interface ExportedContent {
  mergeableContent: unknown;
  contentHash: number;
  ledgerId: string | null;
  exportedAt: string;
}

export class JulianSyncDO extends WsServerDurableObject {
  // Assigned in createPersister, which the parent constructor invokes (inside
  // blockConcurrencyWhile) BEFORE subclass field initializers would run — so the
  // store must NOT be a field initializer, or it would be constructed undefined
  // there and then silently overwritten with a second, unpersisted store.
  store!: MergeableStore;
  #middleware?: Middleware;
  // Cells stripped by the merge guard, awaiting an authoritative rewrite:
  // "<tableId> <rowId> <cellId>" -> the incoming cell's typeof.
  #oversized = new Map<string, string>();
  #flushing = false;

  createPersister() {
    this.store = createStreamStore();
    this.installGuards();
    // v9 fragmented mode = row-level SQLite layout (avoids Cloudflare's 2 MB row
    // limit). Never downgrade tinybase below 9 — the on-disk layout is breaking.
    return createDurableObjectSqlStoragePersister(this.store, this.ctx.storage.sql, {
      mode: 'fragmented',
    });
  }

  // Match the client fragment size so large payloads never exceed the WS cap.
  getFragmentSize(): number {
    return FRAGMENT_SIZE;
  }

  installGuards() {
    // Middleware (TinyBase v8+): reject any single cell whose JSON exceeds the
    // byte cap. Returning undefined from the callback rejects the write, leaving
    // the prior cell value intact.
    this.#middleware = createMiddleware(this.store);
    this.#middleware.addWillSetCellCallback((_tableId, _rowId, _cellId, cell) =>
      cellJsonBytes(cell) <= MAX_CELL_JSON_BYTES ? cell : undefined,
    );
    // Synchronizer merges (the DO's dominant write path) bypass willSetCell and
    // arrive through willApplyChanges as plain [tables, values, 1] with CRDT
    // stamps already stripped. Strip only the oversized cells so the rest of
    // the merge still lands; undefined entries are deletions and pass through.
    //
    // Stripping here only edits the plain store: applyMergeableChanges has
    // already merged the value into the stamp tree, which is what the
    // persister, the export, and every replica read. So the stripped cells are
    // recorded and authoritatively rewritten once the transaction finishes —
    // that write carries a newer HLC than the incoming one and converges the
    // oversized value away everywhere, instead of leaving the server's view
    // permanently disagreeing with each replica's.
    this.#middleware.addWillApplyChangesCallback(([tables, values, marker]) => {
      let dropped = false;
      const guarded: typeof tables = {};
      for (const [tableId, table] of Object.entries(tables ?? {})) {
        if (!table) {
          guarded[tableId] = table;
          continue;
        }
        const guardedTable: typeof table = {};
        for (const [rowId, row] of Object.entries(table)) {
          if (!row) {
            guardedTable[rowId] = row;
            continue;
          }
          const guardedRow: typeof row = {};
          for (const [cellId, cell] of Object.entries(row)) {
            if (cell !== undefined && cellJsonBytes(cell) > MAX_CELL_JSON_BYTES) {
              dropped = true;
              this.#oversized.set(JSON.stringify([tableId, rowId, cellId]), typeof cell);
              continue;
            }
            guardedRow[cellId] = cell;
          }
          guardedTable[rowId] = guardedRow;
        }
        guarded[tableId] = guardedTable;
      }
      return (dropped ? [guarded, values, marker] : [tables, values, marker]) as Changes;
    });

    // Flush the corrective rewrites as a fresh top-level transaction. A write
    // made from inside a transaction listener is discarded, so the flush is
    // deferred to a microtask — convergence is eventual, which is the right
    // shape for a CRDT anyway.
    this.store.addDidFinishTransactionListener(() => {
      if (this.#oversized.size === 0 || this.#flushing) return;
      this.#flushing = true;
      queueMicrotask(() => this.flushOversized());
    });
  }

  // Rewrite every cell the merge guard stripped. The stripped merge only edited
  // the plain store; this write carries the store's own newer HLC, so it
  // converges the oversized value away in the stamp tree — which is what the
  // persister, the export, and every replica actually read.
  flushOversized(): void {
    const pending = [...this.#oversized];
    this.#oversized.clear();
    try {
      this.store.transaction(() => {
        for (const [coord, cellType] of pending) {
          const [tableId, rowId, cellId] = JSON.parse(coord) as [string, string, string];
          // Must differ from the value the stripped merge left behind: the
          // schema refills a declared default, and a write equal to the current
          // value is a no-op producing no stamp — which would leave the blob in
          // the stamp tree. The marker also leaves a visible receipt.
          this.store.setCell(
            tableId, rowId, cellId,
            cellType === 'number' ? 0 : cellType === 'boolean' ? false : DROPPED_MARKER,
          );
        }
      });
    } finally {
      this.#flushing = false;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/export') {
      return Response.json(this.exportContent());
    }
    // WebSocket sync path — WsServerDurableObject implements fetch at runtime,
    // but types it as the optional DurableObject.fetch, so guard the call.
    return super.fetch?.(request) ?? new Response('Expected WebSocket', { status: 426 });
  }

  exportContent(): ExportedContent {
    const mergeableContent = this.store.getMergeableContent();
    return {
      mergeableContent,
      contentHash: getHash(JSON.stringify(mergeableContent)),
      ledgerId: (this.store.getValue('ledgerId') as string | undefined) ?? null,
      exportedAt: new Date().toISOString(),
    };
  }
}
