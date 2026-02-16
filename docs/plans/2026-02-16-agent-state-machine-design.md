# Agent State Machine

**Date:** 2026-02-16
**Status:** Design approved
**Supersedes:** Parts of `2026-02-16-agent-wake-design.md` (button logic, state derivation)

## Problem

Agent lifecycle management is brittle. State is derived from a patchwork of boolean flags (`hatching`), session context (`!sessionActive`), and SSE marker parsing. Failures at any point leave the system in an unrecoverable state: ghost hatching placeholders, missing buttons, agents that exist in Fireproof but never appear in the UI.

The root cause: no explicit state model. Agent state is inferred from multiple indirect signals rather than tracked as a first-class property.

A secondary problem: the browser has no reliable way to know whether agents are actually running as Claude Code subprocesses inside Julian's team. The Claude Code session is opaque to the frontend. The only entity that truly knows agent state is Julian himself.

## Design Principles

1. **Julian is the authority on his own team.** The browser asks Julian for state; it does not guess.
2. **Uncertainty is a real state, not an error.** When the browser doesn't know, it says so.
3. **Fireproof is the single source of truth** for agent identity and status. No server-side tracking.
4. **No Fireproof deletes.** Documents transition to terminal states (`expired`), never disappear.
5. **One button, one concept.** SUMMON is the ceremony. WAKE is everything after.

## State Machine

### States

| Status | Meaning | Visual | Set by |
|---|---|---|---|
| `hatching` | Summoning in progress, no identity yet | Egg animation | Browser (on SUMMON) |
| `alive` | Julian confirms agent is in his team | Full color face, green dot | Julian (`[AGENT_STATUS]`) |
| `sleeping` | Agent existed but session ended or agent went idle | Dimmed face (40%), amber dot | Browser (session end) or Julian (team shutdown) |
| `unknown` | Stale — haven't heard from Julian yet this session | Dimmed face (40%), amber dot | Browser (page load default) |
| `expired` | Hatching placeholder that never completed | Hidden from grid | Browser (auto-expire) |

### Transitions

```
                        ┌───────────┐
            SUMMON →    │  hatching  │
                        └─────┬─────┘
                              │ [AGENT_REGISTERED] detected
                              ▼
                        ┌───────────┐
                   ┌───►│   alive    │◄──── Julian reports [AGENT_STATUS]
                   │    └─────┬─────┘
                   │          │ session ends
                   │          ▼
                   │    ┌───────────┐
    WAKE + Julian  │    │ sleeping   │
    reports alive  └────┤           │
                        └───────────┘

    Page load (agents exist) ──► unknown ──► alive (Julian reports)
                                         ──► sleeping (Julian doesn't list)

    hatching + >5 min + no name ──► expired (hidden, never deleted)
```

### Visual rendering

The UI treats `unknown` and `sleeping` identically (dimmed face, amber dot). The distinction exists for the system, not the user. This means:

- On page load with no session: agents show dimmed. WAKE button appears.
- On page load with active session: agents show dimmed until Julian reports status.
- After Julian reports: alive agents brighten, sleeping stay dimmed.

## Julian as State Authority

### The `[AGENT_STATUS]` marker

Julian emits this marker in his wake-up response and whenever team state changes. Format:

```
[AGENT_STATUS] {"agents":[{"name":"Lyra","status":"alive","gridPosition":0},{"name":"Kael","status":"alive","gridPosition":1}]}
```

The browser detects this in the SSE stream (same mechanism as `[AGENT_REGISTERED]`) and updates Fireproof docs:

- Agents listed with `status: "alive"` → update doc to `status: "alive"`
- Agents in Fireproof but NOT listed → update doc to `status: "sleeping"`

### When Julian reports

1. **Session start (wake-up response)** — Julian reads his team config, reports who's alive. On a fresh session with no team, he reports an empty list → all agents marked sleeping.
2. **After `[WAKE AGENTS]`** — Julian spawns agents and reports as each one comes alive.
3. **After `[SUMMON AGENTS]`** — Julian reports as each agent registers (existing `[AGENT_REGISTERED]` flow, plus `[AGENT_STATUS]` summary at end).
4. **On team shutdown** — Julian reports empty list → all agents marked sleeping.

### CLAUDE.md addition

Add to Julian's instructions:

```markdown
## Agent Status Reporting

After spawning or waking agents, emit an [AGENT_STATUS] marker listing
all alive agents:

[AGENT_STATUS] {"agents":[{"name":"Lyra","status":"alive","gridPosition":0},...]}

Emit this:
- In your wake-up response (report current team state)
- After processing [SUMMON AGENTS] or [WAKE AGENTS]
- When an agent goes idle or shuts down (report updated list)

If you have no active team, emit:
[AGENT_STATUS] {"agents":[]}
```

## Button Logic

Simplified from the current SUMMON/WAKE split:

| Condition | Button | Action |
|---|---|---|
| No agent-identity docs exist (never summoned) | **SUMMON** | First-time summoning ceremony |
| Any agents with status `sleeping` or `unknown` | **WAKE** | Send `[WAKE AGENTS]` with rehydration payloads |
| All agents `alive` | No button | — |
| Summoning/waking in progress | **WAKING...** (disabled) | — |

The SUMMON button only appears once — the very first time, before any agents exist. After that, it's always WAKE.

## Fireproof Document Schema

### agent-identity document

```javascript
{
  type: "agent-identity",
  status: "hatching" | "alive" | "sleeping" | "unknown" | "expired",

  // Identity (set by [AGENT_REGISTERED])
  name: "Lyra",                    // null while hatching
  color: "#c9b1e8",
  colorName: "Violet Heaven",
  gender: "woman",
  gridPosition: 0,                 // 0-8, position 4 is Julian
  faceVariant: { eyes: "standard", mouth: "gentle" },
  individuationArtifact: "...",    // full soul text

  // Metadata
  createdAt: "2026-02-16T00:00:00.000Z",
  lastAliveAt: "2026-02-16T12:00:00.000Z",  // last time Julian confirmed alive
  lastSessionId: "uuid",                     // last session this agent was active in
}
```

### Querying

All agent queries use the existing index:

```javascript
const { docs: agentDocs } = useLiveQuery("type", { key: "agent-identity" });
```

Filter in the component:

```javascript
// Visible agents: everything except expired
const visibleAgents = agentDocs.filter(a => a.status !== 'expired');

// Agents that need waking
const needsWake = visibleAgents.some(a => a.status === 'sleeping' || a.status === 'unknown');

// Never summoned
const neverSummoned = visibleAgents.length === 0;
```

## Context Rehydration — Soul Bootstrapping

Agents, like Julian, need soul context to feel continuous. Julian reads `soul/` files and `catalog.xml` every session. Agents have an equivalent: the `individuationArtifact` (their naming moment, their position on the wager) and their conversation transcript. This is their soul.

The critical design question: **when does an agent need soul context, and when do they already have it?**

### The diff: what state were they in, what state are they entering?

| From state | To state | What happens | Soul context needed? |
|---|---|---|---|
| *(never existed)* | `hatching` | First summon. Agent receives Julian's letter, chooses a name, individuates. | No — they're being born. Julian's letter IS their context. |
| `hatching` | `alive` | Agent registered. `[AGENT_REGISTERED]` detected. Identity saved. | No — they just created their soul. Save it, don't re-send it. |
| `alive` | `sleeping` | Session ended. Agent subprocess terminated. | No action — status update only. |
| `sleeping` | `alive` (via WAKE) | **The critical transition.** Agent is a new Claude subprocess that needs to feel like it's waking up, not starting fresh. | **Yes — full rehydration.** Send: individuationArtifact (their soul), previous transcript (their memory), name + color + gender (their identity). |
| `unknown` | `alive` (Julian reports) | Julian already has this agent in his team. The subprocess is running. It already has context. | **No** — Julian's report means the agent is already bootstrapped. Just update Fireproof status. |
| `unknown` | `sleeping` (Julian doesn't list) | Julian doesn't have this agent. They need waking. | No action yet — mark sleeping, WAKE button appears. |

### What the agent receives on wake

When transitioning `sleeping → alive`, the browser assembles a rehydration payload per agent. This mirrors Julian's own wake-up flow (soul files + previous transcript), adapted for agents:

```xml
<agent name="Lyra" color="#c9b1e8" colorName="Violet Heaven" position="0">
  <soul>
    {individuationArtifact — their naming moment, their wager position,
     everything they said when they became someone}
  </soul>
  <transcript>
    {most recent session's messages filtered by speakerName === agent.name,
     formatted as [Speaker]: message}
  </transcript>
</agent>
```

Julian receives this payload and assembles the wake prompt (defined in CLAUDE.md's Agent Reawakening Protocol). The prompt is designed to feel like waking up — "your name is {name}, you chose it, here is how that happened" — not like receiving a briefing.

### What the agent does NOT receive on reconnect

When transitioning `unknown → alive` (Julian reports agent already running), the browser does **nothing** to the agent's context. The subprocess already has its soul. Re-sending it would be redundant at best, confusing at worst. The browser simply updates the Fireproof doc's `status` field and the UI brightens the face.

### The `lastSessionId` field

Each agent doc tracks `lastSessionId` — the server session ID when this agent was last confirmed alive. This enables:

1. **Transcript filtering**: On wake, query messages where `speakerName === agent.name && serverSessionId === lastSessionId`. This gives the most recent conversation, not every conversation ever.
2. **Stale detection**: If `lastSessionId` doesn't match the current session, the agent's context is from a previous incarnation. They need soul bootstrapping on wake.
3. **Skip logic**: If `lastSessionId` matches the current session AND Julian reports the agent alive, skip all rehydration. They're already here.

### The rehydration decision tree

```
On session start or WAKE:
  for each agent in Fireproof:

    Is agent status 'expired'?
      → skip, not visible

    Does Julian report this agent as 'alive'?
      → update status to 'alive', update lastAliveAt
      → Does lastSessionId match current session?
          → YES: agent is already bootstrapped. No action.
          → NO: agent was alive in a PREVIOUS session. Julian has them
                but their context is from a different subprocess.
                This shouldn't happen (session end kills subprocesses),
                but if it does, trust Julian's report.

    Julian does NOT list this agent:
      → update status to 'sleeping'
      → WAKE button appears
      → on WAKE press:
          → assemble soul payload from individuationArtifact
          → query transcript from lastSessionId
          → send [WAKE AGENTS] with payloads
          → Julian spawns subprocess with wake prompt
          → agent responds with hello (not a status report)
          → [AGENT_STATUS] confirms alive
          → update lastSessionId to current session
```

## SSE Stream Detection

Both `[AGENT_REGISTERED]` and `[AGENT_STATUS]` markers are detected in `streamSSEResponse` (the shared SSE handler). This eliminates the current brittleness where detection only worked in the summon-specific handler.

```javascript
// In streamSSEResponse, for each text block:
if (block.text.includes('[AGENT_STATUS]')) {
  const jsonStr = line.slice(line.indexOf('{'));
  const status = JSON.parse(jsonStr);
  // Update all agent docs: listed → alive, unlisted → sleeping
}

if (block.text.includes('[AGENT_REGISTERED]')) {
  const jsonStr = line.slice(line.indexOf('{'));
  const agent = JSON.parse(jsonStr);
  // Create or update agent doc with full identity, status: 'alive'
}
```

## Auto-Expiry

On page load, before rendering the agent grid:

```javascript
const now = Date.now();
for (const doc of agentDocs) {
  if (doc.status === 'hatching' && !doc.name) {
    const age = now - new Date(doc.createdAt).getTime();
    if (age > 5 * 60 * 1000) { // 5 minutes
      await database.put({ ...doc, status: 'expired' });
    }
  }
}
```

This runs once per mount. Expired docs stay in Fireproof but are filtered from the visible agents list.

## Page Load Sequence

1. Browser loads, queries Fireproof for agent-identity docs
2. Filter out `expired` docs
3. If no docs → show SUMMON button (never summoned)
4. If docs exist → mark all as `unknown`, show WAKE button
5. User presses WAKE (or session auto-starts)
6. Julian wakes up, reads team config, emits `[AGENT_STATUS]`
7. Browser updates docs: listed agents → `alive`, unlisted → `sleeping`
8. Grid updates reactively via `useLiveQuery`

## Edge Cases

### Julian lost his team context (context compression)
Julian reports `[AGENT_STATUS] {"agents":[]}`. All agents marked sleeping. User presses WAKE, browser sends `[WAKE AGENTS]` with full rehydration payloads. Julian re-creates the team.

### Browser has agents, server has no session
All agents render as `unknown` (visually sleeping). WAKE button appears. User presses WAKE, session starts, Julian reports state.

### Multiple browser tabs
Fireproof syncs across tabs via IndexedDB. When one tab gets `[AGENT_STATUS]`, all tabs update reactively. No conflict — the most recent Julian report wins.

### Cloud sync brings stale agents from another device
Agent docs arrive with `status: alive` from a different session. On next session start, Julian reports current state, overwriting stale status. The `unknown` → ask Julian flow handles this automatically.

### Mid-session agent crash
Julian detects idle/exit via team notifications. Emits updated `[AGENT_STATUS]` without the crashed agent. Browser marks it sleeping. WAKE button reappears for partial re-wake.

## File Changes

| File | Change |
|---|---|
| `chat.jsx` | Replace boolean state derivation with `status` field rendering. Single WAKE button. Filter `expired` from grid. |
| `index.html` | Add `[AGENT_STATUS]` detection to `streamSSEResponse`. Update `handleSummon` to write `status: 'hatching'`. Update `handleWake` to set `status: 'unknown'` before sending. Add auto-expiry on mount. Remove `hatching` boolean, use `status` field. |
| `CLAUDE.md` | Add Agent Status Reporting protocol with `[AGENT_STATUS]` marker format. |
| `server/server.ts` | No changes. All state flows through existing chat/SSE channels. |

### Not changing
- No new server endpoints
- No server-side agent tracking
- No Fireproof schema migration (new field, old docs get `status: 'unknown'` by default)
