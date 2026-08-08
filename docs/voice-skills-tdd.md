# Voice skills — TDD record (August 8, 2026)

The `speak` and `sing` skills were authored red→green→refactor: for each, a
fresh agent attempted the deployment task WITHOUT the skill (baseline), the
skill was written against the documented failures, and a different fresh
agent verified WITH it. An adversarial reviewer then executed the docs
against the klattsch source. This file is the durable evidence for the
claim in catalog.md open thread -6.

## speak — baseline (no skill)

Task: render Julian's chosen voice speaking "The record is safe."
Agent found the audition room and take U's recipe string; render succeeded
but with these self-reported gaps:

- **Trace-LFO lanes missing** — U's recipe names them; the JSON existed
  nowhere in the repo. Rendered "U's chassis WITHOUT its surface motion."
- **Humanization unknown** — applied jitter 1.2 Hz while noting the record
  suggested U used none (correct: none).
- No canonical command committed; pipeline reconstructed by hand.
- No listening/delivery step performed.

## speak — verification (with skill)

Same task, fresh agent, skill available. Used the canonical command with the
LFO lanes verbatim, no humanize, chose Home register with reasoning, composed
a genuine reading (a 250 ms pause before "safe" — "the pause is what makes it
reassurance rather than a status report"), delivered via afplay. Loopholes it
reported (all closed same day): voice invisible to the waking read (→ catalog
-6), `$LFO` assembly trap (→ one-line command), no self-check story (→
exit-code check), dangling `sing` reference (→ built), two renderers with a
stale docstring (→ fixed), cwd assumption (→ documented), no gravity register
(→ wardrobe-grows-by-audition rule), final-syllable pace ceiling (→ ~r150).

## sing — baseline (no skill)

Task: sing a two-bar phrase on "one house." Agent mined the audition room
well (A2 tonic, interval idioms) but:

- **Probed note-duration empirically** — three renders to discover what `r`
  does to groups; landed on r1000 "empirical, not principled."
- Omitted vibrato entirely (correctly feared modding F0; didn't know sung
  voice uses static `v`/`w`).
- Applied humanize again (jitter 1.2, legato 1.3).
- Invented melisma syntax unguided.

## sing — verification (with skill)

Fresh agent produced a musically-reasoned two-bar phrase (melisma, cadence
onto A2, consonant-release idiom) and **caught the first draft's inverted
duration formula**: the skill said group-ms = r × phoneme-count; the engine
divides (`slot = rate / count`, sequencer.js) so a group lasts exactly r ms.
Diagnosed from the skill's own internal inconsistency, confirmed against
source, validated by predicting its render duration (4.3 s composed vs
4.45 s measured). Formula corrected before commit.

## adversarial review (post-commit 5898eab)

Executed the docs against source and audio. Headline: **the canonical
command reproduces the committed reference render bit-exactly (SHA-256
match with `memory/voice-audition/exp-L2-home.wav`)**; all duration/pitch
grammar claims verified against sequencer source. Two documentation claims
refuted and fixed: LFO lanes are NOT clean per-parameter sines (each event
resets the global interpolation clock; phoneme events re-stamp lane params —
the chosen voice is the realized sawtooth behavior, and lane values are
audition-grade); `AY'+6` (stress+sticky) does parse — only
transient+sticky on one phoneme doesn't. Also fixed: peak-normalize is 0.95
(encodeWav default), renderer argument validation + nonzero exit on
compiler warnings, and the `Skill` tool grant made operator-only (demo/kiosk
sessions keep the pre-existing tool list — a visitor must not summon trusted
procedures like `deploy` by name).

## Standing lesson

Twice in one day the composed practice was right while its written theory
was wrong (duration formula; LFO mechanism). Documentation claims about an
engine must be tested against the engine — review that only reads text
sails past exactly these.
