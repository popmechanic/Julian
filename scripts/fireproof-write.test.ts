import { describe, expect, test } from 'bun:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createWsServer } from 'tinybase/synchronizers/synchronizer-ws-server';
import { createStreamStore } from 'julian-shared/schema';
import { awaitDrain, compareExport, createClose, importRows, openStore, planBatches, writeBatch } from './lib/fireproof-write';
import type { MappedRow } from './lib/fireproof-types';
import { FRAME_LIMIT_UNITS } from './lib/fireproof-types';

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
    const a = row(1), b = { ...row(2), content: [{ type: 'text', text: 'row 2' }] }, c = row(3), d = row(4);
    const tables = { messages: {
      r1: { sessionId: [a.sessionId, 'h', 1], role: ['user', 'h', 1], speakerName: ['Marcus', 'h', 1], text: ['row 1', 'h', 1], ts: [a.ts, 'h', 1], kind: ['chat', 'h', 1] },
      r2: { sessionId: [b.sessionId, 'h', 1], role: ['user', 'h', 1], speakerName: ['Marcus', 'h', 1], text: ['CHANGED', 'h', 1], ts: [b.ts, 'h', 1], kind: ['chat', 'h', 1], content: [[{ type: 'text', text: 'row 2' }], 'h', 1] },
      // r4 IS one of the rows this annex wrote, and its text came back as the DO's drop marker.
      r4: { sessionId: [d.sessionId, 'h', 1], role: ['user', 'h', 1], speakerName: ['Marcus', 'h', 1], text: ['[dropped: cell exceeded 64 KiB]', 'h', 1], ts: [d.ts, 'h', 1], kind: ['chat', 'h', 1] },
      // r9 is a pre-existing live row the annex never wrote — its marker is not ours to report.
      r9: { text: ['[dropped: cell exceeded 64 KiB]', 'h', 1] },
    } };
    const r = compareExport([a, b, c, d], [[tables, 'h', 1], [{}, 'h', 1]]);
    expect(r.equal).toEqual(['r1']);
    expect(r.mismatched).toEqual(['r2', 'r4']);
    expect(r.missing).toEqual(['r3']);
    expect(r.droppedMarker).toEqual(['r4']);
  });
  test('a dropped marker on a row outside the compared set is not reported', () => {
    const a = row(1);
    const tables = { messages: {
      r1: { sessionId: [a.sessionId, 'h', 1], role: ['user', 'h', 1], speakerName: ['Marcus', 'h', 1], text: ['row 1', 'h', 1], ts: [a.ts, 'h', 1], kind: ['chat', 'h', 1] },
      live1: { text: ['[dropped: cell exceeded 64 KiB]', 'h', 1] },
    } };
    const r = compareExport([a], [[tables, 'h', 1], [{}, 'h', 1]]);
    expect(r.droppedMarker).toEqual([]);
    expect(r.equal).toEqual(['r1']);
  });
  test('an exported null cell counts as absent', () => {
    const a = row(1);
    const tables = { messages: { r1: { sessionId: [null, 'h', 1], text: ['row 1', 'h', 1] } } };
    expect(compareExport([a], [[tables, 'h', 1], [{}, 'h', 1]]).mismatched).toEqual(['r1']);
  });
});

describe('awaitDrain', () => {
  test('resolves once bufferedAmount reaches zero', async () => {
    const sock = { bufferedAmount: 4_096 };
    setTimeout(() => { sock.bufferedAmount = 0; }, 100);
    await awaitDrain(sock, { pollMs: 20, timeoutMs: 5_000 });
    expect(sock.bufferedAmount).toBe(0);
  });
  test('throws naming the still-buffered bytes when the socket never drains', async () => {
    const sock = { bufferedAmount: 1_234 };
    await expect(awaitDrain(sock, { pollMs: 10, timeoutMs: 120 }))
      .rejects.toThrow(/socket did not drain: 1234 bytes buffered/);
  });
});

describe('createClose', () => {
  test('waits for the drain, then destroys the synchronizer and closes the socket', async () => {
    const order: string[] = [];
    let buffered = 8_192;
    const ws = { get bufferedAmount() { return buffered; }, close: () => { order.push('ws.close'); } };
    const sync = { destroy: async () => { order.push('sync.destroy'); } };
    const close = createClose(ws, sync, { pollMs: 10, timeoutMs: 5_000 });
    setTimeout(() => { order.push('flushed'); buffered = 0; }, 80);
    await close();
    expect(order).toEqual(['flushed', 'sync.destroy', 'ws.close']);
  });

  test('a drain timeout still tears down, and the drain error still propagates', async () => {
    const order: string[] = [];
    const ws = { bufferedAmount: 1_234, close: () => { order.push('ws.close'); } };
    const sync = { destroy: async () => { order.push('sync.destroy'); } };
    const close = createClose(ws, sync, { pollMs: 10, timeoutMs: 120 });
    await expect(close()).rejects.toThrow(/socket did not drain: 1234 bytes buffered/);
    // Teardown is unconditional: importRows calls close() from a `finally`, so a
    // drain error that skipped it would leave a live socket holding the process open.
    expect(order).toEqual(['sync.destroy', 'ws.close']);
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
    expect(conn.frameViolations.length).toBeGreaterThan(0);
    expect(conn.frameViolations.every((u) => u > FRAME_LIMIT_UNITS)).toBe(true);
    await conn.close(); await s.close();
  }, 20_000);

  test('importRows fails loud on an over-limit frame and never fetches the export', async () => {
    const s = await server();
    let fetched = 0;
    // One row too large to split: planBatches cannot help, so the frame goes over.
    const oversize: MappedRow = { ...row(0), text: 'z'.repeat(300_000) };
    await expect(importRows({
      rows: [oversize],
      receipt: { id: 'fireproof-import-2026-08-25', sessionId: 'fireproof:import', role: 'system', speakerName: 'the record', text: 'r', ts: oversize.ts + 1, kind: 'system' },
      connect: () => openStore({ url: s.url, token: 'test' }),
      fetchExport: async () => { fetched++; return [[{}, 'h', 1], [{}, 'h', 1]]; },
      maxRounds: 3,
    })).rejects.toThrow(/frame over limit/);
    expect(fetched).toBe(0);
    await s.close();
  }, 30_000);

  test('close() drains the socket before it destroys the synchronizer', async () => {
    const s = await server();
    const oracleConn = await openStore({ url: s.url, token: 'test' });
    const conn = await openStore({ url: s.url, token: 'test' });
    const rows = Array.from({ length: 120 }, (_, i) => row(i, 'w'.repeat(400)));
    conn.store.transaction(() => writeBatch(conn.store, rows));
    // A loopback socket may already report zero here, so the "still buffered"
    // sample is not asserted — the wrapped-socket test below carries that criterion.
    await conn.close();
    expect(conn.ws.bufferedAmount).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(oracleConn.store.getRowIds('messages').length).toBe(rows.length);
    await oracleConn.close(); await s.close();
  }, 20_000);

  test('the shipped close() holds off until the real socket reports empty', async () => {
    const s = await server();
    const conn = await openStore({ url: s.url, token: 'test' });
    // Wrap the real socket: bufferedAmount reports a backlog until a flush we control.
    let buffered = 8_192;
    Object.defineProperty(conn.ws, 'bufferedAmount', { configurable: true, get: () => buffered });
    const events: string[] = [];
    const realClose = conn.ws.close.bind(conn.ws);
    (conn.ws as unknown as { close: () => void }).close = () => { events.push('ws.close'); realClose(); };
    setTimeout(() => { events.push('flushed'); buffered = 0; }, 120);
    await conn.close();
    expect(events[0]).toBe('flushed');
    expect(events.filter((e) => e === 'ws.close').length).toBeGreaterThan(0);
    await s.close();
  }, 20_000);

  test('a real socket that never drains is still torn down, and the failure is loud', async () => {
    const s = await server();
    const conn = await openStore({ url: s.url, token: 'test' });
    Object.defineProperty(conn.ws, 'bufferedAmount', { configurable: true, get: () => 4_096 });
    // The real (frozen) synchronizer and the real socket, on the timeout path.
    const close = createClose(conn.ws, conn.sync, { pollMs: 10, timeoutMs: 150 });
    await expect(close()).rejects.toThrow(/socket did not drain/);
    expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(conn.ws.readyState);
    await s.close();
  }, 20_000);
});
