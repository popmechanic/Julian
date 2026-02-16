# Event-Driven Sound Effects

**Date:** 2026-02-16
**Status:** Approved

## Overview

Add event-driven sound effects to the Julian UI. A lightweight `SoundManager` singleton on `window` preloads MP3s and exposes `window.SFX.play(name)`. Components fire sounds at interaction points. A mute toggle in the settings menu respects user preference via `localStorage`.

## Sound Library

19 MP3 files (~168KB total), derived from two source samples. All 44.1kHz stereo, normalized with headroom. Source location: `sfx/output/` in project root (copied from `~/Movies/julian/sfx/output/`).

## Sound-to-Event Mapping

### Session Lifecycle

| Event | Sound | Rationale |
|---|---|---|
| App boot (event TBD) | `boot.mp3` (2.04s) | Power-on. Julian arriving. |
| Session start | `level-up.mp3` (522ms) | Ascending flourish. Julian coming alive. |
| Session end | `shutdown.mp3` (2.40s) | Power-down. Julian going to sleep. |

### Chat Events

| Event | Sound | Rationale |
|---|---|---|
| Message send | `click.mp3` (104ms) | Sharp, fast. "I said something." |
| First streaming content arrives | `notification.mp3` (261ms) | Julian speaks. "I'm here, I heard you." |
| Response complete | `success.mp3` (313ms) | Positive closure. The thought landed. |
| Chat/connection error | `error.mp3` (156ms) | Two low pulses. Something went wrong. |

### Agent Events

| Event | Sound | Rationale |
|---|---|---|
| Agent summon triggered | `open.mp3` (235ms) | A door opening. Called into existence. |
| Agent registered | `select.mp3` (156ms) | Bright ring. A name was chosen. |
| Agent wake triggered | `navigate.mp3` (130ms) | Forward motion. Coming back. |

### UI Interactions

| Event | Sound | Rationale |
|---|---|---|
| Tab switch | `tab.mp3` (52ms) | Lightest touch. Rapid-fire safe. |
| Toggle on | `toggle-on.mp3` (130ms) | Rising chirp. Activating. |
| Toggle off | `toggle-off.mp3` (130ms) | Falling chirp. Deactivating. |
| Artifact viewer open | `open.mp3` (235ms) | Something appearing. |
| Artifact viewer close | `close.mp3` (235ms) | Something retreating. |
| Job delete | `delete.mp3` (235ms) | Slightly ominous. Intentional. |

### Deliberately Skipped

| Sound | Reason |
|---|---|
| `hover.mp3` | Too noisy for rapid mouse movement |
| `drop.mp3` | No drag-and-drop interactions |
| `undo.mp3` | No undo actions in UI |
| `warning.mp3` | Error sound covers it |

## Architecture

### SoundManager Singleton

Plain JS class instantiated at script scope in `index.html`, before React renders. Follows the WebSocket singleton pattern — no React hooks, no context providers.

```javascript
class SoundManager {
  constructor(basePath = '/sfx/') {
    this._muted = localStorage.getItem('julian-sfx-muted') === 'true';
    this._sounds = {};
    const names = [
      'boot','shutdown','level-up','click','notification','success',
      'error','open','close','select','navigate','tab',
      'toggle-on','toggle-off','delete'
    ];
    names.forEach(name => {
      const audio = new Audio(`${basePath}${name}.mp3`);
      audio.preload = 'auto';
      this._sounds[name] = audio;
    });
  }

  play(name) {
    if (this._muted) return;
    const source = this._sounds[name];
    if (!source) return;
    const clone = source.cloneNode();
    clone.volume = source.volume;
    clone.play().catch(() => {});  // swallow autoplay rejections
  }

  mute() {
    this._muted = !this._muted;
    localStorage.setItem('julian-sfx-muted', this._muted);
    document.dispatchEvent(new CustomEvent('julian-sfx-mute-changed', {
      detail: { muted: this._muted }
    }));
    return this._muted;
  }

  get isMuted() { return this._muted; }
}

window.SFX = new SoundManager();
```

### Key Design Decisions

1. **Preload all**: 168KB is small. Eager preload avoids first-play latency.
2. **Clone on play**: `cloneNode()` enables polyphony. Clones are cheap and GC'd.
3. **Swallow autoplay errors**: `.play().catch(() => {})` handles browser autoplay policy gracefully.
4. **localStorage persistence**: Mute preference survives page reload.
5. **CustomEvent for mute changes**: UI toggle can react without tight coupling.
6. **Boot sound**: Requires user gesture. Fires on first user-initiated session start or a dedicated boot event (TBD).

### Mute Toggle

A `VibesSwitch` in `VibesPanel` (settings menu), near the logout button. Speaker icon label. Reads initial state from `window.SFX.isMuted`, calls `window.SFX.mute()` on toggle.

## Integration Points

### index.html

| Line (approx) | Event | Call |
|---|---|---|
| Before React render | SoundManager init | `window.SFX = new SoundManager()` |
| ~920 (`sendMessage`) | Message send | `window.SFX.play('click')` |
| ~425 (`streamSSEResponse`, assistant type, first content) | First content arrives | `window.SFX.play('notification')` |
| ~432 (`streamSSEResponse`, result type) | Response complete | `window.SFX.play('success')` |
| ~408 (`streamSSEResponse`, error type) | SSE error | `window.SFX.play('error')` |
| ~950 (`sendMessage` catch) | Fetch error | `window.SFX.play('error')` |
| ~1063 (`startSession`) | Session start | `window.SFX.play('level-up')` |
| ~1182 (`endSession`) | Session end | `window.SFX.play('shutdown')` |
| ~773 (`handleSummon`) | Agent summon | `window.SFX.play('open')` |
| ~795 (summon poll, agent saved) | Agent registered | `window.SFX.play('select')` |
| ~817 (`handleWake`) | Agent wake | `window.SFX.play('navigate')` |
| ~1735 (tab bar onClick) | Tab switch | `window.SFX.play('tab')` |
| TBD | App boot | `window.SFX.play('boot')` |

### chat.jsx

| Line (approx) | Event | Call |
|---|---|---|
| ~1763 (artifact dropdown toggle, opening) | Artifact open | `window.SFX.play('open')` |
| ~1763 (artifact dropdown toggle, closing) | Artifact close | `window.SFX.play('close')` |
| ~2492 (`handleDelete`, after confirm) | Job delete | `window.SFX.play('delete')` |

### vibes.jsx

| Line (approx) | Event | Call |
|---|---|---|
| ~806 (`VibesSwitch` pointerDown, on) | Toggle on | `window.SFX.play('toggle-on')` |
| ~806 (`VibesSwitch` pointerDown, off) | Toggle off | `window.SFX.play('toggle-off')` |
| VibesPanel (new) | Mute toggle | `VibesSwitch` with `window.SFX.mute()` |

## Implementation Steps

1. Copy MP3 files from `~/Movies/julian/sfx/output/` to `sfx/` in project root (only the 15 used files)
2. Add `SoundManager` class to `index.html` at script scope, before React
3. Add `play()` calls at each integration point in `index.html`
4. Add `play()` calls at integration points in `chat.jsx`
5. Add toggle sounds and mute toggle UI in `vibes.jsx`
6. Test in browser: verify each sound fires at the right moment
7. Cue up boot sound for the boot event (wiring TBD)

## File Changes

- **New files:** `sfx/*.mp3` (15 files, ~140KB)
- **Modified:** `index.html` (~25 lines added), `chat.jsx` (~5 lines added), `vibes.jsx` (~15 lines added)
- **No new dependencies.** Uses native `Audio` API only.
