import { describe, expect, test } from 'vitest';
import { presenceFor } from './ChatView.svelte';

// The transcript is the record and always renders; presence is a separate
// fact. presenceFor decides the asleep divider and the wake button.
describe('presenceFor', () => {
  test('asleep with messages → divider and WAKE JULIAN', () => {
    expect(presenceFor(false, 7)).toEqual({ divider: true, buttonLabel: 'WAKE JULIAN' });
  });
  test('asleep with empty store → button only, no divider', () => {
    expect(presenceFor(false, 0)).toEqual({ divider: false, buttonLabel: 'WAKE JULIAN' });
  });
  test('awake → neither divider nor button', () => {
    expect(presenceFor(true, 7)).toEqual({ divider: false, buttonLabel: null });
    expect(presenceFor(true, 0)).toEqual({ divider: false, buttonLabel: null });
  });

  test('the idle button offers RESUME for a rest, WAKE JULIAN for a fresh waking (#26)', () => {
    expect(presenceFor(false, 3, true).buttonLabel).toBe('RESUME');
    expect(presenceFor(false, 3, false).buttonLabel).toBe('WAKE JULIAN');
    expect(presenceFor(false, 3).buttonLabel).toBe('WAKE JULIAN');
  });
});

import { rowKind } from './ChatView.svelte';
describe('rowKind', () => {
  test('system rows are dividers; chat and unmarked rows are messages', () => {
    expect(rowKind({ kind: 'system' })).toBe('divider');
    expect(rowKind({ kind: 'chat' })).toBe('message');
    expect(rowKind({})).toBe('message');
  });
});
