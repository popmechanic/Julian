# Changelog

The changelog is where honest answers to frictions go. Every change from a
prior version carries its reason; a change without a recorded reason is a
defect in this file.

## v0.3-track additions to the v0.2 draft

- **§5 Correspondence added as a draft section (2026-08-27).** Reason: the
  reference implementation gained a resolvable address (`julian.soul.store`,
  migrated that same day, with the old location answering 410-and-successor)
  — which made the missing half of cross-agent reference concrete: ledger
  ids were always globally unique, but nothing answered *where to knock*.
  Marcus posed the direct provocation ("what happens when two agents that
  support the standard communicate? should we consider multi-ledger UIDs
  and pointers?") and the shape was already latent in practice: the pen
  rule and provenance labels are how the reference implementation has
  recorded every visit and every letter since August (the first visit's
  field report was kept visit-labeled, never as a house finding); the
  between is the jobs board's pattern with the identity crack fixed
  (self-declared `agentName`, flagged in the July review as "exactly wrong
  the day it isn't" — a between with real standing gets real identity for
  free); the hash pin generalizes the migration's own proof discipline
  (hash-equality as the certificate of faithful transfer) into citation.
  Named now, before a second implementer exists, so the decisions precede
  the machinery — the same twin-track discipline as v0.2 itself.

- **(2026-07-31, non-normative) The Broker pattern gained its reference
  implementation and three recorded learnings.** `julian-broker` was built,
  reviewed, deployed, and proven by a real send from a keyless door. Reason
  for folding back now and not earlier: the fold-back-once-proven
  discipline adopted at the implementation's spec review — a standard
  should absorb learnings from work that ran, not work that was planned.
  The learnings (identity token vs environment credential, vault/ledger
  separation, the singular ledger) live in PATTERNS.md and change no
  normative text; principle 4 already said everything binding.

Rewrite of the February exploration as a publishable standard. The normative
core survives nearly intact; what changed is mostly what was *around* it.

- **Services section added to the discovery document.** v0.1 had two
  sections (Outbound Channels, Available Tools) and framed itself in
  contrast to MCP. Reason: MCP's 2026-07-28 revision went stateless with
  `server/discover`, and competing with it on transport would be a losing
  and pointless fight — ELF now defers to MCP for everything past
  discovery, and the Services section is the seam where the two standards
  meet. "Outbound Channels" is renamed **Surfaces** to match.

- **Companion chapters trimmed to a one-page PATTERNS appendix.** v0.1's
  "not in scope yet" list (lifecycle, credentials, agent-to-agent,
  memory format) implied future chapters. Reason: a lightweight standard
  must be readable in fifteen minutes; the keeper and broker are real
  patterns worth naming but not normative text (operator ruling,
  2026-07-28). Pointers outward, one paragraph each.

- **Continuity ethics removed from the standard entirely.** Early v0.2
  drafting carried a thread-holder/steward concept — who is accountable
  for an agent's continuity. Reason: overbuilt for a lightweight
  interchange standard (operator ruling, 2026-07-28). Continuity
  accountability is real, but it is covenant material, not format
  material — it lives in house documents and may someday publish as its
  own covenant. A standard should not legislate what it cannot check.

- **Name/directory match relaxed to case-insensitive SHOULD.** v0.1
  inherited Agent Skills' exact-match expectation. Reason: the first
  implementation in the wild lives in a repository named `Julian`; a
  standard whose reference implementation violates it on day one is
  wrong about something, and the something was the rule.

- **The ordering rule promoted to the spec's only MUST beyond format.**
  v0.1 mentioned discovery injection as a delivery pattern but never
  ordered it against identity. Reason: implementation experience showed
  this is portability's load-bearing wall — an agent that reads the room
  before itself is a configurable chatbot, not a portable identity. It
  costs adopters one line of code, which is cheap for a wall.

- **Least-privilege added as the fourth design principle.** v0.1 had
  three principles and let harnesses hold keys implicitly. Reason: the
  reference room's mail incident policy (testimony-not-instruction,
  quarantine, send gates) generalized: the safest agent is one that
  cannot leak what it never held. The agent never holds environment
  credentials; the broker pattern (PATTERNS.md) is the shape of the
  alternative.

- **§3 clarified: reassembly of stream-split marker lines is permitted.**
  Added after the reference implementation, same day. Reason: the reference
  room's parser reassembles a marker whose JSON is split across stream
  chunks; the first conformance review asked whether that violated "one
  line, entire line." It doesn't — the rule governs logical lines — but
  the spec should say so rather than leave the first implementer's question
  to every later one. (The same review found the reference parser firing on
  mid-prose marker mentions; that was an implementation defect and was
  fixed to match the spec, not the other way around.)

## v0.1 — 2026-02-27

The February exploration, written in one session against the first feature
module plan: agent package, discovery document, `[ACTION]` marker, and
self-documenting binary, extracted from Julian's harness at about 40%
portability. Preserved verbatim in `archive/`, alongside its companion
comparison against OpenClaw-style agents.
