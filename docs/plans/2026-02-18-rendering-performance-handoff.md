# Rendering Performance Handoff Report

**Date:** 2026-02-18
**Branch:** `post-hackathon` (diverged from `main`)
**Deploy target:** https://julian-edge.exe.xyz/
**Problem:** Browser performance degrades until the app becomes unusable / crashes

## The Symptom

After deploying the `post-hackathon` branch, the Julian web app becomes sluggish over time. Web inspector takes 5+ seconds to respond. Pixel face canvas animations stutter. Eventually the browser tab crashes. This does **not** happen on `main`.

## What Changed (The Suspect)

Commit `c94522f` — "Fix job form usability: lift state to App, add [UI_ACTION] protocol" — is the most likely root cause. It made these changes:

### 1. Lifted state from JobsPanel into App (~line 608 in index.html)

```javascript
// Added to App component:
const [jobView, setJobView] = useState('list');
const [selectedJob, setSelectedJob] = useState(null);  // later removed in c2368b1
const [jobDraft, setJobDraft] = useState(null);         // later removed in c2368b1
```

**Why it was done:** JobsPanel unmounts when the user switches tabs (menuTab state). Lifting state to App preserves it across tab switches.

**Why it's suspect:** Every `useState` in App causes the *entire* App component tree to re-render when it changes. App is a ~700-line mega-component with no memoization. Any keystroke in a job form field would re-render the chat, the agent grid (9 canvas components), the menu panel, everything.

### 2. Added `julian:send-chat` CustomEvent listener (~line 955)

```javascript
useEffect(() => {
  const handler = (e) => {
    const msg = e.detail?.message;
    if (msg && sessionActive && !streaming) {
      sendMessage(msg);
    }
  };
  window.addEventListener('julian:send-chat', handler);
  return () => window.removeEventListener('julian:send-chat', handler);
}, [sendMessage, sessionActive, streaming]);
```

**The cascade:** `sendMessage` depends on `agentDocs` (via `useLiveQuery`) → the listener re-registers on every `agentDocs` change → which causes... unclear downstream effects. This was patched in `712dccc` by using refs instead, but the fix may be incomplete.

### 3. Added `[UI_ACTION]` marker stripping in SSE event handlers

```javascript
const cleaned = block.text.split('\n').filter(l => !l.startsWith('[UI_ACTION]')).join('\n');
```

This runs on every SSE text chunk. Probably not the performance issue, but it does create new string allocations on every streaming event.

## What's Been Tried (6 fix attempts, none fully resolved it)

| Commit | What it did | Did it help? |
|--------|------------|-------------|
| `712dccc` | Ref-ified `sendMessage`/`streaming` in the `julian:send-chat` listener to avoid re-registration | Partially — stopped the listener cascade, but frame drops persisted |
| `c2368b1` | Moved `selectedJob`/`jobDraft` back into JobsPanel. Created `agentDocsRef`/`activeAgentRef`/`refreshMenuDataRef`. Removed `activeAgent`/`agentDocs`/`refreshMenuData` from SSE effect deps (was `[database, serverSessionId, activeAgent, agentDocs, refreshMenuData]` → `[database, serverSessionId]`) | Partially — web inspector became responsive again, but canvas animations still stutter |
| `fc09f59` | Wrapped `PixelFace` and `EggHatch` in `React.memo`. Removed `agentDocs`/`activeAgent` from deps of `displayMessages`, `handleSummon`, `handleWake`, `sendMessage`, `handleOfferWork` | Untested — deployed but browser extension kept crashing before we could verify |

## The Fundamental Architecture Problem

The `App` component in `index.html` is a single ~700-line function component with:

- **~20 `useState` hooks** — every state change re-renders the entire tree
- **~15 `useEffect` hooks** — many with dependency arrays that include frequently-changing values
- **`useLiveQuery("type", { key: "agent-identity" })`** — returns a new `agentDocs` array on every Fireproof write (including agent_status heartbeats during a live session, which fire every few seconds)
- **`useLiveQuery("type", { key: "message" })`** — returns a new `persistedMessages` array on every message write

Every `agentDocs` change cascades through:
1. `agents` useMemo (depends on `[agentDocs, sessionActive]`)
2. `activeAgentObj` useMemo (depends on `[activeAgent, agents]`)
3. AgentGrid component (receives `agents` as prop → 9 grid cells)
4. Each grid cell renders a `PixelFace` canvas component
5. Canvas components run `requestAnimationFrame` loops — if they unmount/remount, the animation restarts

The `React.memo` wrapper on PixelFace/EggHatch (commit `fc09f59`) should prevent step 4-5 from re-rendering, but the cascade through steps 1-3 still happens. And crucially, if `agents` is a new array reference every time (which `useMemo` would produce if `agentDocs` reference changes), then AgentGrid gets a new prop and re-renders all children regardless of memo.

## What Main Does Differently

On `main`, the SSE event handler effect had deps `[streaming, sessionActive, serverSessionId, database, getAuthHeaders, refreshMenuData, activeAgent]` — it included `activeAgent` but **not** `agentDocs`. The event handlers read `agentDocs` directly but since it wasn't in the deps array, the effect didn't re-register. This was technically a stale closure bug (reading stale `agentDocs`) but it meant the cascade didn't happen.

Also on `main`:
- No `jobView`/`selectedJob`/`jobDraft` state in App
- No `julian:send-chat` listener
- No `[UI_ACTION]` marker stripping
- `displayMessages` useMemo had deps `[persistedMessages, liveAssistant, activeAgent]` (no `agentDocs`) — same as current, but `sendMessage` deps included `activeAgent` and the full dep chain was shorter

## What main DOESN'T have

The `main` branch has no jobs feature at all. The jobs UI (JobsPanel, job creation form, "Offer Work" button, `[UI_ACTION]` protocol, `julian:send-chat` event) was all added in `post-hackathon`. Any fix needs to preserve the jobs feature.

## Key Files

- **`index.html`** (~1,177 lines) — App component, boot sequence, event handlers, all hooks
- **`chat.jsx`** (~1,133 lines) — PixelFace, EggHatch, AgentGrid, ChatInput, MessageBubble, JobsPanel
- **`vibes.jsx`** (~1,878 lines) — UI primitives (unlikely involved)
- **`server/server.ts`** — Bun server, SSE streaming (server-side, unlikely involved)

## Recommended Investigation

1. **Profile in Chrome DevTools** — Record a Performance trace while the app is running with agents. Look for excessive React reconciliation or canvas operations. The "Timings" lane will show React commit phases.

2. **Check if `useLiveQuery` causes referential instability** — Does `useLiveQuery("type", { key: "agent-identity" })` return the same array reference when no docs changed? If it always returns a new array, every subscriber re-renders on every Fireproof write (even unrelated writes like message persistence). This would be the root cause.

3. **Consider splitting App** — The real fix may be extracting the agent grid, chat panel, and jobs panel into separate components with their own `useLiveQuery` subscriptions, so a Fireproof write to messages doesn't re-render the agent grid and vice versa.

4. **Test by reverting to main + cherry-picking jobs** — The cleanest diagnostic would be: start from `main`, add only the jobs feature (JobsPanel component + jobView state + UI_ACTION protocol), and see if performance degrades. If it does, the state lifting is the cause. If not, one of the other 30+ commits on `post-hackathon` introduced the regression.

5. **Check the `agents` useMemo** — If `agentDocs` reference changes on every Fireproof write, `agents` recomputes, producing a new array, which forces AgentGrid to re-render all 9 children. Even with `React.memo` on PixelFace, the grid cell wrappers (divs with onClick handlers and inline styles) would still re-render.

## Current State of the Branch

```
fc09f59 Memoize canvas components + ref-ify useCallbacks to fix frame drops  ← HEAD
c2368b1 Break agentDocs render loop causing 5s web inspector delay
712dccc Fix render cascade in julian:send-chat listener
c94522f Fix job form usability: lift state to App, add [UI_ACTION] protocol  ← SUSPECT
2123a68 Bump self-healing boot timeout from 5s to 15s
0772581 Fix vanishing messages in multi-turn conversations
988871e Fix duplicate messages: only persist on final result event
... (20+ more commits on post-hackathon)
```

The branch is deployed to `julian-edge.exe.xyz` at commit `fc09f59`. Production (`julian.exe.xyz`) is still on `main`.
