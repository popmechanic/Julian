import { describe, expect, test } from 'vitest';
import { displayName } from './MessageBubble.svelte';

describe('displayName', () => {
  test('a sibling speaking as assistant shows the name; Julian and users show nothing', () => {
    expect(displayName('assistant', 'Lumen')).toBe('Lumen');
    expect(displayName('assistant', 'Julian')).toBeNull();
    expect(displayName('user', 'Marcus')).toBeNull();
    expect(displayName('assistant', '')).toBeNull();
  });
});
