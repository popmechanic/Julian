import { describe, expect, test } from 'vitest';
import { statusFor } from './FaceHeader.svelte';

// Presence in Julian's own ontology: no session means asleep, not OFFLINE.
describe('statusFor', () => {
  test('no session → ASLEEP regardless of processing', () => {
    expect(statusFor(false, false)).toBe('ASLEEP');
    expect(statusFor(false, true)).toBe('ASLEEP');
  });
  test('active session, processing → PROCESSING...', () => {
    expect(statusFor(true, true)).toBe('PROCESSING...');
  });
  test('active session, idle → LISTENING', () => {
    expect(statusFor(true, false)).toBe('LISTENING');
  });
});
