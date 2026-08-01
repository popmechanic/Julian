// app/src/lib/tail.ts — select the inherited tail from the converged store.
// Budgeted recency window: newest messages, whole messages only, oldest
// trimmed first. The server injects this only on fresh spawns.
import type { Store } from 'tinybase';

export const TAIL_MAX_MESSAGES = 100;
export const TAIL_MAX_CHARS = 30_000;

export interface TailMessage {
  role: string;
  speakerType: string;
  speakerName: string;
  text: string;
  ts: number;
}

export function selectTail(store: Store): TailMessage[] {
  const rows = Object.values(store.getTable('messages'))
    .filter((r) => r.kind === 'chat' && typeof r.text === 'string' && r.text !== '')
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));

  const out: TailMessage[] = [];
  let chars = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const text = String(rows[i].text);
    if (out.length >= TAIL_MAX_MESSAGES || chars + text.length > TAIL_MAX_CHARS) break;
    chars += text.length;
    const role = String(rows[i].role || 'user');
    out.unshift({
      role,
      speakerType: role === 'assistant' ? 'assistant' : 'human',
      speakerName: String(rows[i].speakerName || ''),
      text,
      ts: Number(rows[i].ts) || 0,
    });
  }
  return out;
}
