# Event Log Architecture & Server Event Types

**Date:** 2026-02-17
**Status:** Design approved
**Related:** `2026-02-16-agent-wake-design.md`, `2026-02-15-cross-session-transcript-rehydration-design.md`

## Problem

The current server fuses three concerns into one SSE stream: writing to Claude's stdin, reading Claude's stdout, and delivering events to the browser. This coupling means browser disconnects orphan server-side locks, refreshes lose in-flight data, and multiple tabs are impossible. The agent state machine (hatching, alive, sleeping) breaks when any link in this chain fails.

## Solution

Replace the per-request SSE model with an **append-only event log**. One background loop reads Claude's stdout into the log. Browser clients subscribe to the log independently with resumable cursors. Sending messages to Claude is a fire-and-forget POST. The turn lock disappears entirely.

The server parses Julian's structured markers (`[AGENT_REGISTERED]`, `[AGENT_STATUS]`, etc.) out of Claude's raw output **before** appending to the log. The browser receives typed events, never raw text to parse.

### Restart behavior

The event log is in-memory and does not survive server restarts. On restart, the server emits a `session_end` + `session_start` pair. The browser detects this and resets its UI state. Fireproof-persisted events (transcripts, agent identities, artifacts) survive independently — the log is for real-time streaming, not durable storage.

---

## Event Type Catalog

Every event in the log has a common envelope:

```typescript
interface ServerEvent {
  id: number;              // monotonic, used as cursor for resumption
  ts: number;              // Date.now() when appended
  sessionId: string | null; // Claude subprocess session ID
  type: string;            // discriminant — see below
}
```

### Category 1: Session Lifecycle

Events the **server** generates about the Claude subprocess.

```typescript
// Claude subprocess spawned successfully
interface SessionStartEvent extends ServerEvent {
  type: "session_start";
  pid: number;             // Claude process PID
  model: string;           // e.g. "claude-opus-4-6"
  demoMode: boolean;       // FORCE_DEMO_MODE env var
}

// Claude subprocess exited (clean or crash)
interface SessionEndEvent extends ServerEvent {
  type: "session_end";
  exitCode: number | null;
  reason: "user_ended" | "inactivity_timeout" | "process_crash" | "server_shutdown";
}

// Anthropic OAuth token state changed
interface AuthStateEvent extends ServerEvent {
  type: "auth_state";
  authMethod: "oauth" | "setup_token" | "none";
  needsSetup: boolean;
  expiresInMinutes: number | null;
}
```

### Category 2: Claude Output — Raw

Events parsed from Claude's **stdout stream-json** output. The server's background reader loop categorizes each line and appends typed events.

```typescript
// Claude system initialization (emitted once per subprocess)
interface ClaudeSystemEvent extends ServerEvent {
  type: "claude_system";
  claudeSessionId: string; // Claude Code's internal session ID
  availableTools: string[];
}

// Claude's text response (accumulated, not streaming deltas)
interface ClaudeTextEvent extends ServerEvent {
  type: "claude_text";
  messageId: string;       // Claude message ID (msg_...)
  content: Array<{
    type: "text";
    text: string;
  } | {
    type: "tool_use";
    id: string;            // tool use ID (toolu_...)
    name: string;          // Read, Write, Edit, Bash, Glob, Grep, etc.
    input: Record<string, any>;
  } | {
    type: "thinking";
    thinking: string;
  }>;
}

// Tool result returned to Claude
interface ClaudeToolResultEvent extends ServerEvent {
  type: "claude_tool_result";
  toolUseId: string;       // matches tool_use.id
  toolName: string;        // which tool produced this
  content: string;         // tool output (truncated if very large)
  isError: boolean;
}

// Claude turn completed — final result with stats
interface ClaudeResultEvent extends ServerEvent {
  type: "claude_result";
  subtype: "success" | "error" | "timeout";
  numTurns: number;
  costUsd: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  resultText: string;      // final text summary
}

// Context was compacted (conversation history compressed)
interface ClaudeCompactEvent extends ServerEvent {
  type: "claude_compact";
}
```

### Category 3: User Input

Events generated when the **browser sends a message** via `POST /api/send`.

```typescript
// User (human) sent a chat message
interface UserMessageEvent extends ServerEvent {
  type: "user_message";
  text: string;
  speakerName: string;     // from Clerk user profile
  targetAgent: string | null; // if routed via [ROUTE TO AGENT: name]
}

// User triggered agent summon
interface UserSummonEvent extends ServerEvent {
  type: "user_summon";
}

// User triggered agent wake
interface UserWakeEvent extends ServerEvent {
  type: "user_wake";
  agentPayloads: Array<{
    name: string;
    color: string;
    colorName: string;
    gridPosition: number;
    hasSoul: boolean;      // has individuationArtifact
    hasTranscript: boolean; // has previous session messages
  }>;
}

// User triggered session start
interface UserSessionStartEvent extends ServerEvent {
  type: "user_session_start";
  demoMode: boolean;
  hasPreviousTranscript: boolean;
  hasArtifactCatalog: boolean;
}

// User triggered session end
interface UserSessionEndEvent extends ServerEvent {
  type: "user_session_end";
}
```

### Category 4: Agent Lifecycle — Parsed Markers

Events the **server parses from Julian's text output** before appending to the log. The browser never sees raw `[AGENT_REGISTERED]` text — it gets these typed events.

```typescript
// Julian registered a new agent (parsed from [AGENT_REGISTERED] marker)
interface AgentRegisteredEvent extends ServerEvent {
  type: "agent_registered";
  agent: {
    name: string;
    color: string;
    colorName: string;
    gender: "man" | "woman";
    gridPosition: number;  // 0-8 (4 is Julian)
    faceVariant: {
      eyes: string;
      mouth: string;
    };
    individuationArtifact: string; // agent's soul text
    createdAt: string;     // ISO timestamp
  };
}

// Julian reported team status (parsed from [AGENT_STATUS] marker)
interface AgentStatusEvent extends ServerEvent {
  type: "agent_status";
  agents: Array<{
    name: string;
    status: "alive" | "idle" | "shutdown";
    gridPosition: number;
  }>;
}

// Julian offered work to an agent (parsed from response to [OFFER WORK])
interface AgentWorkOfferedEvent extends ServerEvent {
  type: "agent_work_offered";
  agentName: string;
  jobNames: string[];
}

// Julian relayed a message from a specific agent
interface AgentMessageEvent extends ServerEvent {
  type: "agent_message";
  agentName: string;       // which agent is speaking
  content: Array<{
    type: "text";
    text: string;
  }>;
}
```

### Category 5: Artifact Lifecycle

Events detected from **Write tool calls** targeting the `memory/` directory.

```typescript
// Julian wrote or updated an artifact file
interface ArtifactWrittenEvent extends ServerEvent {
  type: "artifact_written";
  filename: string;        // e.g. "shared/readme.html", "celebration.html"
  path: string;            // full path within memory/
  isNew: boolean;          // file didn't exist before
  sizeBytes: number;
  // Metadata extracted from <meta> tags if present
  meta: {
    description?: string;  // artifact-description
    category?: string;     // artifact-category
    chapter?: string;      // artifact-chapter
  } | null;
}
```

### Category 6: JulianScreen

Events detected from **Bash tool calls** targeting the pixel display.

```typescript
// Julian sent a command to JulianScreen
interface ScreenCommandEvent extends ServerEvent {
  type: "screen_command";
  command: string;         // raw command text (e.g. "FACE happy", "BG night")
  expression?: string;     // extracted face expression if FACE command
}
```

### Category 7: Job System

Events parsed from Julian's responses to job-related messages.

```typescript
// Julian provided job help suggestions
interface JobHelpEvent extends ServerEvent {
  type: "job_help";
  suggestions: Record<string, any>; // structured suggestions JSON
}
```

### Category 8: Server Health

Events the server generates about its own state.

```typescript
// Periodic heartbeat (for SSE keepalive and client liveness)
interface HeartbeatEvent extends ServerEvent {
  type: "heartbeat";
}

// Server-side error (auth failure, process error, etc.)
interface ServerErrorEvent extends ServerEvent {
  type: "server_error";
  message: string;
  code: "auth_failed" | "session_conflict" | "setup_required"
       | "stdin_write_failed" | "process_exited" | "turn_timeout"
       | "inactivity_timeout" | "unknown";
}
```

---

## Complete Union Type

```typescript
type ServerEvent =
  // Session lifecycle
  | SessionStartEvent
  | SessionEndEvent
  | AuthStateEvent
  // Claude output
  | ClaudeSystemEvent
  | ClaudeTextEvent
  | ClaudeToolResultEvent
  | ClaudeResultEvent
  | ClaudeCompactEvent
  // User input
  | UserMessageEvent
  | UserSummonEvent
  | UserWakeEvent
  | UserSessionStartEvent
  | UserSessionEndEvent
  // Agent lifecycle
  | AgentRegisteredEvent
  | AgentStatusEvent
  | AgentWorkOfferedEvent
  | AgentMessageEvent
  // Artifacts
  | ArtifactWrittenEvent
  // JulianScreen
  | ScreenCommandEvent
  // Jobs
  | JobHelpEvent
  // Server health
  | HeartbeatEvent
  | ServerErrorEvent;
```

**22 event types** across 8 categories.

---

## Server-Side Marker Parsing

The key architectural shift: the server's stdout reader loop parses Julian's markers **before** appending to the event log. This moves brittle text parsing from the browser to a single, reliable location.

### Parsing rules (in the stdout reader loop)

For each `assistant` message from Claude's stdout:

1. **Scan text blocks for markers.** For each text content block, check for known prefixes.

2. **`[AGENT_REGISTERED]`** → Parse JSON after the marker. Emit `AgentRegisteredEvent`. Also emit the original `ClaudeTextEvent` (the browser may want to display the surrounding text).

3. **`[AGENT_STATUS]`** → Parse JSON after the marker. Emit `AgentStatusEvent`. Strip the marker line from the text event (status reports are system data, not conversation).

4. **Write tool targeting `memory/`** → When a `tool_use` block has `name === "Write"` and `input.file_path` starts with the memory directory, emit `ArtifactWrittenEvent` after the tool result confirms success.

5. **Bash tool targeting JulianScreen** → When a `tool_use` block has `name === "Bash"` and `input.command` contains `localhost:3848/cmd`, emit `ScreenCommandEvent` with the extracted command body.

6. **Agent message detection** → When text contains `[ROUTE TO AGENT: name]` pattern in the original user message, tag the subsequent assistant response as `AgentMessageEvent` with the `agentName`.

### What the browser does NOT parse

- No `[AGENT_REGISTERED]` detection in `streamSSEResponse`
- No `[AGENT_STATUS]` detection in the frontend
- No Write tool detection for artifacts
- No raw SSE line splitting

The browser subscribes to typed events and updates UI/Fireproof accordingly.

---

## Event Log Implementation

### In-memory ring buffer

```typescript
const MAX_EVENTS = 2000;
const events: ServerEvent[] = [];
let nextId = 0;
const subscribers = new Set<(event: ServerEvent) => void>();

function append(event: Omit<ServerEvent, 'id' | 'ts'>): ServerEvent {
  const full: ServerEvent = {
    ...event,
    id: nextId++,
    ts: Date.now(),
  };
  events.push(full);
  if (events.length > MAX_EVENTS) events.shift();
  for (const notify of subscribers) notify(full);
  return full;
}
```

### Browser subscription endpoint

```
GET /api/events?after=N
```

Returns an SSE stream. Uses the native `EventSource` spec:
- `id:` field set to `event.id` — enables `Last-Event-ID` on reconnect
- Browser reconnects automatically with cursor position
- Multiple tabs subscribe independently

```typescript
// Server
app.get('/api/events', (req) => {
  const after = parseInt(req.query.after ?? req.headers['last-event-id'] ?? '-1');
  return new ReadableStream({
    start(controller) {
      // Replay buffered events
      for (const e of events.filter(e => e.id > after)) {
        controller.enqueue(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      // Subscribe to new events
      const notify = (e: ServerEvent) => {
        controller.enqueue(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      subscribers.add(notify);
      // Cleanup on disconnect (no lock, no orphan)
      req.signal.addEventListener('abort', () => subscribers.delete(notify));
    }
  });
});
```

### Send endpoint

```
POST /api/send
{ "message": "hello", "targetAgent": "Lyra" }
→ 202 Accepted { "eventId": 42 }
```

Writes to Claude's stdin, appends `UserMessageEvent` to log, returns immediately. Response arrives through the event stream.

---

## Mapping to Fireproof Document Taxonomy

Events that should be persisted to Fireproof map to the existing taxonomy:

| Event Type | Fireproof `type` | Fireproof `category` | Notes |
|---|---|---|---|
| `user_message` | `message` | `transcript` | `role: "user"`, `speakerType: "human"` |
| `claude_text` | `message` | `transcript` | `role: "assistant"`, `speakerType: "agent"` |
| `agent_message` | `message` | `transcript` | `role: "assistant"`, `speakerName: agentName` |
| `agent_registered` | `agent-identity` | `identity` | Creates/updates agent doc |
| `agent_status` | `agent-identity` | `identity` | Updates `status` field on existing docs |
| `artifact_written` | `artifact` | `knowledge` | Updates artifact catalog |
| `session_start` | `marker` | `operational` | Session boundary marker |
| `session_end` | `marker` | `operational` | Session boundary marker |

Events NOT persisted (ephemeral): `heartbeat`, `server_error`, `claude_tool_result`, `claude_system`, `claude_compact`, `screen_command`, `auth_state`.

---

## Impact on Agent State Machine

With the event log, the agent state machine simplifies:

1. **No missed markers.** `AgentRegisteredEvent` is in the log. Browser reconnects and replays it.
2. **No ghost placeholders.** Browser creates hatching UI state (React only, not Fireproof) on `UserSummonEvent`. Fireproof doc only created on `AgentRegisteredEvent`.
3. **`unknown` state is brief.** On reconnect, browser replays the log from its cursor — the most recent `AgentStatusEvent` tells it who's alive.
4. **Session boundaries are explicit.** `SessionEndEvent` triggers `alive → sleeping` for all agents. No inference from health polling.
5. **Multiple tabs work.** Each tab subscribes independently. One tab's refresh doesn't affect another's state.

---

## File Changes

| File | Change |
|---|---|
| `server/server.ts` | Replace `writeTurn` + `activeListener` + `turnLock` with event log + subscriber model. Add marker parsing in stdout reader loop. New endpoints: `GET /api/events`, `POST /api/send`. Remove `POST /api/chat` SSE response pattern. |
| `index.html` | Replace manual SSE parsing with `EventSource` subscription. Remove `streamSSEResponse`. Handle typed events via switch on `event.type`. |
| `chat.jsx` | No changes to components — they already consume props. |
| `CLAUDE.md` | Add `[AGENT_STATUS]` protocol. |
| `docs/architecture.md` | Update SSE section to document event log model. |

### Migration path

The event log is a **server-only change** that preserves the same data flow. The browser still receives events via SSE — only the shape changes (typed events instead of raw Claude output). This can be implemented incrementally:

1. Add event log and `GET /api/events` alongside existing endpoints
2. Migrate browser to `EventSource` subscription
3. Remove old `POST /api/chat` SSE pattern
4. Add server-side marker parsing
5. Remove client-side marker parsing
