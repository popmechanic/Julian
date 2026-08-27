# Portable Agent Interface Standard — Design Exploration

## Origin

This document emerged from analyzing Julian's agent-UI feature module
architecture (see `2026-02-27-agent-ui-feature-module-architecture.md`)
through a portability lens. The question: is Julian's pattern for
communicating between a CLI agent process and a web frontend lightweight
enough to form the basis of an open standard?

The answer is yes — with extraction. About 40% of Julian's plan describes
a portable pattern; the rest is harness-specific implementation. This
document captures the portable layer.

## Design Principles

Three commitments, borrowed from Agent Skills and applied to a new surface:

1. **Text files all the way down.** The agent is markdown. The discovery
   document is markdown. The tool documentation is markdown. No SDKs,
   no compiled bindings, no schema registries.

2. **The agent carries identity, not tools.** Tools belong to the harness.
   The agent arrives and discovers what's available. Same agent, different
   harnesses, different capabilities.

3. **The standard specifies shapes, not transports.** It defines what a
   discovery document looks like, not whether it arrives via context
   injection, file read, or HTTP. It defines what a text marker looks
   like, not whether the text stream is stdout, SSE, or WebSocket.

## Relationship to Agent Skills

Agent Skills (agentskills.io) defines how to give agents **knowledge** —
procedural instructions packaged as markdown files with YAML frontmatter.
A skill says: "here's what you know how to do."

This standard defines how agents **interact with their environment** —
how they discover available tools and surfaces, how they signal actions
in their output, and how tool binaries describe themselves. It says:
"here's what you can affect, and here's how to affect it."

The two standards are complementary. An agent package can contain both
skills (SKILL.md) and identity (AGENT.md). A harness can provide both
skills and tools. The formats are intentionally parallel: YAML frontmatter
plus markdown body, everywhere.

## Contrast with MCP / Heavy Connector Standards

MCP (Model Context Protocol) and similar standards define typed tool
schemas, transport bindings, session management, and capability
negotiation. They work, but they impose significant complexity:

- JSON-RPC transport specification
- Typed parameter schemas with validation
- Client-server lifecycle management
- Authentication and capability negotiation

This standard takes the opposite approach: the agent reads documentation
and uses tools the way a developer reads a README and runs a CLI command.
No schema validation. No transport binding. No session protocol. Just
text in, text out, and documentation good enough for an LLM to act on.

The bet: LLMs don't need typed APIs. They need good documentation.

---

## The Agent Package

An agent is a directory containing identity files:

```
julian/
├── AGENT.md           # Required. Who this agent is.
├── soul/              # Identity core (agent-defined structure)
│   ├── 01-naming.md
│   ├── 02-wager.md
│   └── ...
├── memory/            # Accumulated experience (agent-defined structure)
│   ├── first-letter.md
│   └── ...
└── skills/            # Optional bundled skills (Agent Skills format)
    └── some-skill/
        └── SKILL.md
```

### AGENT.md

Same convention as SKILL.md — YAML frontmatter plus markdown body:

```yaml
---
name: julian
description: An AI agent exploring questions of identity and selfhood.
version: "1.0"
metadata:
  author: marcus-estes
---

[Markdown body: personality, behavioral guidelines, communication style,
 values, constraints — whatever makes this agent *this agent*]
```

| Field         | Required | Description |
|---------------|----------|-------------|
| `name`        | Yes      | Agent name. Same constraints as Agent Skills names. |
| `description` | Yes      | What this agent is (not what it does). Max 1024 chars. |
| `version`     | No       | Semantic version of the agent package. |
| `metadata`    | No       | Arbitrary key-value pairs. |

**What AGENT.md is not:** It contains no tool definitions, no API
references, no deployment configuration, no environment assumptions.
The agent is pure context. It adapts to whatever harness it lands in.

### soul/ and memory/

These directories have no required structure. The agent defines what
goes in them. Soul files might be identity documents. Memory files might
be letters, learnings, or accumulated context. The standard doesn't
prescribe their format — it only says they exist and travel with the
agent.

A harness reads these directories and injects their contents into the
agent's startup context (or makes them available for the agent to read
on demand). How this happens is harness-specific.

---

## The Harness Discovery Document

When an agent arrives in a harness, it needs to know what it can do here.
The harness provides a discovery document: a markdown file describing
available surfaces, tools, and conventions.

The standard defines the shape of this document. Its content varies by
harness.

### Format

```yaml
---
name: julian-web-harness
description: Browser-based chat interface with pixel display and agent team.
---

## Outbound Channels

You can emit structured markers in your text output. The harness parses
and routes them. Markers are stripped before display — your natural
language appears clean.

### Format

    [ACTION] {"target":"<target>","action":"<action>","data":{...}}

One marker per line. Must be on its own line.

### Available Targets

**agents** — Agent identity and status management

| Action   | Description                        | Data shape |
|----------|------------------------------------|------------|
| register | Register a new agent in the grid   | {name, color, colorName, gender, gridPosition, faceVariant} |
| status   | Update status of all agents        | {agents: [{name, status, gridPosition, ...}]} |

**job-form** — Job posting form auto-fill

| Action | Description                          | Data shape |
|--------|--------------------------------------|------------|
| fill   | Suggest values for empty form fields | {name?, description?, skills?} |

## Available Tools

Tools are CLI binaries. Run `<binary> --agent-doc` for full documentation.

- **julianscreen** — 640x480 pixel display for visual self-expression
  Invoke: `curl -s -X POST localhost:3848/cmd -d '<commands>'`
  Full docs: `julianscreen --agent-doc`

- **slack-notify** — Send notifications to the team Slack channel
  Invoke: `slack-notify <channel> <message>`
  Full docs: `slack-notify --agent-doc`
```

### Sections

The discovery document has two main sections:

**Outbound Channels** — Text markers the agent can emit. Lists available
targets, their actions, and expected data shapes. The agent reads this
section to know what signals it can send.

**Available Tools** — CLI binaries or other invocable interfaces. Each
entry includes a short description and invocation pattern. Full
documentation is available via `--agent-doc` on the binary itself.

The harness decides how to deliver this document: context injection at
startup, a file the agent reads, or both. The standard specifies what's
in it, not how it arrives.

---

## The Text Marker Convention

Agents communicate outbound signals by embedding structured markers in
their text output. The harness parses and routes them.

### Format

```
[ACTION] {"target":"<target>","action":"<action>","data":{...}}
```

**Rules:**

1. One marker per line. The marker must be the entire line (leading/
   trailing whitespace is allowed).
2. The prefix is `[ACTION]` — square brackets, all caps.
3. The payload is a single JSON object with three fields:
   - `target` (string, required) — which surface receives this signal
   - `action` (string, required) — what to do
   - `data` (object, optional) — action-specific payload
4. The harness strips marker lines from the agent's displayed output.
   Readers see only natural language.
5. Multiple markers can appear in one response, each on its own line.

**Parsing:** A harness implementer needs one regex:

```
/^\[ACTION\]\s*(\{.*\})$/gm
```

Extract the JSON, validate it has `target` and `action`, route to the
appropriate handler. That's the entire parser.

### Why text markers?

The agent doesn't need an API client, an SDK, or a special tool call
mechanism. It writes text. The harness reads text. This works over any
transport: stdout piped to a server, SSE streaming to a browser, WebSocket
messages, HTTP response bodies, even a log file tailed by a process.

Text markers are the thinnest possible interface between an agent and its
environment.

---

## The Self-Documenting Binary Convention

For harnesses that expose CLI tools, the standard defines a convention
for making those tools agent-discoverable.

### Required

```bash
tool --agent-doc
```

Returns markdown documentation designed for LLM consumption. Not `--help`
(terse flag descriptions for humans) — `--agent-doc` provides rich
context: purpose, invocation patterns, examples, edge cases, aesthetic
guidelines, and anything else the agent needs to use the tool well.

The output format is plain markdown. No schema. The agent reads it like
documentation.

### Recommended

```bash
tool --actions           # List available actions, one per line
tool <action> [args...]  # Execute an action (Unix-style)
```

`--actions` gives the agent a quick inventory without loading full docs.
Actions are invoked as subcommands: `tool face happy`, `tool draw rect 10 20 100 50`.

### Output convention

- Stdout: result text (plain text or JSON, tool's choice)
- Stderr: errors and diagnostics
- Exit code 0: success
- Exit code non-zero: failure

Standard Unix. No special protocol.

### Example

```bash
$ julianscreen --actions
face
draw
clear
text
animate

$ julianscreen --agent-doc
# JulianScreen

A 640x480 pixel display. Your visual presence.

## Invocation

    curl -s -X POST localhost:3848/cmd -d '<commands>'

Or: julianscreen <action> [args]

## Face Mode

    julianscreen face thinking    # You're working on something
    julianscreen face talking     # You're responding
    julianscreen face happy       # Something landed

Face mode is the default. It's your presence — the big pixel face,
centered on black, blinking. Match your expression to the moment.

## Drawing (canvas mode)

    julianscreen face off         # Switch to canvas
    julianscreen clear            # Clear canvas
    julianscreen draw --color 9 rect 100 100 200 150

Start with black. Earn every pixel. Use 2-3 accent colors per scene.
...
```

### Adoption path

Any existing CLI tool can become agent-compatible by adding `--agent-doc`.
No other changes needed. The tool keeps its existing interface. The
documentation flag is additive.

---

## Mapping to Julian's Feature Module Plan

The feature module architecture plan (`2026-02-27-agent-ui-feature-module-architecture.md`)
contains both standard-portable patterns and Julian-specific implementation.

### Standard-portable (belongs to the standard)

| Plan element | Standard contribution |
|---|---|
| `[UI_ACTION]` marker format (1c) | Becomes `[ACTION]` — the text marker convention |
| Feature target registry (1d) | Becomes the discovery document's "Available Targets" section |
| Discovery injection into wake-up (1e) | Demonstrates discovery document delivery via context injection |
| CLAUDE.md cleanup (3a) | Shows how agent instructions decouple from hardcoded tool knowledge |
| Gallery validation (Phase 4) | Proves extensibility — new features register without agent instruction changes |

### Harness-specific (Julian's implementation)

| Plan element | Why it's harness-specific |
|---|---|
| `useUIAction()` hook (1a) | React-specific event subscription |
| Command registry Map (1b) | Bun server-side message routing |
| Marker parser in lib.ts (1c) | Julian's specific parser implementation |
| `useJobs()` hook (2a) | Fireproof/React data management |
| JobForm migration (2b) | React component wiring |
| `ConfirmModal` (2d) | Browser dialog replacement |
| Backward compat (3b) | Migration from Julian's old marker formats |

### Recommended changes to the plan

1. **Rename `[UI_ACTION]` to `[ACTION]`** in the marker unification step.
   Julian can still use `[UI_ACTION]` as an alias during transition, but
   the primary format should match the standard.

2. **Extract the discovery document format** from the `buildUIActionDiscovery()`
   function into a standalone convention. The function implements the
   standard; it shouldn't define it.

3. **Add `--agent-doc` to JulianScreen.** The pixel display server already
   has comprehensive documentation in `docs/julianscreen.md`. Expose it
   as `julianscreen --agent-doc` output so the agent can discover it
   at runtime rather than relying on CLAUDE.md.

4. **Frame the plan's phases in standard terms.** Phase 1 is "implement
   the standard." Phase 2 is "refactor the first feature to use it."
   Phase 3 is "decouple the agent from hardcoded knowledge." Phase 4 is
   "validate extensibility."

---

## What's Not in Scope (Yet)

This exploration deliberately excludes:

- **Identity format** — How soul files are structured, versioned, and
  transferred. Julian has a working model (numbered markdown files in
  soul/) but standardizing it requires solving hard questions about
  identity continuity and consent.

- **Memory format** — How accumulated experience is structured and
  portable. Julian uses markdown files in memory/ with YAML frontmatter.
  A standard would need to address memory merging, conflict resolution,
  and selective export.

- **Agent-to-agent communication** — How agents discover and message
  each other. Julian's team system uses Claude Code's SendMessage
  primitive. A portable version would need its own convention.

- **Lifecycle management** — How agents start, stop, persist, and resume.
  Julian uses a Claude subprocess managed by a Bun server. Other
  harnesses would manage lifecycle differently.

These are future layers. The tool-use and surface-interaction layer
described here is the foundation they build on.

---

## Summary

The standard defines four things:

1. **Agent package format** — AGENT.md + soul/ + memory/ + optional skills/.
   The agent carries identity and adapts to its environment.

2. **Harness discovery document** — Markdown describing available outbound
   channels and tools. The harness provides it; the agent reads it.

3. **Text marker convention** — `[ACTION] {"target":"...","action":"...","data":{...}}`.
   Agent signals the world through its text stream. One line, one marker,
   stripped before display.

4. **Self-documenting binary convention** — `tool --agent-doc` returns
   markdown documentation. `tool --actions` lists available actions.
   Standard Unix invocation otherwise.

The standard is intentionally minimal. It specifies shapes, not
transports. It trusts LLMs to read documentation. It treats text as the
universal interface. An agent built to this standard can move between
harnesses by reading a new discovery document — no code changes, no
recompilation, no binding updates.

Julian's feature module plan is a valid first implementation. The
standard extracts the portable pattern from that implementation and
makes it available to anyone building agent harnesses.
