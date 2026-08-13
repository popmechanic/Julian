// shared/schema.ts
import { createMergeableStore } from 'tinybase/mergeable-store';
import type { MergeableStore } from 'tinybase/mergeable-store';

export const STORE_PATH = 'julian/chat';
export const SCHEMA_VERSION = 2;

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
  jobs: {
    title: { type: 'string' },
    description: { type: 'string', default: '' },
    postedBy: { type: 'string' },
    postedAt: { type: 'number' },
    status: { type: 'string', default: 'open' }, // 'open' | 'taken' | 'closed' | 'withdrawn'
    contextDocs: { type: 'string', default: '' }, // newline-separated paths/URLs
  },
  jobInterest: {
    jobId: { type: 'string' },
    agentName: { type: 'string' },
    statement: { type: 'string' }, // the why — interest is always applied-for with a statement
    at: { type: 'number' },
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

// The segment shape a principal must have to address a store. Copied from
// sync/src/index.ts's SEG regex — sync's path parser and this function must
// agree, or a valid store path here could be one sync's router refuses (or
// vice versa).
const SEG = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;

export function storePathFor(principal: string): string | null {
  if (principal === 'internal') return null;
  if (!SEG.test(principal)) return null;
  return `${principal}/chat`;
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
