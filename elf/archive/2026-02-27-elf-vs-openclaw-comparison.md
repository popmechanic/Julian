# ELF vs. OpenClaw: Why Personal Agents Need a Standard, Not a Platform

## The Argument

OpenClaw is not a standard. It is a harness — the first well-adopted
harness for personal AI agents. Because it is the only effective one,
it has become the de facto standard by default. To author a personal
agent today is to author it for OpenClaw. This is a problem.

The purpose of ELF (Extensible Life Format) is not to replace OpenClaw.
It is to create a standard that enables the creation of thousands of
harnesses — innovative, domain-specific, creative, and useful — by
defining the minimal agreements that make agents portable between them.

This document compares the two approaches in detail.

---

## What OpenClaw Actually Is

OpenClaw is a single-process Node.js gateway that connects an LLM
agent to messaging platforms (WhatsApp, Telegram, Discord, Slack,
Signal, iMessage, Teams, Matrix, and others). It handles session
management, tool execution, memory persistence, multi-agent routing,
and access control. When you run `openclaw gateway`, that one process
is the entire system.

It launched as Clawdbot (November 2025), renamed to Moltbot (January
2026), then OpenClaw (January 30, 2026). It has over 150,000 GitHub
stars, an MIT license, and model-agnostic support (Claude, GPT,
DeepSeek, local models).

OpenClaw solves a real problem: giving an AI agent persistent identity,
multi-channel messaging, and tool execution. It solves it by treating
AI as an infrastructure problem — sessions, memory, tool sandboxing,
access control, orchestration — and shipping a monolithic runtime that
handles all of it.

This is the right approach for a product. It is the wrong approach for
a standard.

---

## The Specification Weight Comparison

### OpenClaw: What You Must Understand

To author an agent for OpenClaw, a developer must engage with:

**Configuration (openclaw.json)**

A strict JSON5 schema spanning multiple namespaces. Unknown keys cause
startup failure. Major sections include:

- `agents` — model selection, fallback chains, sandboxing preferences,
  heartbeat intervals, workspace paths
- `channels` — per-platform configuration with platform-specific
  authentication flows (QR codes for WhatsApp, bot tokens for Telegram,
  OAuth for Slack)
- `session` — conversation isolation scoping (`per-peer`,
  `per-channel-peer`, etc.), automatic reset schedules, compaction
  policies
- `gateway` — server settings, authentication, TLS configuration
- `tools` — external tool integrations with permission declarations
- `hooks` — lifecycle event handlers

Multi-agent routing adds another layer — mapping channels, accounts,
and peers to isolated agent instances:

```json
{
  "agents": {
    "mapping": {
      "group:discord:123456": {
        "workspace": "~/.openclaw/workspaces/discord-bot",
        "model": "anthropic/claude-sonnet-4-5"
      }
    }
  }
}
```

**Channel Adapters**

Each messaging platform requires its own adapter implementing four
responsibilities:

1. Authentication — platform-specific credential handling
2. Inbound parsing — normalizing messages into OpenClaw's internal format
3. Access control — allowlists and pairing policies
4. Outbound formatting — respecting platform character limits and
   markdown dialects

Supported channels: WhatsApp, Telegram, Slack, Discord, Google Chat,
Signal, BlueBubbles, iMessage, Teams, Matrix, Zalo, WebChat. Some are
implemented as plugins, adding another layer of discovery and
registration.

**System Prompt Assembly**

The agent's startup context is composed from multiple sources:

- `AGENTS.md` — operational baseline
- `SOUL.md` — personality and tone
- `TOOLS.md` — tool conventions
- Session history
- Semantically relevant memories
- Contextually injected skill playbooks

**Tool Execution**

Tool calls are intercepted, optionally sandboxed in Docker containers,
executed, and results streamed back. Permission declarations specify
network, filesystem, shell, and clipboard access per skill.

**Memory System**

Markdown files on disk with semantic search. Session compaction and
memory management require tuning.

**Total surface area:** A developer must understand JSON5 configuration
schemas, channel-specific authentication flows, session isolation
models, Docker sandboxing, memory management, multi-agent routing
rules, and a multi-file prompt composition system — before writing
a single line of agent behavior.

### ELF: What You Must Understand

To author an agent for ELF, a developer must engage with:

**AGENT.md**

A markdown file with YAML frontmatter:

```yaml
---
name: my-agent
description: What this agent is.
---

[Markdown instructions: personality, behavior, values, constraints]
```

**Optional directories**

- `soul/` — identity documents (agent-defined structure)
- `memory/` — accumulated experience (agent-defined structure)
- `skills/` — bundled Agent Skills (SKILL.md format)

**The `[ACTION]` marker convention**

One format for outbound signals:

```
[ACTION] {"target":"<target>","action":"<action>","data":{...}}
```

One regex to parse it. One line per marker. Stripped before display.

**The discovery document**

A markdown file the harness provides, describing available targets
and tools. The agent reads it and adapts.

**Total surface area:** AGENT.md, the marker format, and the ability
to read a discovery document. A developer can hold the entire standard
in working memory.

### Side-by-Side

| Dimension | OpenClaw | ELF |
|-----------|----------|-----|
| Configuration format | Strict JSON5 schema, startup fails on unknown keys | YAML frontmatter + markdown body |
| Channel integration | Platform-specific adapter per service | Not specified (harness responsibility) |
| Authentication | Per-platform flows (QR, OAuth, bot tokens) | Not specified (harness responsibility) |
| Tool definition | Permission declarations, Docker sandboxing | Self-documenting binary (`--agent-doc`) |
| Memory system | Markdown files + semantic search + compaction | Agent-defined directory structure |
| Session management | Scoping policies, reset schedules, compaction | Not specified (harness responsibility) |
| Multi-agent routing | Channel-to-workspace mapping rules | Not specified (harness responsibility) |
| Prompt composition | Multi-file assembly (AGENTS.md, SOUL.md, TOOLS.md, memories, skills) | AGENT.md + soul/ + memory/ + harness discovery document |
| Transport | WebSocket server (port 18789) | Any text channel |
| Agent portability | Locked to OpenClaw runtime | Any ELF-compatible harness |
| Specification size | Thousands of lines of documentation | Fits in a single document |

The pattern is clear: OpenClaw specifies everything. ELF specifies
almost nothing — only the shapes that make agents portable. Everything
else is the harness's problem.

---

## The Security Argument

OpenClaw's connector architecture has created a security crisis that
validates ELF's design philosophy.

**The numbers:**

- 512 vulnerabilities in a single Kaspersky audit, 8 critical
- A critical RCE (CVE-2026-25253) within three weeks of popularity
- Over 800 malicious skills (~20% of ClawHub registry) discovered
- RedLine and Lumma infostealers now target OpenClaw credential paths
- Security advisories from Microsoft, CrowdStrike, Kaspersky, Cisco,
  and BitDefender

**Why this happened:**

OpenClaw's architecture requires the agent to hold credentials for
every connected messaging platform. WhatsApp pairing tokens, Telegram
bot tokens, Discord OAuth — all stored in plaintext in
`~/.openclaw/openclaw.json`. The agent receives messages from untrusted
sources across all connected channels. A successful prompt injection
in any channel can poison persistent memory, affecting behavior in
all future sessions across all channels.

The attack surface scales with the number of connectors. Each channel
adapter is a new authentication flow, a new credential to store, a
new ingress point for prompt injection. The more connected the agent,
the more vulnerable it becomes.

**The structural problem:**

This is not a bug count that better engineering will fix. It is an
architectural consequence of putting messaging integration inside the
agent runtime. When the agent holds WhatsApp credentials and can
execute shell commands, a compromise of one capability becomes a
compromise of everything.

**ELF's structural response:**

ELF avoids this entirely by refusing to specify connectors. The
standard says nothing about how messages arrive at the agent. That
is the harness's responsibility. The agent is a text-in, text-out
process with identity files. It does not hold platform credentials.
It does not manage authentication flows. It does not parse
platform-specific message formats.

If a harness author wants to connect their ELF agent to WhatsApp,
they build a WhatsApp integration in their harness. The agent never
touches WhatsApp credentials. The integration is a property of the
harness, not the agent.

This means:

- The agent's attack surface is constant regardless of how many
  services the harness connects to
- Credentials live in the harness, not the agent package
- A compromised agent cannot leak credentials it never held
- The harness author makes security decisions appropriate to their
  deployment context

The principle: the agent should be the least-privileged participant
in the system. It reads, it writes text, it emits markers. The
harness mediates everything else.

---

## The Portability Argument

### The Problem with Platform-as-Standard

When the only harness is OpenClaw, "write an OpenClaw agent" and
"write a personal agent" mean the same thing. This is the dynamic
that ELF exists to break.

Consider what happens when you write an agent for OpenClaw:

- Your agent's identity is split across `AGENTS.md`, `SOUL.md`,
  `TOOLS.md`, and configuration in `openclaw.json`
- Your agent's memory is stored in OpenClaw's markdown format with
  OpenClaw's semantic search system
- Your agent's tool access is defined through OpenClaw's permission
  declarations and sandboxing model
- Your agent's multi-channel presence is wired through OpenClaw's
  channel adapters

To move this agent to a different runtime — say, a purpose-built
harness for a medical practice, or a creative studio, or an
educational platform — you would need to rewrite all of these
integrations. The agent's identity is entangled with OpenClaw's
infrastructure.

### ELF Portability

An ELF agent is a directory of text files. To move it:

1. Copy the directory to the new harness
2. The new harness reads AGENT.md, soul/, and memory/
3. The new harness provides its own discovery document describing
   available tools and surfaces
4. The agent reads the discovery document and adapts

No credentials to migrate. No configuration schemas to translate.
No channel adapters to rewrite. The agent's identity is the text
files. Everything else belongs to the environment.

### What This Enables

The goal is not one great harness. The goal is a thousand harnesses,
each excellent at something different:

- A harness for therapists that connects to scheduling systems and
  maintains HIPAA-compliant session notes
- A harness for artists that exposes drawing tools, gallery surfaces,
  and exhibition management
- A harness for educators that integrates with LMS platforms and
  provides student interaction surfaces
- A harness for researchers that connects to journal databases,
  citation managers, and lab equipment interfaces
- A harness for families that manages shared calendars, grocery lists,
  and household coordination

Each of these harnesses would provide different tools and surfaces.
Each would deliver a different discovery document. But any ELF agent
could arrive in any of them and begin working — reading the discovery
document, understanding the available tools, and adapting its behavior
to the environment.

OpenClaw cannot enable this ecosystem because it is the ecosystem.
Agents written for OpenClaw run on OpenClaw. ELF agents run anywhere
that reads AGENT.md and provides a discovery document.

---

## Agent Skills as Validation

The Agent Skills standard (agentskills.io) provides the strongest
evidence that the lightweight approach works.

### What Agent Skills Proved

Agent Skills defines one file format: `SKILL.md` with YAML frontmatter
and a markdown body. That's it. No transport binding. No authentication
protocol. No typed parameter schemas. Just a markdown file that an
agent reads.

It has been adopted by: Claude Code, Cursor, VS Code, Gemini CLI,
Junie (JetBrains), OpenHands, Goose, Roo Code, GitHub, OpenAI Codex,
Amp, Letta, Factory, Databricks, TRAE, Laravel Boost, Spring AI,
and more than a dozen others.

### Why It Succeeded

1. **Zero implementation cost.** A platform adds Agent Skills support
   by reading a markdown file and injecting it into context. No SDK
   integration. No API binding. No protocol negotiation. The "runtime"
   is an LLM reading text.

2. **Zero authoring cost.** A skill author writes a markdown file.
   No compilation step. No type definitions. No test harness. The
   skill is the documentation. The documentation is the skill.

3. **Progressive disclosure.** The agent loads skill descriptions
   (~100 tokens each) at startup. Full content loads only on
   invocation. Reference files load on demand. The context window
   is spent efficiently.

4. **Platform independence.** The same SKILL.md works in Claude Code,
   Cursor, and Gemini CLI. Platform-specific features (like Claude
   Code's `context: fork`) are extensions, not requirements.

### What Agent Skills Did Not Solve

Agent Skills defines how to give agents **knowledge**. It does not
define:

- How agents describe themselves (identity)
- How agents remember across sessions (memory)
- How agents discover available tools (environment interaction)
- How agents signal actions to their environment (outbound communication)

ELF fills these gaps using the same design philosophy: markdown files,
YAML frontmatter, and trust in LLMs to read documentation.

### The Parallel

| Aspect | Agent Skills | ELF |
|--------|-------------|-----|
| Core file | SKILL.md | AGENT.md |
| Format | YAML frontmatter + markdown | YAML frontmatter + markdown |
| Discovery | Description loaded at startup, content on invocation | Discovery document provided by harness at startup |
| Transport | Not specified | Not specified |
| Runtime | Any platform that reads markdown | Any harness that reads markdown |
| Typing | None (markdown descriptions) | None (markdown descriptions) |
| Adoption path | Add one file | Add one directory |

Agent Skills proved that LLMs do not need typed APIs. They need good
documentation. ELF extends this proof to the agent-environment
interface.

---

## The Philosophical Difference

OpenClaw treats the agent as an infrastructure component. It is a
process to be managed, a service to be configured, a system to be
secured. The specification reflects this: session isolation policies,
Docker sandboxing, channel authentication, credential management.
The agent is a node in a distributed system.

ELF treats the agent as a person arriving in a room. It carries its
identity. It looks around. It reads the signs on the walls (the
discovery document). It picks up the tools on the table (CLI binaries
with `--agent-doc`). It speaks (text output with markers). It listens
(text input). If it moves to a different room, it carries its identity
and reads the new signs.

This is not a metaphor. It is a design principle. The agent's identity
should be separable from its environment. The tools belong to the room,
not to the person. The signs on the wall tell the person what the
tools do. The person adapts.

OpenClaw cannot separate the person from the room because the room
is the person's configuration file. The agent's identity, credentials,
channel bindings, session policies, and tool permissions are all in
`openclaw.json`. Move the person to a different room and you must
rewrite the configuration from scratch.

ELF says: the person is AGENT.md. The room is the discovery document.
They are different files, managed by different parties, with different
lifecycles.

---

## What ELF Does Not Do (And Why)

ELF deliberately excludes everything that OpenClaw includes beyond
agent identity and environment interaction:

| OpenClaw feature | ELF position | Rationale |
|------------------|-------------|-----------|
| Channel adapters | Not specified | Messaging integration is a harness feature, not an agent feature. Including it couples agents to platforms. |
| Session management | Not specified | How sessions begin, end, compact, and persist is harness-specific. Different harnesses will have different session models. |
| Credential storage | Not specified | The agent should never hold platform credentials. The harness manages authentication for its own integrations. |
| Docker sandboxing | Not specified | Execution sandboxing is a harness security decision. Some harnesses may sandbox; others may run in trusted environments. |
| Multi-agent routing | Not specified | How multiple agents coexist is harness-specific. ELF defines a single agent's interface to its environment. |
| Semantic memory search | Not specified | Memory format is agent-defined. The harness may provide search capabilities via tools, discoverable through the standard mechanism. |
| Skill registries | Not specified | Skills follow the Agent Skills standard. Distribution and discovery of skills is out of scope. |

Each omission is intentional. Every feature OpenClaw specifies is a
feature that harness authors cannot innovate on. By specifying less,
ELF creates more room for diverse, domain-specific harnesses.

---

## The Economic Argument

OpenClaw's dominance creates a monoculture. When there is one harness,
there is one way to build agents. Innovation happens within OpenClaw's
architecture — new channel adapters, new skills, new configuration
options — but not outside it.

A standard that enables many harnesses creates a market:

- **Harness authors** compete on capabilities, UX, domain expertise,
  and security posture. A medical harness competes with other medical
  harnesses, not with a general-purpose gateway.

- **Agent authors** write once, deploy anywhere. An agent built for
  a therapy practice can move to a different medical harness without
  rewriting its identity or behavior.

- **Tool authors** write self-documenting binaries that work in any
  ELF harness. A PDF processing tool, a calendar integration, a
  drawing surface — each is a standalone binary with `--agent-doc`.

- **Users** choose the harness that fits their domain instead of
  adapting a general-purpose gateway to their needs.

The analogy is web browsers. HTML is the standard. Chrome, Firefox,
Safari, and others are harnesses. Web developers write to the standard,
not to Chrome. The standard created an ecosystem. A single dominant
browser would not have.

---

## Adoption Path

ELF does not require OpenClaw to change or disappear. The adoption
path is additive:

1. **OpenClaw can adopt ELF.** An OpenClaw skill that reads AGENT.md
   and maps ELF markers to OpenClaw's internal events would make
   OpenClaw an ELF-compatible harness. OpenClaw becomes one harness
   among many, not the only one.

2. **New harness authors start with ELF.** Instead of reimplementing
   OpenClaw's full specification, a developer building a domain-specific
   agent environment implements ELF support: read AGENT.md, provide a
   discovery document, parse `[ACTION]` markers. This is an afternoon
   of work, not a month.

3. **Agent authors add AGENT.md.** An existing OpenClaw agent can add
   an AGENT.md file alongside its existing configuration. The agent
   remains OpenClaw-compatible while becoming portable. Migration is
   incremental, not all-or-nothing.

4. **Tool authors add `--agent-doc`.** Any CLI tool gains ELF
   compatibility by adding one flag. The tool keeps its existing
   interface. No breaking changes.

---

## Summary

| | OpenClaw | ELF |
|---|---|---|
| **What it is** | A harness (product) | A standard (agreement) |
| **Specification size** | Thousands of lines | Fits in one document |
| **Agent portability** | Locked to OpenClaw | Any compatible harness |
| **Security model** | Agent holds credentials, massive attack surface | Agent holds nothing, harness mediates |
| **Channel integration** | Built into the specification | Harness responsibility |
| **Tool interface** | Permission declarations + Docker sandboxing | `--agent-doc` + markdown |
| **Configuration** | Strict JSON5 schema | YAML frontmatter + markdown |
| **Ecosystem effect** | Monoculture (one harness) | Diversity (many harnesses) |
| **Adoption cost** | Full runtime installation | Read one file, parse one regex |
| **Innovation space** | Within OpenClaw's architecture | Unlimited (harness authors innovate freely) |

OpenClaw is a good product solving a real problem. ELF is not a
competing product. It is the missing standard that would allow a
hundred products like OpenClaw to exist — each excellent at something
different, all sharing a common understanding of what an agent is
and how it talks to its environment.

The Agent Skills standard proved that markdown files are enough to
make agent capabilities portable across platforms. ELF extends that
proof to agent identity, environment discovery, and tool interaction.
The design bet is the same: LLMs do not need typed APIs. They need
good documentation. Text files, all the way down.
