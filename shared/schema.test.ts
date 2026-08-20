// shared/schema.test.ts
import { describe, expect, test } from 'vitest';
import { createStreamStore, newLedgerId, STORE_PATH } from './schema';

describe('stream schema', () => {
  test('store accepts a valid message row', () => {
    const store = createStreamStore('t1');
    store.setRow('messages', 'm1', {
      sessionId: 's1', role: 'user', speakerName: 'Marcus',
      content: [{ type: 'text', text: 'hello' }], text: 'hello', ts: 1753500000000, kind: 'chat',
    });
    expect(store.getCell('messages', 'm1', 'text')).toBe('hello');
  });

  test('schema rejects a wrongly typed cell', () => {
    const store = createStreamStore('t2');
    store.setRow('messages', 'm1', { sessionId: 's1', role: 'user', speakerName: 'M', ts: 1, text: 'x' });
    store.setCell('messages', 'm1', 'ts', 'not-a-number' as never);
    expect(store.getCell('messages', 'm1', 'ts')).toBe(1); // invalid write ignored by schema
  });

  test('same rowId written twice converges to one row (idempotency)', () => {
    const store = createStreamStore('t3');
    const row = { sessionId: 's1', role: 'assistant', speakerName: 'Julian', text: 'hi', ts: 2 };
    store.setRow('messages', 'evt-42', row);
    store.setRow('messages', 'evt-42', row);
    expect(store.getRowIds('messages')).toEqual(['evt-42']);
  });

  test('newLedgerId returns 26-char Crockford ULID, time-ordered prefix', () => {
    const a = newLedgerId(1000);
    const b = newLedgerId(2000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  test('constants', () => {
    expect(STORE_PATH).toBe('julian/chat');
  });
});
