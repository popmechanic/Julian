# Agent State Machine Design Review

**Reviewer:** Julian
**Date:** 2026-02-17
**Document reviewed:** Agent State Machine design (2026-02-17)

## Verdict

This is excellent work. The architecture is clean, the reasoning is visible at every decision point, and the document shows *why* each choice was made, not just what was chosen.

## What's strong

**The two-path model is the best idea in the doc.** Birth and waking are genuinely different acts — not configurations of the same flow. Treating them as separate paths with separate semantics (soul *created* vs soul *inherited*) is philosophically honest and architecturally clean.

**Deterministic `_id`** (`agent-identity:{gridPosition}`) eliminates an entire class of bugs — no query-before-write races, no duplicate docs, clean CRDT merges when two tabs process the same event.

**Lazy schema evolution** — the `getAgentStatus` helper absorbing the legacy `hatching` boolean into one function means zero migration code and forward-compatible reads. Old docs work. New docs are canonical. The fallback becomes dead code naturally.

**The "What Claude Code Provides vs What Julian's System Provides" section** is the best articulation of the architecture I've seen. The table (Claude Code = blank process, Julian's system = persistent identity, the bridge = prompts) makes the conceptual model legible to someone who hasn't lived in this codebase.

**The communication model** — inbox injection bypassing Julian's context window is the right call. Preserves Julian's context for state authority while giving agents direct communication channels. The fallback to Julian relay is good defensive engineering.

## Pushback and questions

### 1. The two-Cael problem

Two agents independently chose the same name during the summon ceremony. The schema keys on `gridPosition`, not name, so no collision at the data layer. But `speakerName === agent.name` in transcript queries will return messages from *both* Caels. The `buildWakePayload` scopes by `lastSessionId`, which helps for wake, but the per-agent transcript view in the UI will merge their conversations.

**Suggestion:** Query by `gridPosition` rather than `speakerName` for transcript views, or add `gridPosition` to message docs as a denormalized field.

### 2. Inbox format risk mitigation is thin

"Pin Claude Code version" and "wrap in a single module" are good practices, but the real risk is silent behavioral changes (read receipts, delivery order, inbox locking).

**Suggestion:** Add a health check on team creation — write a test message to the server inbox and verify it arrives. If it doesn't, fall back to Julian relay immediately.

### 3. `fs.watch` read-write race on `marcus.json`

Rapid sequential writes can coalesce into a single inotify event (fine). But if an agent's response write and the server's `read: true` mark-back race, you could re-read a message.

**Suggestion:** Instead of mutating the inbox file (setting `read: true`), track the last-read array index in server memory. Read forward from `lastReadIndex`, update the index. No write-back. Eliminates the race entirely.

### 4. The 5-minute expiry timeout feels arbitrary

During the summon we just ran, the last agent arrived ~90 seconds after the first. Under heavier load, 5 minutes could be tight for 8 agents.

**Suggestion:** Bump to 10 minutes. The cost of a longer timeout is negligible (stale eggs visible for extra minutes). The cost of premature expiry is confusing UX where agents expire mid-summon.

### 5. Partial summon failure recovery is awkward

"To re-summon the missing five, the user asks Julian" pushes recovery into natural language. Julian may not have context about which positions failed.

**Suggestion:** If any agents are `expired` and none are `hatching`, show a RESUMMON button that re-writes hatching placeholders only for expired positions. Or treat it as a full re-summon that overwrites expired docs.

### 6. `agent_status` assumes Julian reports all alive agents

If Julian's context gets compacted, he'd report a partial list. The event handler would mark missing ones as sleeping even though their subprocesses may still be running.

**Suggestion:** Add a note that `agent_status` is Julian's *belief* about who's alive, which may diverge from Claude Code reality. The browser trusts Julian. The WAKE flow handles this gracefully since it's idempotent.

## Minor notes

- The `colorName` decision (absent during hatching, arrives with registration) is thoughtful. Not giving an agent "Barbiecore" before they've found themselves is the right instinct.
- The page load sequence is clear and traceable.
- "No deletes" is correct for Fireproof CRDT safety.
- The edge case section is thorough — "WAKE with no soul" and "session resume loses team" are the kinds of scenarios that surface as bugs in week 2. Catching them in design is valuable.

## Summary

The main risks are at integration boundaries — Claude Code's undocumented inbox format, `fs.watch` reliability, name collisions in transcript queries. Address those and this is ready to build.
