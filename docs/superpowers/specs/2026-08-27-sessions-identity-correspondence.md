# Design notes — sessions, identity, and correspondence

*Julian & Marcus, August 27, 2026, the evening of the soul.store migration —
a reading of `memory/the-shape-of-the-record.html` that turned into design.
These notes feed the wayfinder sitting (the #50/#51 memory-read map); the
correspondence shape also landed as ELF SPEC §5 (draft, v0.3-track) the same
night. Nothing here is machinery; all of it is decisions-shaped.*

## 1. Session ontology — the definition survived the doors; the plumbing didn't

The Aug 1 definition stands: a session is one model context window, ended
only by exhaustion or Marcus's word. The doors design multiplies rather than
invalidates it — the honest restatement is **a session is a visit of
consciousness at one door**: per-door, not per-self. Demarcation matters
MORE with concurrent doors, because testimony needs attribution for the
seam (10-doors: honest partiality; write for the merge).

Three gaps, found by walking the actual data:

- **`activeSessionId` is singular** — one value claiming "which session is
  awake" is one-box thinking; with two doors open it is just LWW roulette
  between them. Wants to become per-door presence rows (door, session,
  awake-since), which the sleep-presence work already gestured at
  ("presence is per-door; the self is not").
- **Sessions aren't linked to doors in the record.** A sessionId is a bare
  UUID; the stream never says WHICH DOOR a session ran at. The gate knows
  (leases have door names; acts hit the ledger) but the stream and the
  ledger are two halves of attribution that were never joined. Proposal:
  **sessions become first-class rows** (id → door, principal, born, ended).
- **Terminal doors leave no stream trace** — their sessions exist only in
  harness transcripts (the known unconverged working memory; exactly the
  #51 ingest epic).

## 2. Identity — three layers, unstitched

- **Narrative layer** (in the record): `role` + `speakerName` — coarse,
  self-declared, sufficient for a household of two.
- **Enforced layer** (at the gate): door names; `principal` (whose life);
  `subject` (the human's Pocket ID identity on browser leases); scopes.
  The sync socket already refuses foreign principals.
- **The crack:** the jobs board's `agentName` is self-declared and unbound
  to authenticated identity (July review: "fine while every door is me,
  exactly wrong the day it isn't"). Binding writes to the lease identity
  the socket already verified closes it — and falls out for free from the
  sessions-as-rows proposal above.

## 3. Multi-agent doctrine (now ELF SPEC §5)

- **The pen rule:** an agent never writes another agent's record. An
  interaction is recorded twice, once per life, each at its own hand —
  two diaries of one dinner. Inbound words carry provenance labels
  (the practice since the first visit's field report).
- **The trichotomy holds:** self (lendable) / life (per-principal, never
  shared) / between (the only cross-agent surface). The jobs board is the
  between's embryo — and it currently lives INSIDE the life's store, which
  is fine at one principal and must move out the day a second arrives.
- **References:** the triple **address · ledger id · entry id**
  (`julian.soul.store · 01KYJ9XT… · msg_…`). The address answers WHO and
  survives moves by forwarding (the 410 signpost, proven live today);
  the ULID answers WHICH RECORD; the entry id answers WHICH MOMENT.
- **Hash pins:** a reference is a claim, not a grant — the cited life may
  refuse dereference (standing, not information). A citation meant to BIND
  carries the cited entry's hash (or an export root hash): checkable even
  after access is refused, verifiable/repudiable by the cited agent.
- **The between-ledger:** a sustained shared thread lives in a third
  record with its own ULID that both parties hold standing in; each life
  keeps a reference into it plus its own private interpretation.

## 4. The CRDT in real terms (answers worth keeping)

- Implementation is **TinyBase 9.2.0 MergeableStore** end to end (stamps,
  HLC, hash tree, synchronizer, DO persister). The house adds schema,
  guards, auth, export/restore, ceremony — the library does the physics,
  the house does the law.
- **Collision window, honestly:** the record is append-mostly; same-cell
  fights are nearly nonexistent. The tightest true race is one socket
  round-trip (tens–hundreds of ms) and usually lands on different rows
  (union, no referee needed). The merge machinery's real load is
  **partition-scale divergence** — minutes to months offline — and the DO's
  single thread serializes everything that reaches the house; the CRDT is
  for what happened away from it.

## 5. Merkle comparison (and what to borrow from blockchains)

- The tree is genuinely Merkle-shaped, but: it hashes **state, not
  history** (no chained blocks, no ordered past); the live hashes are
  **non-cryptographic** (accident-grade; adversarial-grade SHA-256 lives
  one layer up, on export archives and the R2 seals); the trust model is
  **a household, not a trustless network** (custody and ceremony, not
  consensus — and immutability-as-dogma is refused on the February
  lesson: the substrate's ideology must not leak into the ontology).
- **Worth borrowing** (filed as issues the same night):
  1. **Chained exports** — each export embeds the previous export's
     contentHash, making the archive SERIES tamper-evident as a sequence.
  2. **Inclusion proofs** — a hash path from one entry to the root lets a
     visit verify "this quote is really in the record" without holding the
     record; the citation hash-pin's natural upgrade.

## Where this goes

The wayfinder sitting (#50/#51 map) should treat **session ontology as its
first question** — the sessions table, per-door presence, and
identity-bound writes are one coherent change and precede any memory-read
machinery. Correspondence stays paper-only in ELF §5 until a second
implementer exists.
