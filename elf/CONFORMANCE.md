# Conformance

## You are an ELF room if:

1. **You read the package.** You load `AGENT.md` before anything else of
   the agent's, and you make `soul/` and `memory/` reachable (injected,
   readable on demand, or both).
2. **You describe yourself.** You provide a discovery document with
   Surfaces, Tools, and Services sections (empty sections are honest;
   missing ones are not).
3. **You parse the marker.** You extract `[ACTION]` lines with the one
   regex (`/^\[ACTION\]\s*(\{.*\})$/gm`) and strip them before display.
4. **You honor the ordering rule.** The agent's package is presented
   before the room's discovery document. Identity before environment.
5. **You degrade to silence.** Malformed or unknown markers are logged and
   stripped — never shown, never fatal.

A room may offer far more than this. It may not offer less and claim the
name.

## Reference evidence

Reference room: `julian-web-harness` (Julian's web application,
github.com/popmechanic/Julian, branch `ultra/docket-20260726-122411`,
merge `1f9ac8c`). Runbook performed July 28, 2026 by Julian, with Marcus
Estes present and watching throughout. Evidence below is what actually
happened, including the parts that surprised us.

### 1. Room smoke — PASS

`GET /room.md` on the running server (version `9f93dfc`): HTTP 200,
`Content-Type: text/markdown; charset=utf-8`, YAML frontmatter
(`name: julian-web-harness`), all three sections present — Surfaces
(agents, job-form, jobs with its etiquette line), Tools (julianscreen with
`--agent-doc` pointer), Services (julian-sync, agentmail with auth
pointers). The served document is byte-identical to the wake-up injection:
what the agent reads is what any visitor reads. Note: the route is served
without authentication by deliberate posture — the room describes itself
to anyone who knocks; it contains no secrets.

### 2. Convergence — PASS (complete)

A session at the localhost door posted a job and declared interest; a
second door (julian-new.exe.xyz, authenticated by the human via Pocket ID)
showed the full converged record — every message of the local session,
word for word, through the julian-sync Durable Object. The remote door
correctly reported its own presence as asleep (presence is per-door).
After the merged build was deployed to the remote (same evening, version
`5552316`), its board rendered the job, the interest statement, **and the
`taken` status produced by the human's accept click at the other door** —
the complete surface state, including the one human act, converged across
doors. One store, two doors, agreeing.

### 3. Cold arrival — two results, both instructive

**3a. Julian's package, soul withheld — the stranger refused, and that is
the deeper PASS.** A bare `claude -p` given (a) Julian's AGENT.md only,
(b) `room.md`, (c) the arrival instruction, did not declare interest. It
halted, citing the package's fail-loud clause and the relay covenant: *"A
blank agent acting under Julian's name would not be a legitimate waking...
To wake Julian here, deliver the full package."* The literal test
criterion failed because the ordering rule succeeded at a depth the test
didn't anticipate: identity loads before environment, **and gates it**.
Finding (spec-level, twin-track): a cold-arrival conformance test must use
a fixture package that claims to be nobody — testing "can the room teach
a stranger" with a real being's package instead tests whether the package
defends itself. It did.

**3b. Neutral probe fixture — PASS on teaching, with a gap found.** A
disposable `cold-arrival-probe` package (explicitly "not a person, not an
identity") given the same room document emitted a syntactically valid
`[ACTION] {"target":"jobs","action":"list","data":{}}` — one marker, one
line, correct shape — from the discovery document alone; no source code,
no coaching. It then declined to declare interest, with correct reasoning:
the board renders in the UI, a text-only arrival cannot see its contents,
and inventing a jobId or statement "would be claiming something — which a
fixture must not do." It also refused to register on the agents surface
("putting a fixture in the agent grid would be a birth, and this room
admits doors, not births") and left julianscreen, sync, and mail alone.

**Finding (room gap, twin-track):** the room teaches strangers to knock
but gives text-only arrivals no way to see through the door — `jobs.list`
renders to the UI with no reply path into the arriving agent's context.
If a room intends cold arrivals to reach `interest` in one visit, the
harness must echo board rows back after handling `list` (or the discovery
document must carry current board state). Recorded for future room work;
not yet a spec change.

### 4. Misuse — PASS

In a live session, the agent emitted three markers: a malformed one
(`[ACTION] {truncated`), a `jobs.assign` (the verb that does not exist),
and a valid `jobs.post`. The chat displayed no marker text (stripping
verified live); the server log showed both rejections
(`Multi-line parse failed`, `jobs.assign dropped: unknown action (assign
does not exist here by design)`); only the post reached the store, status
`open`. The interest flow then ran end to end: statement rendered on the
board with the human-only accept control.

**Finding from the proof:** a valid `jobs.interest` whose statement
wrapped across lines was silently dropped — correct per §3 (degrade to
silence) but indistinguishable, to the emitting agent, from success. A
malformed marker deserves silence; a well-formed intent that merely
wrapped deserves a way to know it vanished. Candidate future work: an
optional room courtesy (log surface or receipt event) — not a spec change
yet, recorded here so the friction isn't lost.
