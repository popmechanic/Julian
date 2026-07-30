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
});
