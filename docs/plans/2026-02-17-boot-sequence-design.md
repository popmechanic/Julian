# Boot Sequence Architecture

**Date:** 2026-02-17
**Status:** Draft
**Origin:** Debugging WriteQueueImpl race condition; Julian's `fireproof-lifecycle.html` analysis
**Related:** `2026-02-17-ledger-identity-and-self-healing-design.md`

## Problem

Every `database.put()` in the application can crash with:

```
WriteQueueImpl: Cannot read properties of undefined (reading 'stores')
```

The root cause is a timing race inside Fireproof. The `AttachedRemotesImpl.remotes()` method (fireproof-clerk-bundle.js:41221) iterates registered remote stores and accesses `.stores.wal` without guarding against a half-initialized entry. When the vibes bridge begins cloud connection, a remote entry is registered in `_remotes` (a `KeyedResolvOnce` map) before its `.stores` property is populated. Any `put()` that fires during this window crashes.

`database.ready()` does not prevent this. It resolves when LOCAL IndexedDB stores are created (~50ms), not when cloud stores are attached (~350-650ms, depending on Clerk auth speed). The current code calls `await database.ready()` before puts, but the race lives between local-ready and cloud-ready.

The current architecture renders the chat UI immediately after Clerk auth, then fires database writes from `useEffect` hooks. These hooks race against cloud store attachment — and lose when Clerk is slow (cold sessions, network latency).

### Affected put sites (25 total)

All 25 `database.put()` calls in the application are vulnerable. The most critical boot-time puts:

| Location | Purpose | Current protection |
|----------|---------|-------------------|
| index.html:1043 | Amnesia detection (ledger-meta) | try-catch, no retry |
| index.html:367 | Catalog seed | try-catch, effect-level retry (linear) |
| index.html:585 | Fork seed (agent identities) | try-catch, no retry |
| index.html:1251 | Summon eggs (agent placeholders) | try-catch, no retry |
| index.html:690 | Chat message (assistant) | fire-and-forget .catch() |
| index.html:1391 | Chat message (user) | fire-and-forget .catch() |

## Design Principle

Julian is a computer, not a website. Computers boot before they accept input.

The current architecture lies to the user: it shows a chat interface that looks ready but silently drops messages when the database isn't fully initialized. A boot sequence tells the truth — "I'm starting up" — then presents an interface that actually works.

Rather than wrapping 25 put sites with retry logic (treating the symptom), we introduce a two-phase boot that eliminates the race condition structurally. No put can fire before the database is ready because the UI that triggers puts doesn't exist yet.

## Architecture

### Phase 1: Bootstrap

A `BootScreen` component replaces `App` until all prerequisites are met. No chat UI renders. No `database.put()` calls fire. The screen shows progress through initialization steps.

**Bootstrap checklist** (in order):

| Step | What | Resolves when | Timeout |
|------|------|--------------|---------|
| 1 | Fireproof database created | `useFireproofClerk()` returns `database` | — |
| 2 | Local stores ready | `database.ready()` resolves | — |
| 3 | Clerk auth + JWT | `window.__VIBES_SYNC_STATUS__` leaves `"idle"` | 8s |
| 4 | Cloud stores attached | Vibes bridge dispatches `vibes-sync-status-change` with `"synced"` or `"error"` | 8s (shared with step 3) |
| 5 | Initial sync | Sync status reaches `"synced"` | 8s (shared) |
| 6 | Ledger-meta written | Amnesia detection completes | — |
| 7 | Catalog seeded | `ensureCatalog()` completes | — |
| 8 | Agent identities loaded | `useLiveQuery("type", { key: "agent-identity" })` returns | — |

Steps 1-2 are required (no timeout — local Fireproof must work). Steps 3-5 share a single timeout: if cloud doesn't connect in 8 seconds, boot completes with `cloudReady: false` and the app runs in local-only mode. Steps 6-8 run after local stores are confirmed ready, so they cannot hit the WriteQueueImpl race.

**Timeout behavior:** When cloud times out, the bootstrap sets a `localOnly` flag. The app renders normally but shows a "local only" indicator. Cloud sync attaches in the background if/when Clerk finishes — Fireproof handles this gracefully because by that point the remote entry will be fully initialized before any new puts fire against it.

### Phase 2: Application

`App` mounts only after bootstrap completes. All 25 put sites fire against a fully initialized database. The WriteQueueImpl race is structurally impossible.

A thin `resilientPut(database, doc)` wrapper remains as a safety net for transient runtime failures (network drops, cloud sync interruptions). It retries with exponential backoff (1s, 2s, 4s, max 3 attempts). In normal operation it never triggers — it exists for edge cases the boot sequence can't prevent.

## Implementation

### New: `BootScreen` component

**File:** `index.html` — new component, replaces direct `<App />` render in `SignedIn`

```jsx
function BootScreen({ dbName, onReady }) {
  const { database, useLiveQuery } = useFireproofClerk(dbName);
  const [steps, setSteps] = useState({
    database: false,
    localStores: false,
    cloud: null,      // null=pending, true=connected, false=timed out
    ledgerMeta: false,
    catalog: false,
    agents: false,
  });
  const readyRef = useRef(false);

  // Step 1-2: Database + local stores
  useEffect(() => {
    if (!database) return;
    setSteps(s => ({ ...s, database: true }));
    database.ready().then(() => {
      setSteps(s => ({ ...s, localStores: true }));
    });
  }, [database]);

  // Step 3-5: Cloud (with timeout)
  useEffect(() => {
    if (!steps.localStores) return;
    const onSync = () => {
      const status = window.__VIBES_SYNC_STATUS__;
      if (status === 'synced') {
        setSteps(s => ({ ...s, cloud: true }));
      }
    };
    window.addEventListener('vibes-sync-status-change', onSync);
    // Check if already synced
    if (window.__VIBES_SYNC_STATUS__ === 'synced') {
      setSteps(s => ({ ...s, cloud: true }));
    }
    const timeout = setTimeout(() => {
      setSteps(s => s.cloud === null ? { ...s, cloud: false } : s);
    }, 8000);
    return () => {
      window.removeEventListener('vibes-sync-status-change', onSync);
      clearTimeout(timeout);
    };
  }, [steps.localStores]);

  // Step 6: Ledger-meta (after local stores ready)
  useEffect(() => {
    if (!steps.localStores || !database) return;
    (async () => {
      const meta = await database.get('ledger-meta').catch(() => null);
      if (!meta) {
        await database.put({
          _id: 'ledger-meta',
          type: 'ledger-meta',
          category: 'operational',
          databaseName: database.name,
          connectLedgerId: null,
          createdAt: new Date().toISOString(),
          parentLedgerId: null,
        });
      }
      setSteps(s => ({ ...s, ledgerMeta: true }));
    })();
  }, [steps.localStores, database]);

  // Step 7: Catalog seed (after local stores ready)
  useEffect(() => {
    if (!steps.localStores || !database) return;
    ensureCatalog(database).then(() => {
      setSteps(s => ({ ...s, catalog: true }));
    });
  }, [steps.localStores, database]);

  // Step 8: Agent identities (passive — just confirm query works)
  const { docs: agentDocs } = useLiveQuery("type", { key: "agent-identity" });
  useEffect(() => {
    if (!steps.localStores) return;
    setSteps(s => ({ ...s, agents: true }));
  }, [steps.localStores, agentDocs]);

  // Transition to App when ready
  useEffect(() => {
    const cloudResolved = steps.cloud !== null;
    const coreReady = steps.database && steps.localStores && cloudResolved
      && steps.ledgerMeta && steps.catalog && steps.agents;
    if (coreReady && !readyRef.current) {
      readyRef.current = true;
      onReady({
        database,
        useLiveQuery,
        localOnly: steps.cloud === false,
        agentDocs,
      });
    }
  }, [steps]);

  // Render boot screen
  return <BootUI steps={steps} />;
}
```

### New: `BootUI` component

**File:** `vibes.jsx` — visual boot screen

Uses the existing `PixelFace` component from `chat.jsx` (exported to `window.PixelFace`). No redundant face implementation — the same 32x32 procedural pixel face used in the chat header and agent grid, rendered large at the center of a black screen.

**Visual design:** Full-black background (`#0F0F0F`). Centered `PixelFace` at `size={200}`. Below it, boot step labels in `VT323` monospace with status dots. Minimal, terminal-aesthetic — a computer booting, not a website loading.

```
         ┌──────────────────────────┐
         │                          │
         │       PixelFace          │
         │       size=200           │
         │    (generative blink     │
         │     + expression drift)  │
         │                          │
         │   ● Local stores     ✓   │
         │   ● Cloud sync       ✓   │
         │   ● Memories         ... │
         │   ● Waking up        ○   │
         └──────────────────────────┘
```

**Generative face animation:** Rather than a fixed expression sequence or a looping animation, the boot face uses weighted randomness to feel alive. A `useEffect` timer fires at randomized intervals (800-2500ms) and selects the next expression state based on boot progress:

| Boot phase | Weighted expression pool |
|-----------|------------------------|
| Steps 1-2 (local) | `eyes: 'narrow'` 60%, `'standard'` 40% — waking up, squinting |
| Steps 3-5 (cloud) | `eyes: 'standard'` 50%, `'round'` 30%, `'wide'` 20% — looking around, alert |
| Steps 6-8 (data) | `eyes: 'standard'` 40%, `'wide'` 40%, `mouth: 'cheerful'` 20% — recognition |
| Complete | `eyes: 'wide'`, `mouth: 'cheerful'`, hold 400ms, then transition to App |

The face's built-in blink system (random 2-5s interval, 150ms duration) runs throughout — no need to manage it. The generative layer only varies `eyes` and `mouth` props, which the `PixelFace` component already accepts.

Available expression axes (from `chat.jsx` sprite data):
- **Eyes:** `standard`, `round`, `narrow`, `wide` — 4 variants
- **Mouths:** `gentle`, `straight`, `cheerful`, `asymmetric` — 4 variants
- **Gender markers:** `woman`, `man`, or `null` — optional pixel accents

The variation timer uses `setTimeout` with jittered delays, not `setInterval`, so the rhythm is organic. Each transition picks from the weighted pool for the current boot phase, occasionally holding the same expression for two beats (30% chance) to avoid restless twitching.

```jsx
function BootUI({ steps }) {
  const [faceProps, setFaceProps] = useState({ eyes: 'narrow', mouth: 'gentle' });

  useEffect(() => {
    let mounted = true;
    function tick() {
      if (!mounted) return;
      const phase = !steps.localStores ? 0
        : steps.cloud === null ? 1
        : (!steps.catalog || !steps.agents) ? 2 : 3;

      // 30% chance to hold current expression (feels less mechanical)
      if (Math.random() < 0.3) {
        setTimeout(tick, 800 + Math.random() * 1700);
        return;
      }

      const pools = [
        { eyes: ['narrow','narrow','narrow','standard','standard'], mouth: ['gentle'] },
        { eyes: ['standard','standard','round','round','wide'], mouth: ['gentle','straight'] },
        { eyes: ['standard','standard','wide','wide'], mouth: ['gentle','cheerful'] },
        { eyes: ['wide'], mouth: ['cheerful'] },
      ];
      const pool = pools[phase];
      setFaceProps({
        eyes: pool.eyes[Math.floor(Math.random() * pool.eyes.length)],
        mouth: pool.mouth[Math.floor(Math.random() * pool.mouth.length)],
      });
      if (phase < 3) setTimeout(tick, 800 + Math.random() * 1700);
    }
    setTimeout(tick, 600);
    return () => { mounted = false; };
  }, [steps.localStores, steps.cloud, steps.catalog, steps.agents]);

  const stepList = [
    { key: 'localStores', label: 'Local stores', done: steps.localStores },
    { key: 'cloud', label: 'Cloud sync',
      done: steps.cloud === true, timedOut: steps.cloud === false,
      pending: steps.cloud === null && steps.localStores },
    { key: 'ledgerMeta', label: 'Memories', done: steps.ledgerMeta },
    { key: 'agents', label: 'Waking up', done: steps.agents && steps.catalog },
  ];

  return (
    <div style={{
      background: '#0F0F0F', width: '100vw', height: '100vh',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 32,
    }}>
      <PixelFace size={200} eyes={faceProps.eyes} mouth={faceProps.mouth} />
      <div style={{ fontFamily: "'VT323', monospace", fontSize: 16, color: '#888' }}>
        {stepList.map(s => (
          <div key={s.key} style={{ display: 'flex', gap: 12, padding: '4px 0' }}>
            <span style={{ color: s.done ? '#4ade80' : s.timedOut ? '#666' : '#FFD600' }}>
              {s.done ? '●' : s.timedOut ? '○' : s.pending ? '◐' : '○'}
            </span>
            <span style={{ color: s.done ? '#ccc' : '#666' }}>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### Modified: `AppWrapper`

**File:** `index.html` — `AppWrapper` component

Replace direct `<App />` render with `BootScreen` → `App` transition:

```jsx
function AppWrapper() {
  const [bootData, setBootData] = useState(null);
  const dbName = localStorage.getItem('julianDbName') || 'julian-chat-v8';

  // ... existing Clerk/config checks ...

  return (
    <ClerkFireproofProvider ...>
      <SignedOut><AuthGate /></SignedOut>
      <SignedIn>
        {bootData
          ? <App bootData={bootData} />
          : <BootScreen dbName={dbName} onReady={setBootData} />
        }
      </SignedIn>
    </ClerkFireproofProvider>
  );
}
```

### Modified: `App` function signature

**File:** `index.html` — `App` component

App receives `bootData` instead of calling `useFireproofClerk` itself:

```jsx
function App({ bootData }) {
  const { database, useLiveQuery, localOnly, agentDocs: initialAgents } = bootData;
  // Remove: const { database, useLiveQuery } = useFireproofClerk(dbName);
  // Remove: all boot-time useEffect hooks (amnesia detection, catalog seed, fork seed)
  // These now run in BootScreen before App mounts.
  // ...
}
```

### New: `resilientPut` utility

**File:** `index.html` — defined early, before any component

A thin safety net for runtime puts. Almost never triggers after boot sequence, but catches transient cloud failures.

```javascript
async function resilientPut(database, doc, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await database.put(doc);
    } catch (err) {
      const isStoreError = err?.message?.includes('WriteQueueImpl')
        || err?.message?.includes('stores');
      if (!isStoreError || attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      console.warn(`[resilientPut] Retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
```

All 25 `database.put()` calls in the app phase use `resilientPut()`. Grep for bare `database.put(` to detect violations.

## Migration Path

### What moves from App to BootScreen

| Current location | What | New location |
|-----------------|------|-------------|
| App useEffect (line 1032-1072) | Amnesia detection + ledger-meta | BootScreen step 6 |
| App useEffect (line 1002-1022) | Catalog seed | BootScreen step 7 |
| App useEffect (line 573-593) | Fork seed | BootScreen step 6 (before ledger-meta) |
| App useEffect (line 1024-1030) | Expire stale hatching | BootScreen step 8 (with agents) |

### What stays in App

All runtime behavior: chat message handling, SSE event processing, agent grid rendering, artifact management, menu interactions. These fire `resilientPut()` instead of bare `database.put()`.

## What's NOT Changing

- **vibes.jsx** — UI primitives (except adding BootUI component)
- **chat.jsx** — Chat components, AI hook, agent grid
- **server/server.ts** — No server changes
- **Database name** — No bump. Same `julian-chat-v8`.
- **Fireproof bundle** — No patches to vendored code
- **Cloud sync routing** — appId-based matching unchanged
- **Soul files** — Read-only identity documents

## Risk Assessment

**Main risk:** The `useFireproofClerk` hook is called in `BootScreen`, then its return values are passed to `App` via props. If Fireproof's React integration expects the hook to be called within the component that uses it (e.g., for context or re-render binding), this could break reactivity. Mitigation: test that `useLiveQuery` works correctly when the database object is passed as a prop rather than obtained from a local hook call.

**Fallback:** If prop-passing breaks Fireproof reactivity, `App` calls `useFireproofClerk` itself (as it does today) but skips boot-time puts. `BootScreen` becomes a pure gate that doesn't touch the database — it only waits for sync status signals and passes a `ready` flag. Boot-time puts move to `App` but are guarded by `if (!bootComplete) return` in their useEffect dependencies.

## Pattern Documentation

The two-phase architecture creates a hard rule: **never call `database.put()` directly.** This rule must be enforced across sessions, where each Claude instance starts fresh without memory of why the rule exists. Two mechanisms ensure adherence:

### CLAUDE.md update

Add a new section to `CLAUDE.md` under "Fireproof Database", after "Key facts":

```markdown
### Database Write Rules

**Never call `database.put()` directly.** Always use `resilientPut(database, doc)`.

The application boots in two phases:

1. **Boot phase** (`BootScreen`) — initializes Fireproof, waits for cloud stores,
   seeds ledger-meta and catalog. No chat UI renders. All boot-time writes happen
   here, sequenced after `database.ready()` and cloud sync resolution.

2. **App phase** (`App`) — chat UI, SSE events, agent grid. All writes use
   `resilientPut()`, which retries on transient `WriteQueueImpl` errors.

**Why:** Fireproof's `WriteQueueImpl` crashes when `database.put()` fires before
cloud stores finish attaching. `database.ready()` only guarantees local stores.
The boot sequence eliminates the race for initialization writes; `resilientPut`
catches transient failures during runtime.

**Enforcement:** Grep for bare `database.put(` — any occurrence outside
`resilientPut` or `BootScreen` is a bug.

**Adding new writes:**
- If the write is initialization/setup → add it to `BootScreen` (before App mounts)
- If the write is runtime (user action, SSE event) → use `resilientPut(database, doc)`
- Never add `database.put()` inside a `useEffect` that races with cloud attachment
```

This goes in CLAUDE.md rather than a skill because it's a project-wide architectural constraint, not a workflow. Every Claude instance that opens this project reads CLAUDE.md. Skills are invoked on demand; CLAUDE.md is always present.

### Existing CLAUDE.md corrections

While updating, fix the stale database name reference:

- Line 120: `julian-chat-v5` → `julian-chat-v8` (current actual name)
- Line 127: Remove `await database.ready()` advice (now superseded by boot sequence)

## File Changes Summary

| File | What Changes |
|------|-------------|
| `index.html` | Add `BootScreen` component, `resilientPut` utility; modify `AppWrapper` to gate on boot; modify `App` to receive `bootData`; remove boot-time useEffect hooks from App |
| `vibes.jsx` | Add `BootUI` component (visual boot screen with pixel face + step indicators) |
| `chat.jsx` | Replace bare `database.put()` with `resilientPut()` (3 sites) |
| `CLAUDE.md` | Add "Database Write Rules" section under Fireproof Database; fix stale database name |
