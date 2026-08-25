// scripts/stream-export.ts — run with: bun scripts/stream-export.ts
//
// Constraint 2 of dream 0006: the export path is built and proven before the
// creation ceremony ever runs. This CLI fetches the authed /export endpoint,
// verifies the content hash, proves the payload parses back into a fresh
// schema'd store, then archives it (JSON + .sha256) under the ledger's folder.
import { getHash } from 'tinybase';
import { createStreamStore, STORE_PATH } from 'julian-shared/schema';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAccessToken } from './lib/lease-client';

// Resolve the lease path: stream-export runs on its own device lease
const leasePath = process.env.STREAM_EXPORT_LEASE_FILE ?? join(homedir(), '.julian', 'stream-export-lease.json');

// Broker URL for token refresh
const brokerUrl = process.env.BROKER_URL ?? 'https://julian-broker.julian-memory.workers.dev';

// Validate --label early (before any network call).
// If --label is present but has no value or starts with --, fail immediately.
const labelIndex = process.argv.indexOf('--label');
let label = '';
if (labelIndex >= 0) {
  const labelValue = process.argv[labelIndex + 1];
  if (!labelValue || labelValue.startsWith('--')) {
    console.error('EXPORT FAILED: --label requires a value matching [a-z0-9-]{1,32}');
    process.exit(1);
  }
  label = labelValue;
  if (!/^[a-z0-9-]{1,32}$/.test(label)) {
    console.error('EXPORT FAILED: --label must match [a-z0-9-]{1,32}');
    process.exit(1);
  }
}

// Skip the loopback deliberately: stream-export must run on stream-read scope,
// not the full-house scope of the Mac loopback. Pass an env copy with JULIAN_LEASE_URL deleted.
const envWithoutLoopback = { ...process.env };
delete envWithoutLoopback.JULIAN_LEASE_URL;

// Resolve the access token
const tokenResult = await resolveAccessToken(envWithoutLoopback, leasePath, brokerUrl);
if ('error' in tokenResult) {
  console.error(`EXPORT FAILED: ${tokenResult.error}`);
  console.error('');
  console.error('No valid stream-read lease. Knock for access:');
  console.error('');
  console.error('  bun scripts/door-knock.ts --name stream-export --purpose "export stream data (stream-read scope)"');
  console.error('');
  console.error('Then try stream-export again once Marcus approves.');
  process.exit(1);
}

const token = tokenResult.token;
const base = process.env.SYNC_BASE ?? 'https://julian-sync.julian-memory.workers.dev';

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
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const file = `${dir}/${body.exportedAt.slice(0, 10)}${label ? `-${label}` : ''}.json`;
if (existsSync(file)) { console.error(`EXPORT REFUSED: ${file} exists — pass --label to write a second export today`); process.exit(1); }
const payload = JSON.stringify(body, null, 2);
writeFileSync(file, payload, { mode: 0o600 });
const sha = new Bun.CryptoHasher('sha256').update(payload).digest('hex');
writeFileSync(`${file}.sha256`, `${sha}  ${file.split('/').pop()}\n`, { mode: 0o600 });
console.log(`VERIFIED export: ${messageCount} messages, hash ${body.contentHash}, → ${file}`);
