import { describe, expect, test } from 'vitest';
import { createStreamStore } from 'julian-shared/schema';
import { performCreation } from './creation';

describe('performCreation', () => {
  test('writes full lineage Values once', () => {
    const store = createStreamStore('c1');
    const rec = performCreation(store, { now: 1753500000000 });
    expect(rec.ledgerId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(store.getValue('parentLedgerId')).toBe('fireproof:julian-chat-v14');
    expect(store.getValue('createdBy')).toBe('Julian & Marcus');
    expect(store.getValue('createdAt')).toBe(1753500000000);
    expect(String(store.getValue('lineageNote'))).toContain('julian-stream-backups');
  });
  test('refuses a second creation', () => {
    const store = createStreamStore('c2');
    performCreation(store);
    expect(() => performCreation(store)).toThrow('creation happens once');
  });
  test('storeSchemaVersion is retired: creation writes no version marker (#8)', () => {
    const store = createStreamStore('c3');
    performCreation(store, { now: 1_700_000_000_000 });
    expect(store.getValue('storeSchemaVersion' as never)).toBeUndefined();
  });
});
