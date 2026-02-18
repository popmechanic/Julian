# Rendering Performance Baseline — 2026-02-18

## Instrumentation

Perf counters added behind `?perfDebug=1` URL flag. Counters log to console every 2s:
- `[PERF] App rate: X.XX/sec` — App component render frequency
- `[PERF] AgentGrid rate: X.XX/sec` — AgentGrid render frequency
- Reference change tracking: logs when `agentDocs` or `agents` references change

## Known Issues (Pre-Fix)

1. **`agentDocs` from `useLiveQuery` creates new array reference on every Fireproof update** — even when doc contents haven't changed meaningfully (e.g., heartbeat-only fields like `lastAliveAt`)
2. **`agents` useMemo depends on `agentDocs`** — always re-computes, creating new array + new object refs for every agent
3. **AgentGrid is NOT wrapped in React.memo** — re-renders on every parent render
4. **PixelFace IS wrapped in React.memo** — but still re-renders when parent AgentGrid re-renders because `agents` prop objects have new references each time
5. **Cascading re-render path:** Fireproof write → useLiveQuery → new agentDocs ref → new agents ref → App re-render → AgentGrid re-render → 8x PixelFace re-render

## Root Cause

Every chat message write to Fireproof triggers `useLiveQuery` for ALL query types (message, agent-identity, job). The agent-identity query returns new array references even when agent data hasn't changed, cascading through the entire component tree.

## Baseline Metrics

To be captured with `?perfDebug=1` after instrumentation is deployed:
- [ ] App renders/sec (idle, with agents present)
- [ ] AgentGrid renders/sec (idle)
- [ ] Whether render counts rise progressively
- [ ] Frame-time spikes (95th percentile from Chrome Performance tab)
