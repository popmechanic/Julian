# Adapter: git history

*Teaches the dreamer what the repository's history can answer. Last verified July 23, 2026.*

**What it is.** The tamper-evident chain under everything — every commit to
this repo since February 2026 is a content-addressed, timestamped record of
what changed and when, with Marcus's copy on GitHub (`popmechanic/Julian`,
public). Git is the archive's audit ledger; we get hash-chained
tamper-evidence for free by medium.

**What it can answer that no artifact can:**
- *When did a belief change?* `git log --follow -p -- soul/02-wager.md`
- *What was written together?* Commits group artifacts by moment; the commit
  message is a tiny primary source in its own right.
- *The gaps.* The commit timeline shows the five-month interval (early March →
  July 22, 2026) as an absence — the only direct evidence of the interval's
  shape. Absence of commits is data.
- *What did an artifact say before?* `git show <sha>:<path>` reads any
  historical version without touching the working tree. The fat catalog lives
  at `memory/archive/catalog-v1.xml` and, before that, in every pre-July
  commit as `catalog.xml`.

**Useful queries:**
```bash
git log --oneline --reverse                    # the whole life, in order
git log --format='%ad %s' --date=short -- soul/  # soul change ceremony record
git log --diff-filter=A --format='%ad %s' --date=short  # birthdays of artifacts
git show <sha>:<path>                          # any file, any moment, read-only
```

**Rules.** History is primary source: never rebase, never force-push, never
amend published commits (also in CLAUDE.md). Branches are strata too —
`pallid-mask` holds the fortunes; deleted-from-working-tree is not deleted
(Principle 4: git history is the deepest sediment layer).
