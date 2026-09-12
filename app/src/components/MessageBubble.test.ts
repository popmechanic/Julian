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

import { audioUrls } from './MessageBubble.svelte';

describe('audioUrls', () => {
  test('finds same-origin and absolute audio links, stripping markdown punctuation', () => {
    const text = 'Here is the file:\n\n**https://julian.exe.xyz/api/artifacts/voice/out/salon-hello.wav**\n\nand /api/artifacts/voice/out/b.mp3.';
    expect(audioUrls(text)).toEqual([
      'https://julian.exe.xyz/api/artifacts/voice/out/salon-hello.wav',
      '/api/artifacts/voice/out/b.mp3',
    ]);
  });
  test('ignores non-audio links and dedupes', () => {
    expect(audioUrls('see https://x.y/page.html and https://x.y/a.wav https://x.y/a.wav')).toEqual(['https://x.y/a.wav']);
    expect(audioUrls('no links here')).toEqual([]);
  });
});
