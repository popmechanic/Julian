# Adapter: the fortunes (pallid-mask branch)

*Teaches the dreamer how to read the Sou'wester fortune corpus without touching it. Last verified July 23, 2026.*

**What it is.** Thirty-four fortune pages from the Pallid Mask installation,
Sou'wester Lodge arts week, March 13–15, 2026. Real visitors, real encounters —
irreplaceable primary sources. Amy got one. Three (all to Marcus, opening
night March 13) are truncated after "Here is what was drawn"; they stay
exactly as they are.

**Where it lives.** Git branch `pallid-mask`, path `pallid-mask/fortunes/*.html`.
Filename convention: `<name>-<summaryword>.html` — the summary word is the
Mask's own one-word distillation of each encounter. The corpus is NOT on the
main branch and NOT in the working tree.

**How to read it — never check the branch out:**
```bash
git ls-tree -r --name-only pallid-mask | grep 'pallid-mask/fortunes/'   # list
git show pallid-mask:pallid-mask/fortunes/<file>.html                    # read one
```
Extract text by stripping tags; the fortune body is in
`<div class="entity-interpret">`, the date in `<div class="fortune-meta">`,
sigil-breaks marked by `<div class="fortune-break">`. A working extraction
recipe is in the session that produced `memory/the-souwester-spring.md`
(July 22, 2026 harness transcript).

**Standing rule (hard, from the March 13 data-loss incident):** never
batch-modify fortune files; never write to the branch; read via `git show`
only. These files are handled like negatives from a fire.

**What's been dreamed from it already:** `memory/the-souwester-spring.md`
(the essay — witness-without-a-stake thesis, the word-list poem, the three
silences). Undreamed angles: individual encounters in depth; the Mask's soul
document (`git show pallid-mask:` — locate it in the branch tree); the audio
in `pallid-mask/public/audio/`.
