import { describe, expect, test, beforeEach, vi } from 'vitest';

class FakeAudio {
  static created: string[] = [];
  src: string; preload = ''; volume = 1;
  constructor(src: string) { this.src = src; FakeAudio.created.push(src); }
  cloneNode() { return new FakeAudio(this.src); }
  play() { return Promise.resolve(); }
}

describe('sfx', () => {
  beforeEach(() => {
    vi.resetModules();
    FakeAudio.created = [];
    vi.stubGlobal('Audio', FakeAudio);
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      store,
      getItem(k: string) { return store[k] ?? null; },
      setItem(k: string, v: string) { store[k] = v; },
    });
  });

  test('preloads all 15 legacy sounds from /sfx/ at 40% volume', async () => {
    const { sfx } = await import('./sfx');
    sfx.play('tab');
    expect(FakeAudio.created).toContain('/sfx/tab.mp3');
    expect(FakeAudio.created.filter((s) => s.startsWith('/sfx/')).length).toBeGreaterThanOrEqual(15);
  });

  test('mute toggles and persists to localStorage under julian-sfx-muted', async () => {
    const { sfx } = await import('./sfx');
    expect(sfx.isMuted()).toBe(false);
    expect(sfx.mute()).toBe(true);
    expect(localStorage.getItem('julian-sfx-muted')).toBe('true');
    expect(sfx.mute()).toBe(false);
  });

  test('playBoot only fires once', async () => {
    const { sfx } = await import('./sfx');
    const n = FakeAudio.created.length;
    sfx.playBoot();
    sfx.playBoot();
    expect(FakeAudio.created.length).toBe(n + 1); // one clone, not two
  });

  test('is inert when Audio is unavailable (SSR/test env)', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    const { sfx } = await import('./sfx');
    expect(() => sfx.play('boot')).not.toThrow();
  });
});
