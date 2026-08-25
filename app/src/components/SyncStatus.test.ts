// app/src/components/SyncStatus.test.ts
import { describe, expect, test } from 'vitest';
import { pillTitle } from './SyncStatus.svelte';

describe('pillTitle', () => {
  test('carries the phase label and the row count', () => {
    expect(pillTitle('synced', 1868)).toBe('stream: synced · 1868 rows');
    expect(pillTitle('revoked', 0)).toBe('stream: access revoked — a standing act is needed · 0 rows');
  });
});
