// sync/src/do.ts — JulianSyncDO: schema'd store, v9 fragmented SQLite persister,
// cell-size guard, and the witnessed export path (dream 0006, constraint 2).
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage';
import { createMiddleware, getHash } from 'tinybase';
import type { Middleware, Cell } from 'tinybase';
import type { MergeableStore } from 'tinybase/mergeable-store';
import { createStreamStore } from 'julian-shared/schema';

// Cloudflare's WS message cap is ~1 MiB; every synchronizer sets an explicit fragment size.
const FRAGMENT_SIZE = 262_144; // 256 KiB
// Any single cell whose JSON serialization exceeds this many bytes is rejected at the write boundary.
const MAX_CELL_JSON_BYTES = 65_536; // 64 KiB

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
