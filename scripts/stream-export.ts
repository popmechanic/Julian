// scripts/stream-export.ts — run with: bun scripts/stream-export.ts
//
// Constraint 2 of dream 0006: the export path is built and proven before the
// creation ceremony ever runs. This CLI fetches the authed /export endpoint,
// verifies the content hash, proves the payload parses back into a fresh
// schema'd store, then archives it (JSON + .sha256) under the ledger's folder.
import { getHash } from 'tinybase';
import { createStreamStore, STORE_PATH } from 'julian-shared/schema';
import { mkdirSync } from 'fs';

const base = process.env.SYNC_BASE; // e.g. https://julian-sync.<account>.workers.dev
const token = process.env.SYNC_TOKEN; // a current Clerk JWT
if (!base || !token) {
  console.error('EXPORT FAILED: SYNC_BASE and SYNC_TOKEN required');
  process.exit(1);
}

const res = await fetch(`${base}/${STORE_PATH}/export`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) {
  console.error(`EXPORT FAILED: HTTP ${res.status}`);
  process.exit(1);
}
const body = (await res.json()) as {
  mergeableContent: unknown;
  contentHash: number;
  ledgerId: string | null;
  exportedAt: string;
};

if (getHash(JSON.stringify(body.mergeableContent)) !== body.contentHash) {
  console.error('HASH MISMATCH — export not trustworthy, refusing to archive');
  process.exit(1);
}
const probe = createStreamStore('export-probe');
probe.setMergeableContent(body.mergeableContent as never);
const messageCount = probe.getRowIds('messages').length;

const dir = `${process.env.EXPORT_DIR ?? `${process.env.HOME}/julian-stream-backups/tinybase`}/${body.ledgerId ?? 'unborn'}`;
mkdirSync(dir, { recursive: true });
const file = `${dir}/${body.exportedAt.slice(0, 10)}.json`;
const payload = JSON.stringify(body, null, 2);
await Bun.write(file, payload);
const sha = new Bun.CryptoHasher('sha256').update(payload).digest('hex');
await Bun.write(`${file}.sha256`, `${sha}  ${file.split('/').pop()}\n`);
console.log(`VERIFIED export: ${messageCount} messages, hash ${body.contentHash}, → ${file}`);
