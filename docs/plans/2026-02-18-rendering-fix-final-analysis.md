# Rendering Performance Fix — Final Analysis

**Date:** 2026-02-18
**Branch:** `post-hackathon` at `74e078f`
**Deploy:** https://julian-edge.exe.xyz/

## What Actually Happened

The browser was progressively slowing down and eventually crashing. Three debugging sessions produced 8+ commits attempting to fix it. The actual resolution came from two changes, and it's important to be precise about which did what.

## Root Cause Hierarchy

### Primary: SSE Historical Replay (commit `775c575`)

On every page load or reconnect, the EventSource replayed the **entire server event log** from `_lastEventId = -1`. As sessions accumulated events (agent status heartbeats, chat messages, tool calls), this replay grew unbounded. Each replayed event triggered Fireproof writes, `useLiveQuery` re-evaluations, and React re-renders — a multiplicative amplification of what was already a large dataset.

**The fix:** Persist `lastEventId` in `sessionStorage` so reconnects resume from where they left off. On first load with no stored ID, use `MAX_SAFE_INTEGER` to skip all historical events. This is the commit that directly addresses the crash trigger.

### Secondary: Accumulated Ledger State (commit `74e078f`)

The cloud ledger for `julian-chat-v9` had accumulated a large volume of CRDT state from prior sessions. Even with the SSE replay fix, the existing Fireproof data was bloated enough to cause performance issues during initial sync and query processing.

**The fix:** Bump `DB_VERSION` to 10 and database name to `julian-chat-v10`. This triggers a one-time IndexedDB wipe and routes to a fresh cloud ledger.

**This is recovery, not a root-cause fix.** It should not be relied upon as a regular operation. The SSE replay fix (`775c575`) prevents the re-accumulation problem. Without it, bumping the DB version would only buy time before the same bloat recurred.

### Not Root Cause: React Render Cascade

The earlier sessions correctly observed that `useLiveQuery` returns new array references on every Fireproof write, cascading through `agents` → `AgentGrid` → `PixelFace`. This is a real inefficiency, but it was not the primary cause of the crash. It was an **amplifier** — the SSE replay flood was the signal, and the render cascade amplified each replayed event into expensive DOM work.

## Commit-by-Commit Assessment

| Commit | What | Verdict |
|--------|------|---------|
| `775c575` | SSE replay skip + sessionStorage persistence | **Keep — core fix.** Prevents unbounded event replay on load/reconnect. |
| `74e078f` | DB_VERSION 10 + julian-chat-v10 | **Keep as one-time recovery.** Do not repeat as a regular practice. |
| `8513fc4` | Stabilization utilities + pipeline in App | **Keep as hardening.** Prevents render cascade from amplifying future data-layer issues. Not the fix, but reduces blast radius. |
| `b7b72ca` | Browser runtime scope fix for stabilization functions | **Keep.** Required bugfix for `8513fc4` (functions weren't in browser scope). |
| `c36a29f` | faceVariant in significant fields + agentDocsRef → rawAgentDocs | **Keep.** Correctness fixes from code review. |
| `fc09f59` | React.memo on PixelFace/EggHatch, ref-ify useCallbacks | **Keep.** Good practice — canvas components should be memoized. |
| `c2368b1` | Move selectedJob/jobDraft back into JobsPanel, ref-ify event handlers | **Keep with caveat** — see known regression below. |
| `29920d3` | Handoff report | Docs only. |

## Known Regression: JobsPanel Draft Persistence

`selectedJob` and `jobDraft` are defined as local state inside `JobsPanel` (chat.jsx lines 2470-2471). But `JobsPanel` is conditionally rendered — it unmounts when `menuTab !== 'jobs'` (index.html line 2337). This means:

- User starts editing a job draft
- Switches to the "agents" or "browser" tab
- Switches back to "jobs"
- Draft is gone

This was introduced in `c2368b1` which moved these values out of App (to stop App-level re-renders on every keystroke) and back into JobsPanel. The trade-off was correct for performance, but the unmount behavior wasn't addressed.

**Fix options:**
1. Lift `selectedJob`/`jobDraft` back to App but wrap `JobsPanel` in `React.memo` so keystrokes don't cascade
2. Use a ref or `window.*` to persist draft state across unmounts
3. Change conditional rendering to CSS visibility (`display: none`) so JobsPanel stays mounted

Option 1 is cleanest with the memo infrastructure now in place.

## Stale Documentation

These docs contain assertions that were not verified with actual profiling and should be updated or removed:

- `docs/perf/2026-02-18-rendering-post-fix.md` — Gate criteria table marks everything as "PASS" without profiling evidence. The `AGENT_SIGNIFICANT_FIELDS` list is outdated (missing `faceVariant`).
- `docs/perf/2026-02-18-rendering-baseline.md` — Baseline metrics were never captured (all checkboxes unchecked).
- `docs/plans/2026-02-18-rendering-perf-fix-session-report.md` — Correctly documents what was done but presents the stabilization work as the fix rather than hardening. `AGENT_SIGNIFICANT_FIELDS` list on line 35 is outdated.

## Lessons

1. **Profile before optimizing.** Three sessions of React optimization addressed a real but secondary concern. A Chrome DevTools recording during the actual slowdown would have shown the SSE replay dominating the flame chart, not React reconciliation.

2. **Check the data layer first.** The prior handoff report (from the first debugging session) correctly identified `useLiveQuery` reference instability but missed the upstream cause: the EventSource was replaying thousands of historical events on every page load, each triggering Fireproof writes that then triggered the query instability.

3. **DB version bumps are emergency recovery, not fixes.** They destroy user data (chat history, agent identities, job state). The fact that it worked confirms the data layer was the problem, but the SSE replay fix is what prevents recurrence.

4. **The no-build-step architecture has sharp edges.** `shared/utils.js` exists for testing but isn't loaded in the browser. Any function used in React must be duplicated into the browser-loaded files. This caused a deploy failure (`b7b72ca`).

## Recommended Next Steps

1. **Done:** SSE replay fix is deployed and working (`775c575`).
2. **Small follow-up:** Fix JobsPanel draft persistence regression (isolated change, low risk).
3. **Cleanup:** Update or remove the stale perf docs so future debugging isn't misled by unverified PASS assertions.
4. **Future:** If performance issues recur, profile in Chrome DevTools first. The `?perfDebug=1` instrumentation is available but is no substitute for a real flame chart.
