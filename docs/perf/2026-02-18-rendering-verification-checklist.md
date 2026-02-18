# Rendering Regression Verification Checklist (2026-02-18)

Use this checklist to confirm whether the `post-hackathon` rendering fix actually resolves the progressive slowdown.

## Target

- Environment: `https://julian-edge.exe.xyz/?perfDebug=1`
- Expected deployed commit: `b7b72ca` or newer

## Preconditions

1. Open DevTools Console and clear logs.
2. Open DevTools Performance tab.
3. Keep only one Julian tab open.

## Runbook

1. Load page with `?perfDebug=1`.
2. Start a session, summon or wake agents until grid is populated.
3. Send 10 normal chat messages over ~2 minutes.
4. Leave app idle for 3 minutes.
5. While idle, interact with DevTools (switch tabs, inspect nodes).
6. Record a 60s Performance trace during the idle period.

## Required Evidence

Collect and paste:

- 3+ samples of `[PERF] App rate: ...`
- 3+ samples of `[PERF] AgentGrid rate: ...`
- At least 1 sample showing `suppressed: true`
- Performance trace summary:
  - main-thread long tasks count
  - 95th percentile frame time
  - whether FPS degrades over time

## Pass/Fail Criteria

- PASS if all are true:
  - AgentGrid idle rate is near zero (target <= `0.2/sec`)
  - `suppressed: true` appears during message activity
  - no progressive lag over 5 minutes
  - DevTools remains responsive (no multi-second stalls)
- FAIL if any are true:
  - AgentGrid keeps rendering repeatedly during idle chat activity
  - frame time progressively worsens
  - browser tab becomes sluggish or crashes

## If Fail

Next action: execute the split-subscription refactor path (`TranscriptPane` vs `AgentPane`) in `/Users/marcusestes/Websites/Julian/index.html` and re-run this same checklist.
