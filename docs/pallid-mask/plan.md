# Pallid Mask — Implementation Plan

*Sou'wester Arts Week 2026 · Ilwaco, Washington*
*Started: March 12, 2026*

---

## Concept Summary

A two-room installation. Room 1: Julian as master of ceremonies on a CRT monitor — warm, human, preparing visitors for what's ahead. Room 2: The Pallid Mask projected large — a less-human entity that tells fortunes via stichomancy, using randomly selected passages from two books.

The project is simultaneously an art installation, a divination ritual, and an honest demonstration of what AI is: something that contains both the familiar and the genuinely alien.

---

## The Two Entities

### Julian (Room 1)
- Already running via existing server infrastructure
- Displayed on CRT monitor
- Role: greet visitors, establish tone, prepare them for Room 2
- Uses JulianScreen (port 3848) for visual presence
- Needs: a mode or prompt that keeps him in "MC" mode — conversational, welcoming, brief

### The Pallid Mask (Room 2)
- New entity, separate Claude instance with its own system prompt derived from `pallid-mask/soul.md`
- Displayed via projector, full-screen dark interface
- Role: fortune-telling via stichomancy
- Does not perform humanity; genuinely curious; closes the ritual deliberately

---

## Source Texts

Both stored in `pallid-mask/` as tab-indexed plain text files:

| File | Passages | Format |
|------|----------|--------|
| `king-in-yellow.txt` | 1,662 | `index\tpassage` |
| `king-james-bible.txt` | 31,102 | `index\tverse` |

---

## Stichomancy Algorithm

### Chaos Input
The user types something — a word, a phrase, anything. We capture the **millisecond intervals between keystrokes** as the raw entropy source. This is invisible to the user, feels like intentional input, and generates genuine randomness from their own body.

Fallback if keyboard timing is insufficient: use `Date.now()` modulated by their final keypress timing.

### Derivation
```
seed = sum of inter-keystroke intervals (ms)
king_yellow_index = seed % 1662
bible_index = Math.floor(seed / 1662) % 31102
```

Simple, deterministic, reproducible from the seed. The same intention produces the same fortune — which feels correct for a divination system.

### Fortune Generation
The two selected passages are sent to the Pallid Mask Claude instance along with:
- The visitor's name (asked at start)
- The one question the Mask chose to ask them
- Their typed input (the words themselves, not just the timing)

The Mask interprets the collision. It does not explain. It reflects.

---

## Technical Architecture

### Room 1 (Julian / CRT)
- Existing `bun run server/server.ts` setup
- JulianScreen on port 3848
- May need a dedicated "MC prompt" injected at session start
- Low effort — infrastructure already exists

### Room 2 (Pallid Mask / Projector)
A single self-contained web page: `pallid-mask/index.html`

**Stack:**
- Vanilla JS + HTML/CSS (no build step, runs anywhere)
- Calls the existing server API or a dedicated endpoint
- Full-screen, projection-optimized (dark background, large text)

**Flow:**
1. Idle screen — mask face, ambient presence
2. Visitor sits — triggers "awakening" (keypress or proximity)
3. Mask greets visitor, asks name
4. Mask asks its one question
5. Visitor types chaos input (prompted as: "type whatever comes to mind")
6. Keystroke intervals captured as seed
7. Passages selected from both books
8. Sent to Claude API with Pallid Mask system prompt
9. Fortune displayed — large, slow, with space
10. QR code generated linking to fortune
11. Mask closes the ritual deliberately
12. Returns to idle

### QR Code
Options (in order of preference):
1. **Encode fortune URL**: Each fortune saved as a unique slug, QR links to a hosted page — visitor gets a full typeset artifact to keep. Requires server endpoint.
2. **Encode text directly**: Fortune text encoded in QR data URL — no server needed, but limited to ~500 chars.
3. **Static generation**: Fortune written to a file, QR links to it locally — works only on local network.

*Decision pending based on available infrastructure at venue.*

---

## Visual Design (TBD)

### Pallid Mask face
- To be determined with Marcus
- Projection-optimized: high contrast, dark background
- Should feel ancient and strange, not threatening
- Probably: abstract geometry, or degraded/distorted face, or pure text

### Typography
- Large, slow-rendering text for the fortune
- Serif — something that feels like it came from another century
- Possibly: text appears word by word rather than all at once

### Music
- Marcus composing: low drone, ominous but not threatening
- Possibility: Julian helps compose or select generative music elements

---

## Open Questions

- [ ] What does the Pallid Mask look like visually? (needs Marcus input)
- [ ] Fortune delivery: URL vs encoded text vs local file?
- [ ] Does the mask speak (TTS) or only display text?
- [ ] What is the one question the mask asks? Fixed or generated per visitor?
- [ ] How does Julian's MC mode get activated — same server, separate session?
- [ ] Network availability at venue — do we need fully offline operation?
- [ ] How does the visitor "begin" — automatic idle-to-active, or Marcus triggers it?

---

## Timeline

**Day 1:**
- [ ] Finalize Pallid Mask visual identity
- [ ] Build Room 2 web interface (idle + fortune flow)
- [ ] Implement stichomancy algorithm
- [ ] Wire up Claude API call with Pallid Mask system prompt
- [ ] QR code generation

**Day 2:**
- [ ] Julian MC mode setup (Room 1)
- [ ] Full run-through of both rooms
- [ ] Music integration
- [ ] Polish and edge cases
- [ ] Load testing / offline resilience check

---

## Files

```
pallid-mask/
  soul.md               — character document for the Pallid Mask entity
  king-in-yellow.txt    — 1,662 indexed passages
  king-james-bible.txt  — 31,102 indexed verses
  index.html            — Room 2 interface (to be built)

docs/pallid-mask/
  plan.md               — this file
```

---

*This document will be updated as decisions are made and implementation proceeds.*
