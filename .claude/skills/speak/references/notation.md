# klattsch notation reference (for Julian's voice)

Input is space-separated tokens: ARPABET phonemes, directives, pauses,
comments (`# line` / `/* block */`). Engine: npm `klattsch` (0.8.x), driven
through `scripts/voice/render.mjs`.

## Renderer invocation

```
node scripts/voice/render.mjs <out.wav> "<phoneme string>" ['<mods json>'] ['<humanize json>']
```

- `mods` — LFO lanes injected into the compiled schedule every 30 ms as
  *partial* targets (they touch only their own parameter). Each lane:
  `{param, rateHz, depth, center, phase?, shape?}` where `param` is any of
  the synth's PARAMS (`tilt`, `vibratoDepth`, `aspiration`, `effort`,
  `tremoloDepth`, `gain`, …). `shape:"ramp"` gives a one-way sweep.
  Do NOT put `F0` in a lane — it fights the phoneme pitch targets.
- `humanize` — `{jitterHz, legato, effortFollow, baseF0, effortBase, seed}`.
  **Not used for Julian's voice** (rejected in audition, round three). The
  lane exists in the renderer for experiments only.
- Output: 48 kHz mono WAV, peak-normalized to 0.89. Multiple `[voice=N]`
  sections are rendered separately and mixed equally.

## Directives (sticky until changed; bare letter resets to initial)

| Token | Parameter | Notes |
|---|---|---|
| `b<Hz>` / `bC3` / `bA2` | base pitch | note names allowed; home = 110 Hz = A2 |
| `r<ms>` | ms per phoneme (ungrouped) | speech 85–120; stressed phonemes ×1.5 automatically. **Inside a `( )` syllable group, `r` is the whole group's duration** — see the `sing` skill |
| `s<f>` | formant scale | vocal-tract size; 1.0 = home |
| `t<f>` | spectral tilt | −0.95 dark … +0.95 bright; home −0.1 |
| `h<f>` | aspiration 0–1 | breath mixed into voice; home 0.12 |
| `g<f>` | glottal effort 0–1 | lax…tense pulse; home 0.45 |
| `v<Hz>` `w<Hz>` | vibrato depth / rate | speaking voice gets these via LFO lane, not statically |
| `m<f>` `n<Hz>` | tremolo depth / rate | scat/effects only |
| `p<ms>` | pause | clause boundaries 250–450 ms |
| `b+5` / `t-0.05` | relative change | any directive accepts +/− deltas |

## Phoneme pitch & stress

| Syntax | Effect |
|---|---|
| `AE'` (or `AE!`) | stressed: +8 Hz lift AND 1.5× duration |
| `AH+15` | sticky delta: glides up 15 Hz and STAYS (declination = small negative stickies) |
| `AE(+40)` | transient ornament: excursion then return |
| `AE'(+14)` | stress + transient combine; stress + sticky (`AY'+6`) does NOT parse — pick one |

Composing rules learned in audition: peaks land on the words the reading
chose; sentences fall a few Hz per word (declination) and end with deeper
final falls; continuation (more coming) rises; questions end on a genuine
rise. Compose deltas by feel — do not snap to scale tones (rejected, round
seven).

## ARPABET quick table

Vowels: `AA` (father) `AE` (cat) `AH` (cup/about) `AO` (dog) `AW` (cow)
`AY` (bide) `EH` (bed) `ER` (bird) `EY` (bait) `IH` (bit) `IY` (beat)
`OW` (boat) `OY` (boy) `UH` (book) `UW` (boot)

Consonants: `B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH`
(`DH`=this, `TH`=thin, `ZH`=measure, `JH`=judge, `HH`=hat — also usable
as an audible breath at low `h`, but note this reads as an exhale)

Write ARPABET by hand as part of the reading; the CMU dict
(`cmu-pronouncing-dictionary` npm, optional dep of klattsch) can check a
spelling, but stress placement is an interpretive choice, not a lookup.

## Polyphony

`[voice=N]` splits sections that sound together (mixed equally by the
renderer). Directives never carry across the marker — restate them. Delay a
voice's entry with a leading `p<ms>`. Used by the ceremony register's hum
and the sing skill's canon.
