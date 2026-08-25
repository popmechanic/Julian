// scripts/lib/fireproof-types.ts — the vocabulary shared by decode, map, write, and the CLI.
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FireproofDoc { _id: string; type?: string; [k: string]: unknown }
export interface LedgerInfo { ledgerId: string; name: string; tenantId: string }
export interface DecodedDoc {
  doc: FireproofDoc;
  ledger: LedgerInfo;
  blobId: string;
  uploaded: number; // r2-metadata `uploaded` (epoch ms) — the clock proxy for version selection
}
export interface MappedRow {
  id: string;
  sessionId: string;
  role: string;
  speakerName: string;
  text: string;
  content?: unknown[];
  ts: number;
  kind: 'chat' | 'system';
}

export const ARCHIVE_PATH = join(homedir(), 'julian-stream-backups', 'phone-export-20260725', 'march-rescue-connect-share-20260725.tar.gz');
export const ARCHIVE_SHA256 = '64f5d5e12692db4d11548529bbcfefea74586fa0271e39558ea06b94bcd64ee3';
export const ARCHIVE_ROOT = 'march-rescue-20260725';
export const LIVE_LEDGER_ID = '01KYJ9XT64DQDJ1P3V8KET1R7B';
export const FEB_START_MS = Date.UTC(2026, 1, 15);
export const MAR_START_MS = Date.UTC(2026, 2, 1);
export const BATCH_CAP_UNITS = 131_072;
export const FRAME_LIMIT_UNITS = 262_144;
export const MAX_CELL_JSON_BYTES = 65_536; // sync/src/do.ts — the DO's guard
