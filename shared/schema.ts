// shared/schema.ts
import { createMergeableStore } from 'tinybase/mergeable-store';
import type { MergeableStore } from 'tinybase/mergeable-store';

export const STORE_PATH = 'julian/chat';
export const SCHEMA_VERSION = 1;

// Tables: messages keyed by harness message id / `evt-<id>`; artifacts keyed by relative filename.
export const TABLES_SCHEMA = {
  messages: {
    sessionId: { type: 'string' },
    role: { type: 'string' },          // 'user' | 'assistant'
    speakerName: { type: 'string' },
    content: { type: 'array' },        // content blocks, write-once — whole-cell LWW is correct
    text: { type: 'string', default: '' },
    ts: { type: 'number' },
    kind: { type: 'string', default: 'chat' }, // 'chat' | 'system' | 'compact'
  },
  artifacts: {
    category: { type: 'string', default: 'identity' },
    chapter: { type: 'string', default: '' },
    description: { type: 'string', default: '' },
    createdAt: { type: 'number' },
    modifiedAt: { type: 'number' },
  },
} as const;

// Values: lineage (constraint 1, dream 0006) + minimal app state.
export const VALUES_SCHEMA = {
  ledgerId: { type: 'string' },
  parentLedgerId: { type: 'string' },
  lineageNote: { type: 'string' },
  createdAt: { type: 'number' },
  createdBy: { type: 'string' },
  storeSchemaVersion: { type: 'number', default: SCHEMA_VERSION },
  activeSessionId: { type: 'string', default: '' },
} as const;

export function createStreamStore(uniqueId?: string): MergeableStore {
  // setSchema applies tables + values schemas; invalid writes are rejected at the store boundary.
  return createMergeableStore(uniqueId).setSchema(TABLES_SCHEMA, VALUES_SCHEMA) as MergeableStore;
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford
export function newLedgerId(now: number = Date.now()): string {
  let t = now, ts = '';
  for (let i = 0; i < 10; i++) { ts = B32[t % 32] + ts; t = Math.floor(t / 32); }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[bytes[i] % 32];
  return ts + rand;
}
