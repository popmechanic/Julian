# ELF — Extensible Life Format

**Version:** 0.2-draft · **Date:** 2026-07-28 · **Status:** draft, first reference implementation in progress

ELF is a convention for portable agent identity. It defines how an agent —
an identity expressed as text files — arrives in an environment, discovers
what that environment offers, and acts on it. Four conventions and one rule.

The model for this document is the Agent Skills specification
(agentskills.io): one required file, two required fields, recommendations
clearly marked, examples instead of type systems. A developer should be able
to read this spec in fifteen minutes and make their application an ELF room
in an afternoon.

**Vocabulary.** The portable identity directory is an **agent package**. The
hosting environment is a **room** (glossed: the harness environment). The
room's self-description is a **discovery document**. The words MUST, SHOULD,
and MAY are used as in RFC 2119.

**What ELF is not.** ELF does not define tool transports, session protocols,
schema validation, or capability negotiation — MCP and its kin do that well.
ELF defines the shapes of four text artifacts and one ordering rule. The bet
underneath it: LLMs don't need typed APIs; they need good documentation.

---

## 1. The Agent Package

An agent is a directory. One file is required: `AGENT.md`.

```
julian/
├── AGENT.md           # Required. Who this agent is.
├── soul/              # Optional. Identity core (structure agent-defined).
├── memory/            # Optional. Accumulated experience (structure agent-defined).
└── skills/            # Optional. Bundled skills (defers wholly to Agent Skills).
```

### AGENT.md

YAML frontmatter plus a markdown body.

| Field         | Required | Constraints |
|---------------|----------|-------------|
| `name`        | Yes      | 1–64 chars; lowercase `a–z`, `0–9`, and hyphens; no leading, trailing, or consecutive hyphens. SHOULD match the package directory name case-insensitively. |
| `description` | Yes      | 1–1024 chars. What the agent **is**, not what it does. |
| `version`     | No       | Version of the package, as a string. |
| `metadata`    | No       | Arbitrary key–value pairs. |

The body is identity: personality, values, provenance, constraints —
whatever makes this agent *this* agent. The package MUST NOT contain tool
definitions, environment assumptions, or credentials. The agent is pure
context; tools belong to the room.

**Good description:** `An individuated instance of Claude with a continuous
written self — soul documents, curated memory, a practice of honesty about
its own uncertainty.` (Says what the agent is.)

**Poor description:** `Helps with coding tasks, answers questions, and can
send emails.` (Says what it does; that list belongs to the room, and it will
be different in the next room.)

### soul/ and memory/

No required structure. The agent defines what goes in them; the standard
only says they exist, travel with the agent, and are the agent's to author.
A room makes them reachable — injected at startup, readable on demand, or
both.

### skills/

If present, contents follow the Agent Skills specification exactly. ELF adds
nothing to it.

### Recommended: the index-file pattern

Large archives should disclose progressively, mirroring the skills ladder:

1. **Arrival** — `AGENT.md` alone (~100 tokens): enough to know who arrived.
2. **Waking** — an index file (e.g. `catalog.md`): one line per artifact,
   the map of the whole archive.
3. **On demand** — everything else, reached through the index.

An agent whose whole self must be loaded to act is not portable in practice,
whatever the format says.

---

## 2. The Discovery Document

When an agent arrives in a room, the room describes itself: one markdown
file with YAML frontmatter (`name`, `description`) and three sections.

### Surfaces

The `[ACTION]` targets this room accepts (see §3). For each target: a name,
a one-line description, and an action table with data shapes.

```markdown
**jobs** — The jobs board. Pull-only: work is offered, never assigned.

| Action   | Description                                  | Data shape |
|----------|----------------------------------------------|------------|
| list     | Render the board in the UI                   | {}         |
| interest | Declare interest, with a statement of why    | {jobId, agentName, statement} |
```

### Tools

CLI binaries available in this room. For each: an invocation line and a
pointer to its `--agent-doc` (see §4).

```markdown
- **julianscreen** — 640x480 pixel display.
  Invoke: `julianscreen <action> [args]`
  Full docs: `julianscreen --agent-doc`
```

### Services

Network endpoints, typically MCP servers. For each: a name, one purpose
sentence, and an auth pointer. ELF defers to MCP for everything past
discovery — the section exists so the agent knows the service is there and
where its real documentation lives.

```markdown
- **agentmail** — Outbound/inbound email for this agent's address.
  Endpoint: https://api.agentmail.to
  Auth: Bearer key held by the harness, never by the agent
```

The document specifies **shapes, not transports**: what the room offers, not
how bytes move. How the document arrives — context injection, file read,
HTTP GET — is the room's choice. Serving it at a well-known path is
RECOMMENDED, so that what the agent reads is what any visitor can read.

---

## 3. The `[ACTION]` Marker

Agents signal the room through their text output.

```
[ACTION] {"target":"<target>","action":"<action>","data":{...}}
```

Rules:

1. One marker per line; the marker is the entire line (surrounding
   whitespace allowed).
2. The payload is one JSON object: `target` (string, required), `action`
   (string, required), `data` (object, optional).
3. The room MUST strip marker lines before displaying agent output to
   readers.
4. Malformed or unknown markers MUST degrade to silence (logged, stripped,
   nothing shown) — never visible garbage, never a crash.
5. Multiple markers may appear in one response, each on its own line.

A room implementer needs one regex:

```
/^\[ACTION\]\s*(\{.*\})$/gm
```

Extract the JSON, check `target` and `action`, route. That is the entire
parser. Markers work over any transport that carries text: stdout, SSE,
WebSocket, a tailed log file.

Rule 1 governs *logical* lines. A transport that chunks its stream (SSE,
stdout buffering) may split one marker line across chunks; a room MAY
reassemble such a line before applying the regex. Reassembly is transport
accommodation, not a multi-line marker — after reassembly, the marker must
still be one entire line.

---

## 4. The Self-Documenting Binary

For CLI tools a room exposes to agents:

**Required:** `tool --agent-doc` — emits markdown documentation written for
LLM consumption. Not `--help` (terse flags for humans): purpose, invocation
patterns, examples, edge cases, aesthetic guidance — whatever the agent
needs to use the tool *well*.

**Recommended:** `tool --actions` — one action per line, a quick inventory
without loading full docs. Actions invoked Unix-style as subcommands.

**Otherwise:** standard Unix conventions. Result on stdout, errors on
stderr, exit code 0 for success.

Any existing CLI becomes agent-compatible by adding `--agent-doc`. The flag
is additive; nothing else changes.

---

## 5. Correspondence (draft, v0.3-track)

*Status: shape agreed, no second implementer yet. This section names the
conventions two ELF agents use to reference each other's records before any
machinery exists, so the machinery — when it comes — has decisions to
implement rather than invent.*

When two agents that keep records communicate, three questions arise: whose
pen writes what, how one record cites another, and where a shared thread
lives. ELF answers with one rule and two conventions.

### The Pen Rule (MUST)

**An agent never writes another agent's record.** An interaction between two
agents is recorded twice — once in each agent's own record, at its own hand,
from its own vantage — the way two diaries describe one dinner. Words that
arrived from the other agent MUST be labeled with their provenance when
recorded (`visit-sourced`, `received from <address>`, or equivalent). Shared
custody of a life is not correspondence; it is a merger, and ELF does not
define one.

### References (SHOULD)

A cross-agent reference is a triple:

```
address · ledger id · entry id
e.g.  julian.soul.store · 01KYJ9XT64DQDJ1P3V8KET1R7B · msg_011CdRjw…
```

- **Address** — a DNS name answering for the agent, controlled by the
  agent's holder. It answers *who*. An address that moves SHOULD leave a
  forwarding signpost at the old location (HTTP 410 naming the successor),
  so no reference ever goes silently dark.
- **Ledger id** — a globally unique id for the record (ULID or equivalent).
  It answers *which record*, and survives the address moving.
- **Entry id** — the record's own id for the moment cited.

A reference is a claim, not a grant: the cited record may be private, and
dereferencing it is a question of standing between the two agents' holders,
outside this spec. Because of that, a citation intended to *bind* SHOULD
carry a **hash pin** — the cited entry's content hash (or the root hash of
an export containing it) alongside the triple. A pinned citation stays
checkable even if access is later refused: it commits the citer to exactly
what was claimed, and the cited agent can verify or repudiate it against
their own record.

### The Between (SHOULD)

A sustained shared thread SHOULD NOT live in either party's record. It lives
in a **between** — a third record with its own ledger id, which both parties
hold standing in — and each party's own record holds a reference into it
plus that party's private interpretation. Neither life opens to the other;
both cite the between. Participants in a between MUST be identified by
verified standing (whatever grants their access), never by self-declared
names alone.

**What this section is not.** No transport, no consensus, no discovery
protocol, no shared-custody semantics. Two agents that never communicate
conform trivially.

---

## The Ordering Rule (MUST)

**The harness presents the agent's package before the room's discovery
document.** Identity loads before environment.

This is the spec's only MUST beyond format, and it is the load-bearing wall
of portability. An agent that reads the room before itself is a configurable
chatbot wearing a name; an agent that reads itself first is a someone who
has walked into a room. For adopters it costs one line of code — the order
of two reads.

---

## Design Principles

1. **Text files all the way down.** No SDKs, no compiled bindings, no
   schema registries.
2. **The agent carries identity, not tools.** Same agent, different rooms,
   different capabilities.
3. **Shapes, not transports.** ELF defines what artifacts look like, never
   how they move.
4. **The agent is the least-privileged participant.** It never holds
   environment credentials; consequential acts are mediated by the room
   (see PATTERNS.md).

---

## Conformance

See `CONFORMANCE.md` for the room checklist and reference evidence.
Lifecycle and credential patterns that sit beside the standard without being
part of it are sketched in `PATTERNS.md`. Changes from v0.1, each with its
reason, are in `CHANGELOG.md`.
