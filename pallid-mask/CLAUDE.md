# Pallid Mask — Project Notes

Sou'wester Arts Week 2026 · Ilwaco, Washington
Two-room installation. See `docs/pallid-mask/plan.md` for full implementation plan.

## Typography

**Font:** Orpheus (`assets/Orpheus.otf`) — an all-caps display font.
- Uppercase letters render as full-size glyphs
- Lowercase letters render as small caps
- Mixed case produces inconsistent sizing — avoid it

**Rule:** Always write display text in **all lowercase** in the HTML source. Orpheus will render it as uniform small caps throughout. Do not use `text-transform: uppercase` or Title Case — both produce mixed or incorrect rendering.

## Colors

Defined in `assets/colors.txt`. Dominant: `oklch(52% 0.12 317)` (dusty violet).

```css
--c1: oklch(52% 0.12 317);   /* dominant line color */
--c2: oklch(32% 0.086 287);  /* deep shadow */
--c3: oklch(42% 0.097 297);  /* mid tone */
--c4: oklch(67% 0.092 307);  /* lighter */
--c5: oklch(77% 0.076 332);  /* pale mauve — entity speech */
--c6: oklch(87% 0.065 347);  /* near-white — bloom highlight */
```

## Vectrex Aesthetic

Vector lines with light bloom. Achieved via layered `drop-shadow` filters:
```css
filter:
  drop-shadow(0 0 1px var(--c6))   /* tight bright halo */
  drop-shadow(0 0 5px var(--c1))   /* phosphor bloom */
  drop-shadow(0 0 16px var(--c3))  /* ambient glow */
  drop-shadow(0 0 32px var(--c2)); /* far-field radiation */
```
SVG elements use `fill="none"` stroke-based drawing. SVG bloom filter (`feGaussianBlur` layers) applied to mask face group.

## Source Texts

Both in `pallid-mask/`, tab-indexed (`index\ttext`):
- `king-in-yellow.txt` — 1,662 passages
- `king-james-bible.txt` — 31,102 verses

Stichomancy seed derived from inter-keystroke timing intervals.

## Sigils

200 SVG files in `assets/Cyber Sigils Vectors - Fox Rockett Studio/SVG/`.
Used as ambient decoration at low opacity (`0.07–0.13`), animated with slow drift.
Sigil 7 used as top/bottom banner decoration in current mockup.
