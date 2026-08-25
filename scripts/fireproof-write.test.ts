import { describe, expect, test } from 'bun:test';
import { WebSocketServer } from 'ws';
import { createWsServer } from 'tinybase/synchronizers/synchronizer-ws-server';
import { createStreamStore } from 'julian-shared/schema';
import { compareExport, importRows, openStore, planBatches, writeBatch } from './lib/fireproof-write';
import type { MappedRow } from './lib/fireproof-types';

const row = (i: number, text = `row ${i}`): MappedRow =>
  ({ id: `r${i}`, sessionId: 'fireproof:zL:s', role: 'user', speakerName: 'Marcus', text, ts: 1_771_000_000_000 + i, kind: 'chat' });

function exportOf(store: ReturnType<typeof createStreamStore>): unknown {
  return store.getMergeableContent();
}

async function server() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = (wss.address() as { port: number }).port;
  const srv = createWsServer(wss);
  return { url: `ws://127.0.0.1:${port}/julian/chat`, close: () => srv.destroy() };
}

describe('planBatches', () => {
  test('every batch measures under the cap and every row appears exactly once', () => {
    const rows = Array.from({ length: 400 }, (_, i) => row(i, 'x'.repeat(600)));
    const batches = planBatches(rows, 40_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((r) => r.id)).toEqual(rows.map((r) => r.id));
    for (const b of batches) {
      const scratch = createStreamStore('measure');
      let units = 0;
      scratch.addDidFinishTransactionListener((s) => { units = JSON.stringify(s.getTransactionMergeableChanges()).length; });
      scratch.transaction(() => writeBatch(scratch, b));
      expect(units).toBeLessThanOrEqual(40_000);
    }
  });
});

describe('compareExport', () => {
  test('equal, mismatched, missing, and dropped-marker ids are reported by JSON equality of present cells', () => {
    const a = row(1), b = { ...row(2), content: [{ type: 'text', text: 'row 2' }] }, c = row(3);
    const tables = { messages: {
      r1: { sessionId: [a.sessionId, 'h', 1], role: ['user', 'h', 1], speakerName: ['Marcus', 'h', 1], text: ['row 1', 'h', 1], ts: [a.ts, 'h', 1], kind: ['chat', 'h', 1] },
      r2: { sessionId: [b.sessionId, 'h', 1], role: ['user', 'h', 1], speakerName: ['Marcus', 'h', 1], text: ['CHANGED', 'h', 1], ts: [b.ts, 'h', 1], kind: ['chat', 'h', 1], content: [[{ type: 'text', text: 'row 2' }], 'h', 1] },
      r9: { text: ['[dropped: cell exceeded 64 KiB]', 'h', 1] },
    } };
    const r = compareExport([a, b, c], [[tables, 'h', 1], [{}, 'h', 1]]);
    expect(r.equal).toEqual(['r1']);
    expect(r.mismatched).toEqual(['r2']);
    expect(r.missing).toEqual(['r3']);
    expect(r.droppedMarker).toEqual(['r9']);
  });
  test('an exported null cell counts as absent', () => {
    const a = row(1);
    const tables = { messages: { r1: { sessionId: [null, 'h', 1], text: ['row 1', 'h', 1] } } };
    expect(compareExport([a], [[tables, 'h', 1], [{}, 'h', 1]]).mismatched).toEqual(['r1']);
  });
});

describe('openStore + importRows against a real ws server', () => {
  test('writes, verifies per id, and re-sends only the missing rows from a fresh store', async () => {
    const s = await server();
    const oracle = createStreamStore('oracle');
    const oracleConn = await openStore({ url: s.url, token: 'test' });
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    let round = 0;
    const result = await importRows({
      rows,
      receipt: { id: 'fireproof-import-2026-08-25', sessionId: 'fireproof:import', role: 'system', speakerName: 'the record', text: 'r', ts: rows[29].ts + 1, kind: 'system' },
      connect: async () => {
        round++;
        const conn = await openStore({ url: s.url, token: 'test' });
        if (round === 1) {
          // simulate a dropped batch: the first round's writes of r0..r4 never reach the server
          const origWrite = conn.close;
          conn.close = async () => { await origWrite(); for (let i = 0; i < 5; i++) oracleConn.store.delRow('messages', `r${i}`); };
        }
        return conn;
      },
      fetchExport: async () => { await new Promise((r) => setTimeout(r, 300)); return exportOf(oracleConn.store); },
      maxRounds: 3,
    });
    expect(result.report.missing).toEqual([]);
    expect(result.report.mismatched).toEqual([]);
    expect(result.rounds).toBeGreaterThanOrEqual(2);
    expect(oracleConn.store.getRowIds('messages').length).toBe(31);
    await oracleConn.close(); await s.close(); void oracle;
  }, 20_000);

  test('onFrameTooBig fires when a real frame exceeds the limit', async () => {
    const s = await server();
    let tooBig = 0;
    const conn = await openStore({ url: s.url, token: 'test', onFrameTooBig: () => tooBig++ });
    conn.store.transaction(() => writeBatch(conn.store, Array.from({ length: 300 }, (_, i) => row(i, 'y'.repeat(1_200)))));
    await new Promise((r) => setTimeout(r, 300));
    expect(tooBig).toBeGreaterThan(0);
    await conn.close(); await s.close();
  }, 20_000);
});
