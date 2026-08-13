// sync/src/reads.ts — pure stream read verbs over a MergeableStore.
//
// No I/O here: these are called directly from the DO (and, through it, from
// the /internal/read/{recent,session,search} wire). Keeping the query logic
// separate from transport means it's testable without a Durable Object or a
// socket — the pure-function seam the plan calls for.
import type { MergeableStore } from 'tinybase/mergeable-store';
import type { StreamRow } from 'julian-shared/gate-contract';

export const READ_MAX_ROWS = 200;
export const READ_MAX_BYTES = 196_608;

export interface ReadResult {
  rows: StreamRow[];
  truncated: boolean;
}

const encoder = new TextEncoder();

function rowBytes(row: StreamRow): number {
  return encoder.encode(JSON.stringify(row)).length;
}

// Read every row out of the `messages` table as a StreamRow — `text` only,
// never the `content` block array (the schema stores both; this seam never
// touches `content`).
function allRows(store: MergeableStore): StreamRow[] {
  const ids = store.getRowIds('messages');
  const rows: StreamRow[] = [];
  for (const id of ids) {
    const row = store.getRow('messages', id) as Record<string, unknown>;
    rows.push({
      id,
      sessionId: String(row.sessionId ?? ''),
      role: String(row.role ?? ''),
      speakerName: String(row.speakerName ?? ''),
      text: String(row.text ?? ''),
      ts: Number(row.ts ?? 0),
      kind: String(row.kind ?? 'chat'),
    });
  }
  return rows;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return READ_MAX_ROWS;
  return Math.min(Math.floor(limit), READ_MAX_ROWS);
}

// Accumulate `candidates` (already in the order the caller wants kept —
// most-preferred first) up to READ_MAX_BYTES of serialized rows. A row that
// would push the running total over budget is dropped whole, never split
// mid-row, and accumulation stops there: `truncated: true`.
function applyByteBudget(candidates: StreamRow[]): { kept: StreamRow[]; truncated: boolean } {
  let total = 0;
  const kept: StreamRow[] = [];
  for (const row of candidates) {
    const size = rowBytes(row);
    if (total + size > READ_MAX_BYTES) {
      return { kept, truncated: true };
    }
    total += size;
    kept.push(row);
  }
  return { kept, truncated: false };
}

const byTsAsc = (a: StreamRow, b: StreamRow) => a.ts - b.ts;
const byTsDesc = (a: StreamRow, b: StreamRow) => b.ts - a.ts;

export function readRecent(store: MergeableStore, limit?: number): ReadResult {
  const effectiveLimit = clampLimit(limit);
  const ascending = allRows(store).sort(byTsAsc);
  const windowed = ascending.slice(Math.max(0, ascending.length - effectiveLimit));
  // Apply the byte budget newest-first, so the most recent rows in the
  // window are kept in preference to older ones when the budget is tight,
  // then hand back the surviving rows re-sorted ascending.
  const { kept, truncated } = applyByteBudget([...windowed].reverse());
  return { rows: kept.sort(byTsAsc), truncated };
}

export function readSession(
  store: MergeableStore,
  sessionId: string,
  range?: { from?: number; to?: number },
): ReadResult {
  const from = range?.from;
  const to = range?.to;
  const matching = allRows(store)
    .filter((r) => r.sessionId === sessionId)
    .filter((r) => (from === undefined || r.ts >= from) && (to === undefined || r.ts <= to))
    .sort(byTsAsc);
  const windowed = matching.slice(Math.max(0, matching.length - READ_MAX_ROWS));
  const { kept, truncated } = applyByteBudget([...windowed].reverse());
  return { rows: kept.sort(byTsAsc), truncated };
}

export function readSearch(store: MergeableStore, query: string, limit?: number): ReadResult {
  const effectiveLimit = clampLimit(limit);
  const needle = query.toLowerCase();
  // Substring only — String.prototype.includes on lowercased text. Never a
  // caller-supplied regex, so a query like 'a.*b' matches only its literal
  // characters.
  const matching = allRows(store)
    .filter((r) => r.text.toLowerCase().includes(needle))
    .sort(byTsDesc);
  const windowed = matching.slice(0, effectiveLimit);
  const { kept, truncated } = applyByteBudget(windowed);
  return { rows: kept, truncated };
}
