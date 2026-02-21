# Rendering Performance Fix — Session Report

**Date:** 2026-02-18
**Branch:** `post-hackathon`
**Commits:** `8513fc4`, `b7b72ca`
**Deploy:** https://julian-edge.exe.xyz/ (version `b7b72ca`)
**Prior handoff:** `docs/plans/2026-02-18-rendering-performance-handoff.md`
**Implementation plan:** `docs/plans/2026-02-18-rendering-performance-fix-plan.md`

## Context

**Update (post-fix analysis):** The work documented here is **defensive hardening**, not the root-cause fix. The actual performance crash was caused by unbounded SSE historical event replay on page load (fixed in commit `775c575`). The React render cascade documented below is a real inefficiency that amplified the SSE replay flood, but was not the primary cause. See `docs/plans/2026-02-18-rendering-fix-final-analysis.md` for the complete root cause hierarchy.

A previous debugging session (see prior handoff) identified the render cascade: every Fireproof write (including chat messages) triggers `useLiveQuery` which returns new array references for `agentDocs`, cascading through `agents` useMemo → AgentGrid → 8x PixelFace. Three prior fix attempts (ref-ifying event handlers, moving state back into JobsPanel, memoizing PixelFace/EggHatch) were partial — they reduced the blast radius but didn't stop the cascade at the source.

A second agent wrote the implementation plan (`2026-02-18-rendering-performance-fix-plan.md`) with 6 tasks. This session executed that plan.

## What Was Implemented

### Task 1: Perf Instrumentation

Added debug-only render counters behind `?perfDebug=1` URL flag.

**Files:** `index.html`, `chat.jsx`

- `PERF_DEBUG` constant + `window.PERF_DEBUG` for cross-file access
- App component: tracks render count, render rate (logged every 2s), and whether `rawAgentDocs` vs `agents` references changed (to measure suppression effectiveness)
- AgentGrid: tracks render count and rate independently
- All logging is default-off, zero runtime cost when flag absent

### Task 2: Identity-Stabilization Utilities

Pure functions that preserve object references when Fireproof re-emits structurally identical data.

**Files:** `shared/utils.js`, `tests/shared/utils.test.ts`

- `AGENT_SIGNIFICANT_FIELDS` — the fields that matter for rendering: `name`, `status`, `gridPosition`, `jobId`, `dormant`, `color`, `colorName`, `gender`, `faceVariant`
- `stabilizeDocsByKey(prev, next, keyFn, significantFields)` — generic: builds a Map from prev, compares significant fields for each doc in next, reuses prev reference if unchanged, returns prev array itself if all elements match
- `deriveStableAgents(prevAgents, docs)` — agent-specific: maps docs to UI shape (adding `_status`), then stabilizes using `AGENT_SIGNIFICANT_FIELDS` + `_status`
- 14 new tests covering reference stability, heartbeat suppression, added/removed docs, ordering

### Task 3: Stable Identity Pipeline in App

Replaced the direct `useLiveQuery` → `agents` chain with stabilized intermediaries.

**File:** `index.html`

Before:
```
useLiveQuery("agent-identity") → agentDocs → useMemo(map + getAgentStatus) → agents
```

After:
```
useLiveQuery("agent-identity") → rawAgentDocs → stabilizeDocsByKey → agentDocs (stable) → deriveStableAgents → agents (stable)
```

- `stableAgentDocsRef` and `stableAgentsRef` hold previous values for comparison
- Event handler refs (`agentDocsRef.current`) still point to stabilized docs (same significant field data, safe for message metadata lookups)
- Churn diagnostics log when raw docs change but stable agents don't (`suppressed: true`)

### Task 4: AgentGrid Memoization + Handler Stability

**Files:** `chat.jsx`, `index.html`

- Wrapped `AgentGrid` in `React.memo` with explicit comparator checking all 7 props: `agents`, `activeAgent`, `summoning`, `onSelectAgent`, `onSummon`, `onWake`, `fillContainer`
- Converted `handleSummon` and `handleWake` from closing over `summoning`/`sessionActive` state to reading from `summoningRef.current`/`sessionActiveRef.current`
- Dependency arrays reduced from `[summoning, sessionActive, getAuthHeaders, database]` to `[getAuthHeaders, database]` — these callbacks are now effectively stable for the app's lifetime

### Tasks 5-6: Gate Check + Cleanup

- Documented expected render paths post-fix in `docs/perf/2026-02-18-rendering-post-fix.md`
- Escalation path (splitting App into TranscriptPane + AgentPane) was not needed based on code analysis
- Perf instrumentation kept behind `?perfDebug=1` flag (default off, no cleanup needed)
- All 155 tests passing, no bare `database.put()` introduced

## Bug #1: `stabilizeDocsByKey is not defined` (post-deploy)

**Commit:** `8513fc4` (first deploy)
**Symptom:** `Uncaught ReferenceError: stabilizeDocsByKey is not defined` at App mount

**Root cause:** The functions were added to `shared/utils.js` which is a Node/Bun module for testing only. The browser loads `vibes.jsx` → `chat.jsx` → inline `<script type="text/babel">` in `index.html`. The `shared/utils.js` file has `window.*` assignments but is never loaded as a `<script>` tag — it's only imported by test files via ES module `import`.

**Fix (commit `b7b72ca`):** Added `AGENT_SIGNIFICANT_FIELDS`, `stabilizeDocsByKey`, and `deriveStableAgents` directly into the inline Babel script in `index.html`, right before the `App` function. The `shared/utils.js` copies remain the canonical testable versions. This mirrors the existing pattern where functions like `getAgentStatus` are defined in both `shared/utils.js` (for tests) and `chat.jsx` (for browser).

**Lesson:** This project has no build step. `shared/utils.js` is for Bun test imports only. Any function used in browser-side React code must be defined in one of the three browser-loaded files (`vibes.jsx`, `chat.jsx`, or inline script in `index.html`), even if a canonical copy exists in `shared/`.

## Current State

```
b7b72ca Fix: add stabilization functions to browser runtime scope  ← HEAD, deployed
8513fc4 Stabilize agent identity references to stop render cascade
29920d3 Add rendering performance handoff report for next debugging session
fc09f59 Memoize canvas components + ref-ify useCallbacks to fix frame drops
c2368b1 Break agentDocs render loop causing 5s web inspector delay
```

**Deployed to:** julian-edge.exe.xyz (version `b7b72ca`, health OK)
**Tests:** 155 pass, 0 fail
**Production:** still on `main` (unchanged)

## What to Verify

1. **Open `https://julian-edge.exe.xyz/?perfDebug=1`** — console should show `[PERF]` logs
2. **Send several chat messages** — look for `suppressed: true` in App perf logs (raw docs changed but stable agents didn't)
3. **Check AgentGrid rate** — should show `0.00/sec` during idle chat activity (memo is blocking re-renders)
4. **Run for 5+ minutes** — confirm no progressive slowdown or crash
5. **Test jobs UI** — create job, "Help Me", edit draft after tab switches (regression check)
6. **Test agent lifecycle** — summon, wake, select agent, session end/reconnect

## What Might Still Need Attention

- **Message query cascade:** `useLiveQuery("type", { key: "message" })` still returns new refs on every write. If `persistedMessages` drives expensive downstream computation, the same stabilization pattern could be applied there. Currently the message list re-renders on every new message, which is expected behavior — but worth watching if performance issues persist.
- **JobsPanel receives `agentDocs`** (line 2283 of index.html): it's now the stabilized version, which should reduce unnecessary re-renders. But JobsPanel itself is not memoized. If it becomes a bottleneck, wrapping it in `React.memo` would be the next step.
- **No browser profiling was done this session** — the fix is based on code analysis. Chrome DevTools Performance recording with agents active would confirm the render cascade is actually stopped.

## Files Changed

| File | What changed |
|------|-------------|
| `index.html` | Perf instrumentation, stable identity pipeline, handler ref-ification, browser-side stabilization functions |
| `chat.jsx` | AgentGrid perf counters, `React.memo` wrap with explicit comparator |
| `shared/utils.js` | `stabilizeDocsByKey`, `deriveStableAgents`, `AGENT_SIGNIFICANT_FIELDS` (test-only canonical copies) |
| `tests/shared/utils.test.ts` | 14 new tests for stability utilities |
| `docs/perf/2026-02-18-rendering-baseline.md` | Pre-fix metrics template |
| `docs/perf/2026-02-18-rendering-post-fix.md` | Post-fix analysis and expected behavior |
