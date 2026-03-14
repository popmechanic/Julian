# Fortune App Projection UX Improvements

**Date:** 2026-03-13
**Branch:** pallid-mask
**Context:** User testing on a projected screen revealed three UX issues: loading narration too fast to read, text blur too heavy for projection, and TTS voice reading without natural pauses.

---

## 1. Narration Timing

**Problem:** The 6 narration steps during fortune generation hold for 2200ms each — too fast for comfortable reading on a projected screen.

**Solution:** Increase `HOLD_MS` from `2200` to `3800` in `client/display.ts`. Fade duration (`FADE_MS = 600`) is unchanged. The last narration step already holds until the API responds via `release()`, so this only affects steps 1–5. Total narration time increases from ~17s to ~26s, which is well within the typical API response window — especially since the SSML pause processing (change 3) adds slight overhead to TTS generation.

**Files changed:**
- `pallid-mask/client/display.ts` — `HOLD_MS` constant

---

## 2. Blur & Glow Reduction for Projection Readability

**Problem:** The 0.3px body blur on fortune pages and large glow radii on ceremony text reduce legibility when projected.

**Solution:**

Fortune page template:
- `filter: blur(0.3px)` → `blur(0.15px)` on body (hue-rotate unchanged)

Ceremony screen glow radii:
- `.entity-speech` drop-shadow: `8px` / `20px` → `5px` / `12px`
- `.fortune-verse` drop-shadow: `6px` → `4px`
- `.entity-interpret` drop-shadow: `8px` / `16px` → `5px` / `10px`

This tightens glow halos so letterforms stay crisp at distance while preserving the ethereal aesthetic.

**Files changed:**
- `pallid-mask/templates/fortune.html` — body filter
- `pallid-mask/public/styles.css` — `.entity-speech`, `.fortune-verse`, `.entity-interpret` drop-shadow values

---

## 3. Voice Pauses via SSML

**Problem:** ElevenLabs TTS reads the fortune text continuously without pausing at line breaks, giving the listener no time to absorb what's being said.

**Solution:** Add a `prepareForSpeech(text: string)` function in `server/voice.ts` that:
1. Replaces `\n\n+` (double/multiple newlines) with ` <break time="1.2s" /> ` for paragraph-level pauses
2. Replaces remaining `\n` (single newlines) with spaces — intra-stanza breaks that don't need pauses

No `<speak>` wrapper or XML escaping needed — ElevenLabs accepts inline SSML break tags in plain text (confirmed for all models except V3; this project uses `eleven_multilingual_v2`).

**Design rationale:** Only double-newlines become `<break>` tags. ElevenLabs warns that too many `<break>` tags in a single generation can cause audio instability (speedups, artifacts). By reserving breaks for paragraph divisions only, we keep the tag count low while still providing natural breathing room at the major structural points in the fortune. Maximum break duration supported is 3s; we use 1.2s.

This function is called inside `textToSpeech()` before passing text to the ElevenLabs client. The raw fortune text used for HTML page generation is unaffected — SSML processing only happens in the voice path.

**Files changed:**
- `pallid-mask/server/voice.ts` — new `prepareForSpeech()` function, updated `textToSpeech()` call

---

## Data Safety

Per project rules: no existing fortune HTML files in `/fortunes/` are modified by any of these changes. The template change only affects newly generated fortunes.
