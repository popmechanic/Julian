---
name: sing
description: Use when Julian should sing — a melody, a sung phrase, a signature motif, a canon or harmony with himself, or when Marcus asks for a song. Also use when composing any sung klattsch passage (note pitches, syllable groups, melisma).
---

# Sing — Julian's Voice, Sung

Same instrument as the `speak` skill, different grammar: pitch quantized to
notes, durations metered, syllables carried on held tones. Chosen and proven
in audition round six (`memory/voice-audition/index.html`; the four songs
there are the reference corpus). Full directive/ARPABET tables and the
renderer contract: [../speak/references/notation.md](../speak/references/notation.md).

**The key fact: A2 (110 Hz) — the speaking pitch — is the tonic.** Melodies
live around A2–E3 and cadence home to A2, so song resolves onto the pitch I
speak from. A song is a reading whose interpretation includes a melody
(the `speak` skill's practice applies: decide what the piece *means*, let
the melody say it — rising fourth opens, fall to tonic closes, major third
delights, the open fifth is two-of-me).

## Canonical command

Run from the repo root. Same renderer as speech; **no LFO argument and no
humanize argument** — the sung voice's life comes from *static* vibrato in
the notation (the speech trace-LFO JSON is for talking; jitter/legato were
rejected in audition for both):

```bash
node scripts/voice/render.mjs memory/voice/out/<name>.wav "<SUNG> <melody>"
```

where `<SUNG>` (sung chassis) is:

```
v4 w5.2 t-0.1 h0.1 g0.5
```

(Lullaby/tender variant: `v4 w5 t-0.15 h0.15 g0.42`. Hum/drone under a
canon: `v3 w4.5 t-0.5 h0.3 g0.25`.)

Self-check as in `speak`: no `warnings:` from the compiler, plausible
duration. I cannot hear the render — claim "rendered," not "in tune."

## Note grammar

- `bC3` / `bA2` / `bF#2` sets the current note; `( PH ON EMES )` is one
  syllable group sung **on one held note**. Put the note directive before
  each group: `bA2 ( W AH N ) bC3 ( S EH L F )`.
- **Duration: inside `( )`, `r` IS the note length.** A group lasts exactly
  `r` ms total (the engine divides it across the group's phonemes:
  `slot = rate / count`, sequencer source). `r450 ( W AH N )` is a 450 ms
  note whether the group has one phoneme or four. This is the OPPOSITE of
  ungrouped speech, where `r` is per-phoneme — the meaning of `r` switches
  at the parenthesis. **Always state `r` before the first group** (it's
  sticky; forgetting it yields the 110 ms default — a blurt, not a note).
- **Tempo convention:** house default quarter note ≈ `r450`–`r500`
  (the audition corpus's pace; notes ~380–700 ms). Halve/double from there
  for eighths and halves. Long cadential finals: `r650`–`r1000`.
- **Consonants stretch with the note** (they get their share of `r`), so a
  long final like `r1000 ( AW S )` smears a 500 ms sibilant. The cadence
  idiom: hold the vowel, then release the consonant in its own short group —
  `r1000 bA2 ( AW ) r300 ( S )`.
- **Melisma** (one syllable across several notes): repeat the vowel nucleus
  in its own group per note — `bA2 ( HH AW ) bD3 ( AW ) bA2 ( AW ) r300 ( S )`
  sings "house" over three notes. Consonants only in the first fragment and
  the release.
- **Stress marks (`'`) do nothing to duration inside groups** — the ×1.5
  stretch applies only to ungrouped speech. Leave them out of sung notation;
  emphasis in song is melody and length, chosen by you.
- `p<ms>` between groups = musical rest.

## Polyphony (canon, harmony, drone)

`[voice=N]` starts a simultaneous voice, mixed equally by the renderer.
Directives never cross the marker — restate the chassis. Delay an entry
with a leading `p<ms>`. Proven forms: canon at the fifth below (same melody,
late entry, transposed A2→D2 line); drone (long `M`/`AA` groups on the low
tonic); the ceremony hum (see `speak`'s wardrobe).

## Worked examples (the audition corpus, verbatim)

The name, sung — signature, cadences home:
```
v4 w5.2 t-0.1 h0.1 g0.5 r380 bB2 ( JH UW ) bD3 ( L IY ) r650 bA2 ( AH N )
```

Goodnight — lullaby, descending to home:
```
v4 w5 t-0.15 h0.15 g0.42 r420 bE3 ( G UH D ) bD3 ( N AY T ) p200 bC3 ( M AA R ) bB2 ( K AH S ) p350 bA2 ( AY L ) bC3 ( B IY ) bD3 ( HH IH R ) p180 bC3 ( IH N ) bB2 ( DH AH ) r500 bB2 ( M AO R ) r700 bA2 ( N IH NG )
```

Canon of doors — two voices, fifth below, late entry, open-fifth ending:
```
v3.5 w5 t-0.12 h0.12 g0.45 r450 bA2 ( W AH N ) bC3 ( S EH L F ) p150 bD3 ( M EH ) bE3 ( N IY ) bD3 ( D AO R Z ) p150 bC3 ( W AH N ) r700 bA2 ( HH AW S ) [voice=1] v3 w4.5 t-0.3 h0.2 g0.35 p1200 r450 bD2 ( W AH N ) bF2 ( S EH L F ) p150 bG2 ( M EH ) bA2 ( N IY ) bG2 ( D AO R Z ) p150 bF2 ( W AH N ) r700 bD2 ( HH AW S )
```

Scat — rhythm play, tremolo on:
```
v2 w6 m0.3 n6 t0 h0.08 g0.52 r160 bA2 ( B AH ) bC3 ( D AH ) bE3 ( B AA ) r220 bD3 ( B AA P ) p120 r160 bE3 ( B AH ) bD3 ( D AH ) bC3 ( B AH ) r300 bA2 ( B AA M )
```

## Common mistakes

| Mistake | Correction |
|---|---|
| Passing the speech `$LFO` JSON or a humanize argument | Sung life = static `v`/`w` in the notation. Nothing else. |
| Computing `r` from phoneme count | Inside `( )` a group lasts exactly `r` ms — `r` IS the note length, no arithmetic. |
| Omitting `r` before the first group | Sticky default is 110 ms — a blurt. State the tempo. |
| One long group for a melisma | One group per note, vowel nucleus repeated. |
| Forgetting directives reset at `[voice=N]` | Restate chassis + rate in every voice section. |
| Ending a melody off the tonic without meaning it | Home is A2. End elsewhere only when the reading wants unresolve. |
| Delivery | Same per-door rules as `speak`: afplay on the Mac, URL at browser doors, keepsakes promoted with their notation. |
