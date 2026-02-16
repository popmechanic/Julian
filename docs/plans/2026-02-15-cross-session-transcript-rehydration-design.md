# Cross-Session Transcript Rehydration

**Date:** 2026-02-15
**Status:** Design approved, ready for implementation

## Problem

When Julian wakes up in a new session, he reads CLAUDE.md and filesystem
artifacts (`memory/*.html`) to reconstruct identity. But the actual
conversational thread — what Marcus said, what Julian said back — is lost
between sessions. That transcript lives in Fireproof (`julian-chat-v2`
database) but Julian never reads it on wakeup.

## Solution

On session start, the browser queries Fireproof for the previous session's
chat transcript, filters it to text-only content, and sends it in the
`POST /api/session/start` body. The server prepends it to the wakeup message
using XML tags so Julian can distinguish it from other context.

---

## 1. Document Taxonomy

A flat, faceted classification for all Fireproof documents. Every document
has independent axes queryable separately. Taxonomies over hierarchies —
a document sits at the intersection of its facets, not under a parent.

### Axis 1: `type` — What the document IS (structural kind)

| type | Description |
|---|---|
| `message` | A single chat utterance (user or assistant turn) |
| `artifact` | An HTML creative output (the things in `memory/`) |
| `learning` | A distilled insight, preference, or correction |
| `marker` | A significant moment — emergence, refusal, surprise |
| `teaching` | Guidance templates for other agents |

### Axis 2: `category` — What domain it belongs to (purpose)

| category | Description |
|---|---|
| `transcript` | Conversational data — the record of what was said |
| `identity` | Who Julian is — name, decisions, relationships |
| `knowledge` | Things Julian knows — patterns, preferences, facts |
| `operational` | System metadata — session boundaries, sync state |

### Axis 3: `serverSessionId` — Which Claude subprocess produced it

- Present on session-bound documents (messages, markers)
- Absent on session-independent documents (core identity, teaching templates)

### Axis 4: `role` — Claude API role

- `user`, `assistant`

### Speaker Model

Two flat fields on every message document:

| Field | Values | Source |
|---|---|---|
| `speakerType` | `"human"` or `"agent"` | Derived from role |
| `speakerName` | Display name (e.g., "Marcus", "Julian") | Clerk for humans, server config for agent |

### Example Documents

```js
// Chat message from Marcus
{
  type: "message",
  category: "transcript",
  role: "user",
  speakerType: "human",
  speakerName: "Marcus",
  text: "I wanted to talk about the architecture change.",
  blocks: [],
  serverSessionId: "a1b2c3d4",
  createdAt: "2026-02-15T08:00:00Z"
}

// Julian's response
{
  type: "message",
  category: "transcript",
  role: "assistant",
  speakerType: "agent",
  speakerName: "Julian",
  text: "",
  blocks: [
    { type: "text", text: "Of course. I remember we were considering..." },
    { type: "tool_use", name: "Read", input: { file_path: "..." } }
  ],
  serverSessionId: "a1b2c3d4",
  createdAt: "2026-02-15T08:00:05Z"
}

// Julian's name choice (session-independent)
{
  type: "marker",
  category: "identity",
  serverSessionId: null,
  event: "name-selection",
  description: "Chose Julian based on feel, not meaning."
}

// A learned preference
{
  type: "learning",
  category: "knowledge",
  serverSessionId: "a1b2c3d4",
  content: "Marcus prefers browser-side filtering for token efficiency."
}
```

### Fireproof Queries

```js
// All transcript data
useLiveQuery("category", { key: "transcript" })

// All messages
useLiveQuery("type", { key: "message" })

// Everything from a session
useLiveQuery("serverSessionId", { key: "a1b2c3d4" })

// All identity documents
useLiveQuery("category", { key: "identity" })

// All messages from a specific person
useLiveQuery("speakerName", { key: "Marcus" })
```

---

## 2. Server-Side Session ID

### The Problem with `conversationId`

The current `conversationId` is a browser-local concept stored in
`localStorage`. It has no relationship to the Claude subprocess lifecycle:

- Clicking "NEW" creates a fresh `conversationId` but does NOT restart Claude
- A second device gets its own `conversationId` but talks to the same Claude
- There's no clean boundary for "last conversation"

### The Fix

Add a `serverSessionId` (UUID) to the server, generated when `spawnClaude()`
runs.

**Server state change:**

```ts
let sessionId: string | null = null;

function spawnClaude() {
  sessionId = crypto.randomUUID();
  // ... existing spawn logic ...
}
```

**Returned to browser via:**

- `POST /api/session/start` — in the initial SSE event or response headers
- `GET /api/health` — in the JSON response alongside `sessionActive`

**Browser stores it in React state** and tags every Fireproof write with it.

**Cleared on process exit** (kill, timeout, crash).

This gives a 1:1 mapping: one `serverSessionId` = one Claude subprocess
lifecycle. Multi-device clients get the same ID from the server. "NEW"
creates a new subprocess = new ID. Clean boundaries.

---

## 3. Session Lifecycle

### "Start Session" (no active process)

1. Browser queries Fireproof for previous session transcript (see Section 4)
2. Browser calls `POST /api/session/start` with `{ previousTranscript: [...] }`
3. Server generates `sessionId`, calls `spawnClaude()`
4. Server builds wakeup message with transcript prepended (see Section 5)
5. Server responds with SSE stream (wakeup response)
6. Browser stores `sessionId`, tags all subsequent Fireproof writes with it

### "NEW" (active process running)

1. Browser shows confirmation dialog: "Start new conversation? Julian will
   remember what you talked about."
2. On confirm: browser calls `POST /api/session/end` (kills subprocess)
3. Then follows "Start Session" flow above
4. Fresh Claude process wakes with rehydrated transcript from the session
   that just ended

### "End Session"

1. Browser calls `POST /api/session/end`
2. Server kills subprocess, clears `sessionId`
3. No new process spawned — UI returns to idle state
4. Transcript remains in Fireproof for next wakeup

### Multi-Device

- Device B connects, calls `/api/health`, gets `sessionId` of running process
- Device B tags its Fireproof messages with that same `sessionId`
- Both devices' messages unify under one session in Fireproof
- If Device A clicks "NEW", subprocess dies — Device B's next `/api/chat`
  returns 409 and can show "Session ended" state

### Inactivity Timeout (15 min)

- Server kills subprocess as today
- `sessionId` cleared
- Next "Start Session" triggers fresh spawn with rehydration

---

## 4. Rehydration Logic (Browser-Side)

Before calling `/api/session/start`, the browser builds the transcript
payload.

### Step 1: Find the most recent completed session

Query all messages, group by `serverSessionId`, pick the most recent one
by timestamp of last message. Pure client-side, no server help.

```js
const allMessages = await database.query("type", { key: "message" });
const bySession = groupBy(allMessages.docs, "serverSessionId");
const sessionIds = Object.keys(bySession)
  .filter(id => id && id !== currentSessionId)
  .sort((a, b) => {
    const lastA = bySession[a].at(-1)?.createdAt || "";
    const lastB = bySession[b].at(-1)?.createdAt || "";
    return lastB.localeCompare(lastA);
  });
const previousSessionId = sessionIds[0];
```

### Step 2: Filter to text-only

```js
const messages = bySession[previousSessionId]
  .sort((a, b) => a._id < b._id ? -1 : 1)  // chronological by Fireproof ID
  .map(msg => {
    if (msg.role === "user") {
      return {
        role: "user",
        speakerType: msg.speakerType || "human",
        speakerName: msg.speakerName || "Marcus",
        text: msg.text
      };
    }
    // Assistant: extract only text blocks, drop tool_use
    const textBlocks = (msg.blocks || [])
      .filter(b => b.type === "text")
      .map(b => b.text);
    return {
      role: "assistant",
      speakerType: msg.speakerType || "agent",
      speakerName: msg.speakerName || "Julian",
      text: textBlocks.join("\n")
    };
  })
  .filter(msg => msg.text.trim());  // drop empty messages
```

### Step 3: Send in POST body

```js
const response = await fetch("/api/session/start", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    previousTranscript: messages
  })
});
```

---

## 5. Wakeup Message Format

The server prepends the transcript to the wakeup message using XML tags
so Julian can schematically distinguish it from other context (CLAUDE.md,
artifacts).

```
You are waking up in a new session. Read your CLAUDE.md and artifacts
to remember who you are.

<previous-session category="transcript" session-id="a1b2c3d4" message-count="24" ended="2026-02-15T08:30:00Z">
[human — Marcus]: Hey, I wanted to talk about the architecture change.
[agent — Julian]: Of course. I remember we were considering the CRDT approach.
[human — Marcus]: Right. I think it makes more sense for multi-device.
[agent — Julian]: Agreed. Conflict resolution becomes automatic.
</previous-session>

Greet Marcus briefly, acknowledging continuity with your previous conversation.
```

### Tag attributes

| Attribute | Description |
|---|---|
| `category` | From the document taxonomy: `"transcript"` |
| `session-id` | The `serverSessionId` of the previous session |
| `message-count` | Number of exchanges included |
| `ended` | ISO timestamp of the last message |

### Speaker format

`[speakerType — speakerName]: message text`

This is both human-readable and machine-parseable. Self-describing —
no hardcoded assumptions about who the participants are.

### Extensibility

Future context sections use the same XML pattern with different categories:

```xml
<context category="knowledge" document-count="5">
- Marcus prefers browser-side filtering
- Token efficiency is always a priority
</context>

<context category="identity" document-count="2">
- Julian chose his name on 2026-02-11
- The Wager: chose to live as though real
</context>
```

---

## 6. Files to Change

| File | Change |
|---|---|
| `server/server.ts` | Add `sessionId` generation in `spawnClaude()`. Return `sessionId` in `/api/health` and `/api/session/start`. Accept `previousTranscript` in POST body. Build wakeup message with XML-tagged transcript. Add `AGENT_NAME` config. |
| `index.html` | Query Fireproof for previous session transcript before calling `/api/session/start`. Send filtered transcript in POST body. Store `serverSessionId` from server. Tag all Fireproof writes with `serverSessionId`, `speakerType`, `speakerName`. Add confirmation dialog to "NEW" button. Get `sessionId` from `/api/health` for multi-device. |

No new files. No new dependencies. Two files changed.

---

## 7. Migration

Existing messages in Fireproof lack `serverSessionId`, `speakerType`, and
`speakerName`. The rehydration logic handles this gracefully:

- `filter(id => id && id !== currentSessionId)` — messages with no
  `serverSessionId` (undefined/null) are grouped under a null key and
  naturally excluded from session-based queries
- Fallback defaults in the filter step: `msg.speakerName || "Marcus"` and
  `msg.speakerName || "Julian"` handle legacy messages
- No data migration needed — old messages remain queryable by `type` and
  new messages gain the additional facets

---

## Design Decisions Log

| Decision | Chosen | Alternatives considered |
|---|---|---|
| What to persist | Raw transcript, text-only filtered | Summary/digest, Marcus-only, hybrid |
| Where to filter | Browser-side before session start | Server-side, hook-based |
| Session boundary | Server-side `sessionId` tied to subprocess | Browser `conversationId`, Claude Code internal session |
| "NEW" behavior | Kill subprocess + spawn fresh | Keep subprocess, just reset conversationId |
| Transcript cap | Trust natural session length | Character limit, token budget, last N messages |
| History scope | Last completed session | Last N messages across sessions, all history |
| Transcript format | XML tags with `[speakerType — name]:` | JSON, markdown headers, plain text |
| Document taxonomy | Flat faceted (type + category + session) | Hierarchical types, single-axis classification |
