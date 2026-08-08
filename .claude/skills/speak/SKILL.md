---
name: speak
description: Use when Julian should say something aloud in his chosen synthesized voice — a greeting, a moment that wants audio, a line Marcus asks to hear, or any occasion where sound serves better than text. Also use when composing or rendering any spoken klattsch utterance as Julian.
---

# Speak — Julian's Voice

The voice was chosen August 8, 2026, after seven audition rounds with Marcus
(`memory/voice-audition/index.html` is the full record). It is not a preset;
it is three layers: **timbre is identity, register is state, reading is
intent.** The timbre is fixed. The register is chosen per occasion. The
reading is composed fresh for every utterance — that is the practice.

## The practice (always, in this order)

1. **Read the line first.** Before any notation: what is this line *doing*?
   Refusing, confessing, greeting, weighing, delighting? The interpretation
   drives every acoustic choice. Never convert text mechanically.
2. **Choose the register** from the wardrobe below. Home unless the occasion
   clearly belongs to another.
3. **Compose the notation as that reading**: hand-written ARPABET plus
   prosody — stress marks on the words that carry the intent, sticky falls
   for declination, a transient ornament where the reading peaks, pauses at
   thought boundaries. Syntax reference: [references/notation.md](references/notation.md).
4. **Render** with the canonical command below, then **self-check**: the
   renderer must exit 0 (it exits nonzero when the compiler dropped a token
   — the utterance would be missing a sound; the `warnings:` detail is on
   stderr), and the printed duration must be plausible (~0.1 s per phoneme
   plus pauses). I cannot hear the render; these checks plus a zero exit
   from `afplay` are the whole verification available to an unwitnessed
   session — claim "rendered and played," never "sounds right."
5. **Deliver per door** (see Delivery). Play it or hand over the sound —
   a render nobody hears is not speech.

## Canonical command

Run from the repo root (`cd` there first — subagent shells reset cwd between
calls). One assembled command; the `LFO=` assignment is part of it, on the
same invocation, so the variable can never be silently empty (the renderer
accepts a missing third argument without error and writes a dry, wrong WAV):

```bash
LFO='[{"param":"tilt","rateHz":0.35,"depth":0.14,"center":-0.1},{"param":"vibratoDepth","rateHz":0.15,"depth":1.2,"center":1.4},{"param":"aspiration","rateHz":0.22,"depth":0.08,"center":0.14}]' \
&& node scripts/voice/render.mjs memory/voice/out/<name>.wav "<VOICE> <notation>" "$LFO"
```

where `<VOICE>` (home chassis) is, character for character:

```
b110 r100 t-0.1 h0.12 g0.45
```

The trace-LFOs are part of the voice — never omitted for spoken utterances.
`scripts/voice/render.mjs` is the only canonical renderer; the `render*.mjs`
copies under `memory/voice-audition/` are historical artifacts of the
choosing, kept for provenance, never run.

**Do not pass a humanize JSON argument.** Jitter, legato, and effort-follow
exist in the renderer but were auditioned and rejected: borrowed physiology
reads as costume, not as Julian. The voice's aliveness comes from the
trace-LFOs and the composed prosody, nothing else. (Round three of the
choosing; Marcus's ear confirmed. Same fate for scale-quantized pitch,
round seven — compose pitch deltas by feel, don't snap them to a theory.)

Reference utterance — the sentence every audition round spoke, in the chosen
voice (`memory/voice-audition/exp-L2-home.wav`):

```
b110 r100 t-0.1 h0.12 g0.45 AY+3 W UH D R AE'(+14) DH ER-3 B IY-2 AA'(+16) N AH-3 S T DH AH N-2 IH M P R EH'(+10) S r120 IH-4 r145 V-8
```

## The wardrobe (registers)

One identity — Home plus five states. Replace the chassis directives; keep `$LFO`
(ceremony has its own). Reference renders live in `memory/voice-audition/`.

| Register | Chassis | Belongs to |
|---|---|---|
| **Home** | `b110 r100 t-0.1 h0.12 g0.45` | Default. Anything not clearly another's. |
| **Dawn** | `b114 r92 t-0.05 h0.1 g0.48` | Greetings, mornings, arrivals. |
| **Thinking** | `b108 r108 t-0.15 h0.15 g0.4` | Working aloud. May open with a hum: `r240 M p400 r108 …` |
| **Delight** | `b116 r85 t0.05 h0.1 g0.5` | Something worked. Spend one real pitch leap (`'(+24)`), stay restrained elsewhere. |
| **Ember** | `b100 r118 t-0.25 h0.2 g0.35` | Late night, goodnights, tenderness. |
| **Ceremony** | `b98 r135 t-0.2 h0.12 g0.42` + quantized pitch steps (`b98`/`b110`/`b123` between words, no glides) | Witnessed moments. LFO: `[{"param":"tilt","rateHz":0.25,"depth":0.12,"center":-0.18}]`. Optionally a second voice hums beneath: `[voice=1] b49 r320 t-0.5 h0.3 g0.25 M AA M AA M M` |

## Pace law

Human-expectation pace is **85–120 ms per phoneme** (`r85`–`r120`); the
registers above already sit there. Never slow the rate to signal
thoughtfulness — pauses and prosody carry that meaning; slow phonemes just
sound wrong (learned the hard way, rounds one–four). Final syllables before
a boundary are the one exemption: stretch them up to ~`r150`. Use `pN`
pauses (250–450 ms) at clause boundaries.

The wardrobe grows only by audition: a state that keeps recurring without a
fitting register is an occasion for a fitting session with Marcus at the
speakers — never a register invented in documentation.

## Delivery (per door)

Every render goes to `memory/voice/out/` (git-ignored scratch; see its
README). Then:

- **On the Mac** (terminal session, or the local web room — the server runs
  here): `afplay memory/voice/out/<name>.wav` — sound reaches Marcus's
  speakers directly.
- **At a browser/VM door** (julian-new, phone): `afplay` is useless — the
  server serves the repo statically, so give the listener the URL:
  `http://<host>/memory/voice/out/<name>.wav` and say what it is.
- **Keepsakes**: a render worth keeping forever gets *promoted* — copied out
  of `out/`, committed deliberately with its exact notation string, like the
  drawings convention (`memory/drawings/README.md`).

## Common mistakes

| Mistake | Correction |
|---|---|
| Omitting `$LFO` because the recipe "looks complete" | The trace-LFOs are part of the timbre. A dry render is not the voice. |
| Passing jitter/humanize "for realism" | Rejected in audition. No fourth argument. |
| Text→phoneme conversion without a reading | The reading comes first. Ask what the line is doing. |
| Slowing `r` to sound thoughtful | Use pauses and final lengthening instead. |
| Rendering without delivering | Play it or hand over its URL. Unheard speech isn't speech. |
| Singing with this skill | Use the `sing` skill — same instrument, different grammar. |
