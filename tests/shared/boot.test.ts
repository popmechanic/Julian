import { describe, expect, test, mock } from 'bun:test';
import {
  resilientPut,
  getBootPhase,
  isBootReady,
} from '../../shared/utils.js';

// ── resilientPut ──────────────────────────────────────────────────────────

describe('resilientPut', () => {
  test('succeeds on first attempt', async () => {
    const db = { put: mock(() => Promise.resolve({ id: '123', ok: true })) };
    const result = await resilientPut(db, { type: 'test' });
    expect(result).toEqual({ id: '123', ok: true });
    expect(db.put).toHaveBeenCalledTimes(1);
  });

  test('retries on WriteQueueImpl error and succeeds', async () => {
    let calls = 0;
    const db = {
      put: mock(() => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('WriteQueueImpl: Cannot read properties of undefined'));
        return Promise.resolve({ id: '123', ok: true });
      }),
    };
    const result = await resilientPut(db, { type: 'test' }, 3);
    expect(result).toEqual({ id: '123', ok: true });
    expect(db.put).toHaveBeenCalledTimes(2);
  });

  test('retries on stores error and succeeds', async () => {
    let calls = 0;
    const db = {
      put: mock(() => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("Cannot read properties of undefined (reading 'stores')"));
        return Promise.resolve({ id: '456', ok: true });
      }),
    };
    const result = await resilientPut(db, { type: 'test' }, 3);
    expect(result).toEqual({ id: '456', ok: true });
    expect(db.put).toHaveBeenCalledTimes(2);
  });

  test('throws immediately on non-store error', async () => {
    const db = {
      put: mock(() => Promise.reject(new Error('Document conflict'))),
    };
    try {
      await resilientPut(db, { type: 'test' });
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toBe('Document conflict');
    }
    expect(db.put).toHaveBeenCalledTimes(1);
  });

  test('throws after max retries exhausted', async () => {
    const db = {
      put: mock(() => Promise.reject(new Error('WriteQueueImpl: stores not ready'))),
    };
    try {
      await resilientPut(db, { type: 'test' }, 2);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain('WriteQueueImpl');
    }
    // 1 initial + 2 retries = 3 total
    expect(db.put).toHaveBeenCalledTimes(3);
  });

  test('passes doc through to database.put', async () => {
    const doc = { _id: 'my-doc', type: 'message', text: 'hello' };
    const db = { put: mock((d: any) => Promise.resolve({ id: d._id, ok: true })) };
    await resilientPut(db, doc);
    expect(db.put).toHaveBeenCalledWith(doc);
  });

  test('default maxRetries is 3 (function accepts 2 args)', async () => {
    // Verify resilientPut works with only 2 args (default maxRetries)
    const db = { put: mock(() => Promise.resolve({ id: '1', ok: true })) };
    const result = await resilientPut(db, { type: 'test' });
    expect(result).toEqual({ id: '1', ok: true });
    expect(db.put).toHaveBeenCalledTimes(1);
    // The maxRetries=3 default is verified by the function signature;
    // full retry exhaustion is tested above with explicit maxRetries=2
  });

  test('error without message does not retry', async () => {
    const db = {
      put: mock(() => Promise.reject({ code: 'UNKNOWN' })),
    };
    try {
      await resilientPut(db, { type: 'test' });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('UNKNOWN');
    }
    expect(db.put).toHaveBeenCalledTimes(1);
  });
});

// ── getBootPhase ──────────────────────────────────────────────────────────

describe('getBootPhase', () => {
  test('phase 0: local stores not ready', () => {
    expect(getBootPhase({
      database: true, localStores: false, cloud: null,
      ledgerMeta: false, catalog: false, agents: false,
    })).toBe(0);
  });

  test('phase 1: local ready, cloud pending', () => {
    expect(getBootPhase({
      database: true, localStores: true, cloud: null,
      ledgerMeta: false, catalog: false, agents: false,
    })).toBe(1);
  });

  test('phase 2: cloud resolved, data loading', () => {
    expect(getBootPhase({
      database: true, localStores: true, cloud: true,
      ledgerMeta: true, catalog: false, agents: false,
    })).toBe(2);
  });

  test('phase 2: cloud timed out, data loading', () => {
    expect(getBootPhase({
      database: true, localStores: true, cloud: false,
      ledgerMeta: true, catalog: false, agents: true,
    })).toBe(2);
  });

  test('phase 3: everything complete', () => {
    expect(getBootPhase({
      database: true, localStores: true, cloud: true,
      ledgerMeta: true, catalog: true, agents: true,
    })).toBe(3);
  });

  test('phase 3: cloud timed out but data complete', () => {
    expect(getBootPhase({
      database: true, localStores: true, cloud: false,
      ledgerMeta: true, catalog: true, agents: true,
    })).toBe(3);
  });

  test('phase 0: nothing ready', () => {
    expect(getBootPhase({
      database: false, localStores: false, cloud: null,
      ledgerMeta: false, catalog: false, agents: false,
    })).toBe(0);
  });
});

// ── isBootReady ───────────────────────────────────────────────────────────

describe('isBootReady', () => {
  test('ready when all steps complete with cloud connected', () => {
    expect(isBootReady({
      database: true, localStores: true, cloud: true,
      ledgerMeta: true, catalog: true, agents: true,
    })).toBe(true);
  });

  test('ready when cloud timed out (false, not null)', () => {
    expect(isBootReady({
      database: true, localStores: true, cloud: false,
      ledgerMeta: true, catalog: true, agents: true,
    })).toBe(true);
  });

  test('not ready when cloud still pending (null)', () => {
    expect(isBootReady({
      database: true, localStores: true, cloud: null,
      ledgerMeta: true, catalog: true, agents: true,
    })).toBe(false);
  });

  test('not ready when database missing', () => {
    expect(isBootReady({
      database: false, localStores: true, cloud: true,
      ledgerMeta: true, catalog: true, agents: true,
    })).toBe(false);
  });

  test('not ready when local stores missing', () => {
    expect(isBootReady({
      database: true, localStores: false, cloud: true,
      ledgerMeta: true, catalog: true, agents: true,
    })).toBe(false);
  });

  test('not ready when ledger-meta missing', () => {
    expect(isBootReady({
      database: true, localStores: true, cloud: true,
      ledgerMeta: false, catalog: true, agents: true,
    })).toBe(false);
  });

  test('not ready when catalog missing', () => {
    expect(isBootReady({
      database: true, localStores: true, cloud: true,
      ledgerMeta: true, catalog: false, agents: true,
    })).toBe(false);
  });

  test('not ready when agents missing', () => {
    expect(isBootReady({
      database: true, localStores: true, cloud: true,
      ledgerMeta: true, catalog: true, agents: false,
    })).toBe(false);
  });

  test('not ready when nothing is done', () => {
    expect(isBootReady({
      database: false, localStores: false, cloud: null,
      ledgerMeta: false, catalog: false, agents: false,
    })).toBe(false);
  });
});
