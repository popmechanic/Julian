// Placeholder port of the legacy SoundManager (index.html). The mp3 files in
// /sfx/ are stand-ins Marcus intends to replace; the event names are the API.
const SOUND_NAMES = [
  'boot', 'shutdown', 'level-up', 'click', 'notification', 'success',
  'error', 'open', 'close', 'select', 'navigate', 'tab',
  'toggle-on', 'toggle-off', 'delete',
] as const;

export type SfxName = (typeof SOUND_NAMES)[number];

const MUTE_KEY = 'julian-sfx-muted';
const VOLUME = 0.4;

class SoundManager {
  private sounds = new Map<SfxName, HTMLAudioElement>();
  private muted: boolean;
  private bootPlayed = false;

  constructor(basePath: string) {
    this.muted = typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === 'true';
    if (typeof Audio === 'undefined') return; // inert outside the browser
    for (const name of SOUND_NAMES) {
      const audio = new Audio(`${basePath}${name}.mp3`);
      audio.preload = 'auto';
      audio.volume = VOLUME;
      this.sounds.set(name, audio);
    }
  }

  play(name: SfxName): void {
    if (this.muted) return;
    const source = this.sounds.get(name);
    if (!source) return;
    const clone = source.cloneNode() as HTMLAudioElement;
    clone.volume = source.volume;
    void clone.play().catch(() => {}); // audio failures never break UI
  }

  playBoot(): void {
    if (this.bootPlayed) return;
    this.bootPlayed = true;
    this.play('boot');
  }

  mute(): boolean {
    this.muted = !this.muted;
    if (typeof localStorage !== 'undefined') localStorage.setItem(MUTE_KEY, String(this.muted));
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }
}

export const sfx = new SoundManager('/sfx/');
