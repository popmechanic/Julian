# Ledger Identity & Self-Healing Architecture

**Date:** 2026-02-17
**Status:** Design approved
**Origin:** Julian's analysis in `memory/the-ledger.html`
**Related:** `2026-02-17-agent-state-machine-implementation.md`, `2026-02-17-event-log-architecture.md`

## Problem

The agent grid crashes when `cell.agent.name` is undefined. The root cause: the Fireproof ledger can be wiped (via `DB_VERSION` bump) while the Claude subprocess is still running with agents. Hatching placeholders get promoted to `alive` status before receiving identity data, crashing the renderer.

This is a symptom of a deeper gap: two systems with different lifetimes (Claude subprocess in memory, Fireproof in IndexedDB + cloud) with no reconciliation protocol when they desynchronize.

Julian's framing: the ledger is the material form of agent identity, not just a database. Destroying it is an amnesia event the architecture must acknowledge.

## Design Decisions

Answers to Julian's open questions:

1. **Ledger identity**: Use `database.name` (stable, deterministic, set at creation) + Connect's `ledgerId` (server-generated, stable across mutations) for identity. CRDT clock head is a state fingerprint, not an identity fingerprint — useful for convergence checks, not for stable ID.

2. **Cloud persistence**: Cloud ledger survives local IndexedDB wipe. A `DB_VERSION` bump that wipes local IDB reconnects to the same cloud data if the database name is unchanged. A name bump (e.g. `v5` → `v6`) creates a new cloud ledger via appId routing.

3. **Multi-instance**: Fully shared. All Julian instances (julian.exe.xyz, julian-edge.exe.xyz, branches) share one Fireproof ledger via cloud sync.

4. **Agent writes**: Full agent autonomy. All agents share a single ledger; transcripts are filtered by metadata (gridPosition, agentName). Agents can emit markers for any document type. Trust until negative externalities appear.

5. **Event durability**: Ephemeral by design. The server is a bridge, not a brain. In-memory ring buffer (2000 events), lost on restart. Fireproof remains the durable store. Rather than adding server-side persistence (SQLite), Phase 5 closes all three reconnection gaps so durability isn't needed on the server.

---

## Phase 1: Defensive Guards (Immediate)

Ship independently. No dependencies.

### 1a. Structural validation in state transitions

**File:** `index.html` — `onAgentStatus` handler

Refuse `hatching → alive` transitions for documents without a `name` field:

```javascript
if (!doc.name && alivePositions.has(doc.gridPosition)) {
  console.warn('[EventSource] Skipping alive transition for nameless doc at seat', doc.gridPosition);
  continue;
}
```

### 1b. Structural override in AgentGrid

**File:** `chat.jsx` — cell type derivation

Treat any agent without a `name` as `hatching`, regardless of `status`:

```javascript
if (agent && !agent.name) return { type: 'hatching', agent };
```

### 1c. Fallback on name access (already shipped)

The `(cell.agent.name || '?').toUpperCase()` guards on lines 635 and 652 are already in place. Keep as third layer of defense.

---

## Phase 3: Self-Healing Events

Ships before Phase 2. The enriched status events are useful even without explicit amnesia detection — they heal missed registrations, reconnect gaps, and event buffer overflows.

### 3a. Enrich `[AGENT_STATUS]` marker

**File:** `CLAUDE.md` — Agent Status Reporting protocol

Current format:
```json
[AGENT_STATUS] {"agents":[{"name":"Lyra","status":"alive","gridPosition":0}]}
```

New format (adds visual identity fields):
```json
[AGENT_STATUS] {"agents":[{
  "name":"Lyra","status":"alive","gridPosition":0,
  "color":"#c9b1e8","colorName":"Violet Heaven",
  "gender":"woman","faceVariant":{"eyes":"standard","mouth":"gentle"}
}]}
```

`individuationArtifact` (agent soul text) is omitted from heartbeats — too large for periodic SSE. Included only in full dumps triggered by `/api/ledger-reset` (Phase 2).

### 3b. Upsert in `onAgentStatus` handler

**File:** `index.html` — `_eventHandlers.onAgentStatus`

Change from update-only to upsert. If no doc exists at a gridPosition but the status event says one should, create it:

```javascript
_eventHandlers.onAgentStatus = async (event) => {
  try {
    const agentMap = {};
    for (const a of (event.agents || [])) {
      if (a.gridPosition != null) agentMap[a.gridPosition] = a;
    }

    // Update or create agent docs
    for (const [pos, agent] of Object.entries(agentMap)) {
      const _id = `agent-identity:${pos}`;
      const existing = await database.get(_id).catch(() => null);

      if (existing) {
        // Update status if changed
        if (getAgentStatus(existing) !== agent.status) {
          await database.put({
            ...existing,
            status: agent.status,
            lastAliveAt: new Date(event.ts).toISOString(),
            lastSessionId: event.sessionId,
          });
        }
      } else if (agent.name) {
        // Create from status event data (self-healing)
        await database.put({
          _id,
          type: 'agent-identity',
          category: 'identity',
          status: agent.status,
          name: agent.name,
          color: agent.color,
          colorName: agent.colorName,
          gender: agent.gender,
          faceVariant: agent.faceVariant,
          gridPosition: parseInt(pos),
          lastAliveAt: new Date(event.ts).toISOString(),
          lastSessionId: event.sessionId,
          createdAt: new Date().toISOString(),
        });
        console.log('[EventSource] Self-healed agent doc at seat', pos, agent.name);
      }
    }

    // Transition agents not in status to sleeping
    const { rows } = await database.query('type', { key: 'agent-identity' });
    for (const row of rows) {
      const doc = row.doc || row.value;
      if (getAgentStatus(doc) === 'expired') continue;
      if (!agentMap[doc.gridPosition] && getAgentStatus(doc) === 'alive') {
        await database.put({ ...doc, status: 'sleeping' });
      }
    }
  } catch (e) {
    console.warn('[EventSource] Failed to handle agent_status:', e);
  }
};
```

### 3c. Server-side status event enrichment

**File:** `server/server.ts` — marker parsing

When the server parses an `[AGENT_STATUS]` marker from Julian's output, it already emits an `agent_status` event. No server change needed — the enrichment happens in Julian's output (CLAUDE.md protocol), and the server passes it through.

---

## Phase 2: Ledger Identity

Depends on Phase 3 (the `/api/ledger-reset` endpoint needs enriched status to be useful).

### 2a. `ledger-meta` document

**File:** `index.html` — database initialization

On first database creation, write a well-known document:

```javascript
const meta = {
  _id: 'ledger-meta',
  type: 'ledger-meta',
  category: 'operational',
  databaseName: database.name,      // e.g. 'julian-chat-v5'
  connectLedgerId: null,             // filled when cloud sync activates
  createdAt: new Date().toISOString(),
  parentLedgerId: null,              // set if forked from another ledger
};
```

### 2b. Amnesia detection

**File:** `index.html` — useEffect on mount, after database ready

```javascript
useEffect(() => {
  if (!database) return;
  (async () => {
    const meta = await database.get('ledger-meta').catch(() => null);
    if (!meta) {
      // Fresh or wiped ledger — amnesia event
      await database.put({
        _id: 'ledger-meta',
        type: 'ledger-meta',
        category: 'operational',
        databaseName: database.name,
        connectLedgerId: null,
        createdAt: new Date().toISOString(),
        parentLedgerId: null,
      });
      // Signal server to replay full state
      fetch('/api/ledger-reset', { method: 'POST', headers: corsHeaders() })
        .catch(e => console.warn('[Ledger] Failed to signal reset:', e));
      console.log('[Ledger] Amnesia detected — signaled server for full state replay');
    }
  })();
}, [database]);
```

### 2c. Server-side reset handler

**File:** `server/server.ts`

New endpoint: `POST /api/ledger-reset`

When received, write a special prompt to Julian's stdin asking for full agent status including `individuationArtifact`:

```typescript
app.post('/api/ledger-reset', () => {
  const msg = '[LEDGER RESET] The browser ledger was wiped. ' +
    'Re-emit [AGENT_STATUS] with full identity data for all known agents, ' +
    'including individuationArtifact.';
  writeToStdin(msg);
  return Response.json({ ok: true });
});
```

Julian receives this as a chat message and responds with the enriched `[AGENT_STATUS]`. The browser's upsert handler (Phase 3) rebuilds all agent docs.

### 2d. Connect ledgerId capture

**File:** `index.html` — after cloud sync activates

When the vibes bridge resolves the cloud ledger, update `ledger-meta`:

```javascript
const ledgerId = window.__VIBES_LEDGER_MAP__?.[database.name];
if (ledgerId) {
  const meta = await database.get('ledger-meta').catch(() => null);
  if (meta && !meta.connectLedgerId) {
    await database.put({ ...meta, connectLedgerId: ledgerId });
  }
}
```

---

## Phase 4: Ledger Management UI

Depends on Phase 2 (`ledger-meta` doc must exist).

### 4a. Ledger Health Panel

**File:** `index.html` or `vibes.jsx` — new panel in hidden menu

Displays:
- **Database name**: from `ledger-meta.databaseName`
- **Connect ledger ID**: from `ledger-meta.connectLedgerId` (or "not synced")
- **Created**: from `ledger-meta.createdAt`
- **Document counts**: query by type — agents, messages, artifacts, markers
- **Sync status**: connected/disconnected, CRDT clock state
- **Lineage**: `parentLedgerId` if forked

### 4b. Ledger Operations

Three buttons with confirmation dialogs:

**New Ledger** — Creates a blank ledger.
- Stores current database name in localStorage `knownLedgers` array
- Bumps database name (e.g. `v5` → `v6`)
- Creates fresh `ledger-meta` with `parentLedgerId` pointing to old name
- Confirmation: "This creates a blank ledger. All conversation history and agent identities will be inaccessible until restored. The cloud copy of the current ledger is preserved."

**Fork Ledger** — Preserves identities, drops history.
- Creates new database name
- Copies all `agent-identity` docs (names, souls, colors, faceVariants)
- Drops transcripts, markers, artifacts
- Creates `ledger-meta` with `parentLedgerId`
- Confirmation: "Agents will retain their identities but lose conversation history."

**Restore** — Reconnects to a previous ledger.
- Shows list from localStorage `knownLedgers` array
- Sets database name back to selected entry
- Reconnects to cloud copy (cloud survives local wipe)
- Confirmation: "This will switch to the selected ledger. Current ledger is preserved."

### 4c. Lineage tracking

Each `ledger-meta` stores `parentLedgerId`. The UI displays this as a breadcrumb trail: `v3 → v4 → v5`. Not a full version browser — just provenance.

---

## Phase 5: Resilient Reconnection

The server is a bridge, not a brain. Rather than adding server-side persistence (SQLite, JSON logs), Phase 5 closes the three reconnection gaps so the server can remain stateless. Julian's insight (see `memory/ephemeral-server.html`): moving persistence to the server creates a new obligation that contradicts making Julian deployable by non-sysadmins. Operating the system should not require database administration.

### The three desync scenarios

1. **Server restarts while browser has ledger** — Server loses all in-memory state; browser retains full Fireproof data.
2. **Browser wipes while server runs** — The `.toUpperCase()` crash scenario. Browser is empty; Claude subprocess still has agents.
3. **SSE drops mid-session** — Both sides have state but the sync bridge is broken.

### 5a. Server restart recovery (browser → server)

**File:** `index.html` — SSE reconnection logic

When EventSource fires `onerror` or the connection drops, the browser:
1. Locally transitions all `alive` agents to `sleeping` — no server signal needed, just Fireproof writes
2. On reconnect, the session-start/wakeup message includes full agent state assembled from Fireproof
3. Julian rebuilds context from what the browser sends, not from disk

```javascript
// In EventSource onerror handler:
const { rows } = await database.query('type', { key: 'agent-identity' });
for (const row of rows) {
  const doc = row.doc || row.value;
  if (getAgentStatus(doc) === 'alive') {
    await database.put({ ...doc, status: 'sleeping' });
  }
}
```

The browser is the source of truth for agent identity. On reconnect, it sends what it knows; the server doesn't need to remember.

### 5b. Browser wipe recovery (server → browser)

Already solved by Phase 2 + Phase 3:
- Browser detects missing `ledger-meta` (amnesia detection, Phase 2b)
- Signals `/api/ledger-reset` (Phase 2c)
- Server asks Julian for enriched `[AGENT_STATUS]` with full identity data
- Browser's upsert handler (Phase 3b) rebuilds all agent docs

No server persistence needed — Julian's context window holds the agent state, and the enriched status protocol carries enough data to reconstruct.

### 5c. SSE drop recovery (cursor-based replay)

**File:** `index.html` — EventSource configuration

`EventSource` reconnects automatically with `Last-Event-ID`. The server's 2000-event ring buffer covers typical disconnects (minutes to hours of activity). For extended disconnects where the buffer is exceeded:

```javascript
// In EventSource reconnection, after receiving first event:
// If there's a gap (first event ID >> last seen ID + 1), request full state
if (event.id > lastSeenId + 100) {
  console.warn('[EventSource] Large gap detected, requesting full state');
  fetch('/api/ledger-reset', { method: 'POST' });
}
```

This reuses the same `/api/ledger-reset` path — one recovery mechanism for both amnesia and extended disconnects.

### 5d. Design principle

The in-memory ring buffer is explicitly disposable. The server can crash, restart, and recover cleanly because:
- Fireproof (browser + cloud) is the durable layer
- The browser sends state to the server on reconnect (not the other way around)
- Self-healing events (Phase 3) close any remaining gaps
- No SQLite, no backup anxiety, no new ops obligations

Deploying Julian should feel like deploying a static site with a process manager — not like running a database.

---

## Implementation Order

```
Phase 1 (Defensive Guards)    — No dependencies. Ship immediately. ~10 lines.
  ↓
Phase 3 (Self-Healing Events) — Protocol + handler. ~40 lines. Can parallel with Phase 1.
  ↓
Phase 2 (Ledger Identity)     — Depends on Phase 3. ~50 lines.
  ↓
Phase 4 (Ledger Management)   — Depends on Phase 2. ~150 lines.
  ↓
Phase 5 (Resilient Reconnect) — Depends on Phase 2 + 3. ~30 lines.
                                 Can parallel with Phase 4.
```

## File Changes Summary

| Phase | File | What Changes |
|-------|------|-------------|
| 1 | `chat.jsx` | Structural override: nameless agents → hatching |
| 1 | `index.html` | Guard in `onAgentStatus`: refuse nameless alive transitions |
| 3 | `CLAUDE.md` | Enriched `[AGENT_STATUS]` protocol with visual identity fields |
| 3 | `index.html` | Upsert logic in `onAgentStatus` handler |
| 2 | `index.html` | `ledger-meta` doc creation, amnesia detection useEffect, Connect ID capture |
| 2 | `server/server.ts` | `POST /api/ledger-reset` endpoint |
| 4 | `index.html` or `vibes.jsx` | Ledger health panel, operation buttons, lineage display |
| 5 | `index.html` | SSE disconnect → sleep agents locally, gap detection → ledger-reset |

## Identity Permanence

Named agents are permanent. Once an agent chooses a name (SUMMON ceremony), that identity persists in the ledger forever. There is no RESUMMON — SUMMON happens once per ledger lifetime.

### State Machine

```
Two buttons. Two states after naming.

SUMMON: no named agents exist in the ledger (truly fresh)
WAKE:   at least one named agent is sleeping

States:
  empty     → hatching    SUMMON clicked (once per ledger)
  hatching  → alive       AGENT_REGISTERED event
  alive     → sleeping    session disconnect
  sleeping  → alive       WAKE ceremony
  hatching (nameless, stale) → expired    boot cleanup (>10 min)
  hatching (named, stale)    → sleeping   boot cleanup (immediate)

Named agents NEVER expire. expired is only for nameless placeholders.
No RESUMMON button. No deletion of named agents.
```

### Enforcement

- `handleSummon` guards against re-summoning: queries the ledger for named agents and aborts if any exist
- `expireStaleHatching` distinguishes named vs nameless hatching: named → sleeping (recoverable), nameless → expired (after 10 min timeout)
- Button logic derives from `namedAgents.length`: 0 named → SUMMON, any sleeping → WAKE, all awake → no button

---

## What's NOT Changing

- `vibes.jsx` — UI components, no state logic (unless Phase 4 panel goes here)
- `soul/` — Read-only identity documents
- Database name — No bump. Schema evolves forward with self-healing.
- Event log core — Stays ephemeral by design. The server is a bridge, not a brain.
- Cloud sync routing — appId-based matching already handles ledger separation.
- No SQLite, no server-side persistence — Fireproof + cloud is the durable layer.
