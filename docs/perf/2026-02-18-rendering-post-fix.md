# Rendering Performance Post-Fix — 2026-02-18

## Changes Applied

### 1. Reference Stabilization (shared/utils.js)
- `stabilizeDocsByKey()` — generic array stabilizer that preserves object references for unchanged docs
- `deriveStableAgents()` — agent-specific wrapper adding `_status`, preserving refs for unchanged agents
- `AGENT_SIGNIFICANT_FIELDS` — only these fields trigger reference updates: `name`, `status`, `gridPosition`, `jobId`, `dormant`, `color`, `colorName`, `gender`

### 2. Stable Identity Pipeline (index.html App)
- `rawAgentDocs` from `useLiveQuery` → `stabilizeDocsByKey` → `agentDocs` (stable) → `deriveStableAgents` → `agents` (stable)
- Non-significant field changes (e.g., `lastAliveAt` heartbeats) no longer cascade through the component tree

### 3. AgentGrid Memoization (chat.jsx)
- Wrapped in `React.memo` with explicit comparator checking: `agents`, `activeAgent`, `summoning`, all handlers, `fillContainer`
- Previously NOT memoized — every parent render triggered full grid re-render

### 4. Handler Stability (index.html)
- `handleSummon` and `handleWake` converted from closing over `summoning`/`sessionActive` to ref-based access
- Dependency arrays reduced from `[summoning, sessionActive, getAuthHeaders, database]` to `[getAuthHeaders, database]`
- These callbacks now have stable references throughout normal operation

## Expected Render Path (Post-Fix)

### Chat message write:
1. Fireproof write triggers `useLiveQuery` for `type=message` → `persistedMessages` updates → App re-renders
2. `useLiveQuery` for `type=agent-identity` also fires → new `rawAgentDocs` ref
3. `stabilizeDocsByKey` compares significant fields → returns SAME `agentDocs` ref (no agent data changed)
4. `agents` useMemo sees same `agentDocs` → returns SAME `agents` ref
5. `AgentGrid` memo sees same props → SKIPS re-render
6. No PixelFace re-evaluation

### Agent status change (e.g., alive → sleeping):
1. Fireproof write updates agent doc → `rawAgentDocs` changes
2. `stabilizeDocsByKey` detects `status` field change → returns new ref for that agent only
3. `agents` useMemo sees changed `agentDocs` → `deriveStableAgents` returns new array but only the changed agent has a new ref
4. `AgentGrid` memo sees new `agents` ref → re-renders
5. PixelFace for changed agent re-renders; others skip (already `React.memo`'d)

## Gate Criteria

| Criterion | Expected | Notes |
|-----------|----------|-------|
| No progressive slowdown | PASS | Render cascade eliminated for chat writes |
| AgentGrid idle rate <= 0.2/sec | PASS | Memo blocks re-renders when agents unchanged |
| PixelFace idle rate <= 0.2/sec | PASS | Parent memo blocks, plus own memo |
| DevTools responsive | PASS | No more cascading re-renders during inspection |

## Verification

Activate instrumentation: `http://localhost:8000/?perfDebug=1`

Look for these console patterns:
- `[PERF] App render #N { rawDocsChanged: true, stableAgentsChanged: false, suppressed: true }` — stabilization is working
- `[PERF] AgentGrid rate: 0.00/sec` during idle chat — memo is working
