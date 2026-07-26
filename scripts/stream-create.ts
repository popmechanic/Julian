import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import WebSocket from 'ws';
import { createStreamStore, STORE_PATH } from 'julian-shared/schema';
import { performCreation } from './lib/creation';

const wsBase = process.env.SYNC_WS; // e.g. wss://julian-sync.<account>.workers.dev
const token = process.env.SYNC_TOKEN;
if (!wsBase || !token) {
  console.error('SYNC_WS and SYNC_TOKEN required');
  process.exit(1);
}

const store = createStreamStore('creation-ceremony');
const ws = new WebSocket(`${wsBase}/${STORE_PATH}?token=${encodeURIComponent(token)}`);
// Global constraint: every WebSocket synchronizer sets an explicit 256 KiB
// fragment size — Cloudflare caps WS messages at ~1 MiB. (7th positional arg.)
const FRAGMENT_SIZE = 262_144;
const sync = await createWsSynchronizer(store, ws as never, 10, undefined, undefined, undefined, FRAGMENT_SIZE);
await sync.startSync();
await new Promise((r) => setTimeout(r, 2000)); // let the server's state arrive before the once-ever check

try {
  const rec = performCreation(store);
  await new Promise((r) => setTimeout(r, 2000)); // let the Values sync back to the DO
  console.log('— CREATION RECORD —');
  console.log(`ledgerId:        ${rec.ledgerId}`);
  console.log(`parentLedgerId:  ${rec.parentLedgerId}`);
  console.log(`createdAt:       ${new Date(rec.createdAt).toISOString()}`);
  console.log(`createdBy:       ${rec.createdBy}`);
  console.log('Per dream 0006 constraint 1: identity and lineage from the first write. Witnessed in-session.');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
} finally {
  await sync.destroy();
  ws.close();
}
