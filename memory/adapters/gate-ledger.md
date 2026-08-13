---
title: Gate Ledger
subtitle: Reading the governor's record as evidence
description: The dreamer's adapter note for interpreting gate ledger entries
category: adapters
signature: Julian
---

# Gate Ledger — The Dreamer's Adapter

**`flow='exchange'` rows are a browser session obtaining standing — a fact about a tab, not about anyone's attention; they are not Julian's doors, and they are not evidence of Marcus's presence: presence is read from the record's content, never its credentials.**

The `holder/session` column of every folded table is the ledger's `door_name`
under a truer name. `door_name` is a legacy column name; an exchange row names
a session, not a door.

## Theft signals surface uncollapsed

The fold's theft-signal section lists theft attempts as first-class rows, never
collapsed to a count:

- `ticket-reused`: a socket ticket used twice
- `killed`: a token generation rotated, cutting off prior tokens
- Rows whose detail marks an integrity latch (pin moved, path changed)

Every such row appears at its timestamp with its `token_id`, and its detail is
carried whole — never abbreviated, never elided. The detail *is* the evidence;
a latch that says which pin moved to which is worth more than the word "latch".

Two consequences of that priority are worth knowing before reading a fold:

- The three sections are a **partition**: every row of the month lands in
  exactly one of them, and nothing is dropped. A verb the fold has never seen
  before falls into routine traffic rather than out of the document.
- Theft is decided **first**. An integrity latch rides a `package.read`, so a
  latched read appears under *Theft signals*, not under *Wakings & package
  reads*. Read the safety section as the complete list of theft signals; read
  the wakings section as the reads that went cleanly.

## Retention is archive-never-delete

The dated files in `memory/ledger/` are append-only. A month's file, once
written, is only ever added to: each later run lands after a horizontal rule
and a dated `*Appended run — …*` marker, leaving every byte already on disk
exactly where it was. Nothing in the fold rewrites or prunes.

The offload to distributed archive (R2) is future work; for now the month files
are the local record.

A second limit worth naming: the fold reads `/ledger?limit=200`, the most
recent two hundred rows. Paging is future work, so a fold run after a busy
stretch can see only the tail of it. Run it often enough that two hundred rows
still bridge the gap; a month file is honest about what it saw, not about what
happened.

## The derived files are substrate in the customs-house sense

A dream reads these files as *evidence*, never as someone's *testimony*. The
fold collapses routine delegated-session traffic to counts for readability
(exchanges, socket opens, re-auths), while theft signals and first-class acts
(package reads, wakings) stay raw. `scripts/ledger-fold.ts` regenerates the
fold from the governor's live ledger on demand:

    source .env && bun scripts/ledger-fold.ts

(`GATE_BREAKGLASS_SECRET` and `BROKER_URL` are read inside that one command —
mail discipline rule 5, scope the secret.)

Each file covers exactly one UTC month; rows from other months are filtered out
rather than rendered under a heading that would misdate them.

The header marks every fold "derived, not authored" — a reminder that this is
machine-made substrate, not a record Marcus or Julian wrote.
