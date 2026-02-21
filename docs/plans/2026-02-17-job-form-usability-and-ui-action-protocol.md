# Job Form Usability & UI_ACTION Protocol

## Problem

Two issues with the new job form:

1. **Brittle form state.** The form vanishes on window resize, inspector toggle, or tab switch. Its state lives in `useState` inside components that unmount when `AnimatePresence` re-keys the overlay.

2. **Broken Help Me feature.** The Help Me button does a parallel `fetch` to `/api/chat` and tries to parse its own SSE stream. The SSE event shapes have drifted, so parsing fails silently. Julian's response also flows through the main SSE stream, so the user sees a raw JSON blob in chat instead of the form filling in.

## Design

### 1. `[UI_ACTION]` Marker Protocol

Julian already embeds structured markers in SSE responses (`[AGENT_REGISTERED]`, `[AGENT_STATUS]`). Extend this pattern with a general-purpose `[UI_ACTION]` marker for DOM communication.

**Format:**
```
[UI_ACTION] {"target":"job-form","action":"fill","data":{"name":"Research Assistant","description":"..."}}
```

**Browser handling (SSE text handler in `index.html`):**
- Detect `[UI_ACTION]` lines in the SSE text stream (same scan that finds `[AGENT_REGISTERED]`)
- Parse the JSON payload
- Dispatch: `window.dispatchEvent(new CustomEvent('julian:ui-action', {detail: parsed}))`
- Strip the marker line from rendered chat text (Julian's natural language stays visible)

**Component subscription:**
```jsx
useEffect(() => {
  const handler = (e) => {
    if (e.detail.target === 'job-form' && e.detail.action === 'fill') {
      // merge e.detail.data into form fields
    }
  };
  window.addEventListener('julian:ui-action', handler);
  return () => window.removeEventListener('julian:ui-action', handler);
}, []);
```

This gives Julian general DOM communication through the existing SSE channel. Future actions (navigate tabs, highlight elements, trigger animations) just need a new handler registration — no new endpoints.

### 2. Lift Form State to App

Move three pieces of state from `JobsPanel`/`JobForm` up to the `App` component:

```jsx
const [jobView, setJobView] = useState('list');
const [selectedJob, setSelectedJob] = useState(null);
const [jobDraft, setJobDraft] = useState(null);
```

`JobsPanel` becomes controlled — reads view/selection/draft from props, calls setters to update. `JobForm` reads from and writes to `jobDraft` via props.

When the user switches tabs, `JobsPanel` unmounts but draft state is preserved in App. On remount, the form picks up exactly where it was.

Draft lifecycle:
- "New Job" click → `setJobDraft({name:'', description:'', contextDocs:'', skills:'', files:'', aboutYou:''})`
- Form edits → `setJobDraft(prev => ({...prev, [field]: value}))`
- Save/Cancel → `setJobDraft(null)`, `setJobView('list')`

### 3. Help Me Flow (End to End)

1. User clicks **Help Me**
2. `JobForm` sets `helping=true`, dispatches:
   ```js
   window.dispatchEvent(new CustomEvent('julian:send-chat', {
     detail: { message: '[JOB HELP] ' + JSON.stringify(formState) }
   }))
   ```
3. `App` listens for `'julian:send-chat'` events and feeds the message into its existing `sendMessage` handler — same path as user-typed messages, one fetch, one SSE stream
4. Server forwards to Julian's stdin with `[JOB HELP]` prefix
5. Julian reads form state, generates suggestions, responds:
   ```
   I looked at what you have so far and filled in some suggestions...

   [UI_ACTION] {"target":"job-form","action":"fill","data":{"name":"Research Assistant","description":"Compile and summarize..."}}
   ```
6. SSE handler parses marker, strips it, dispatches `julian:ui-action` CustomEvent
7. `JobForm`'s `useEffect` listener receives the event, fills empty fields, sets `helping=false`
8. Julian's natural language appears in chat normally

Safety: if no `ui-action` event arrives within 30s, `helping` resets to `false` (timeout).

### 4. CLAUDE.md Update

Replace the "Job Help Requests" section to instruct Julian to emit `[UI_ACTION]` markers instead of JSON code blocks.

## Changes

### `chat.jsx`

- **JobForm**: Remove `handleHelp`'s direct fetch + SSE parsing. Replace with CustomEvent dispatch (`julian:send-chat`). Add `useEffect` listener for `julian:ui-action` events targeting `job-form`. Remove local state for six fields — receive `draft`/`setDraft` as props.
- **JobsPanel**: Remove local `view`, `selectedJob` state. Receive as props from App. Pass `jobDraft`/`setJobDraft` through to JobForm.

### `index.html`

- **App component**: Add `jobView`, `selectedJob`, `jobDraft` state. Pass as props to JobsPanel. Add `julian:send-chat` event listener that calls sendMessage.
- **SSE handler**: Add `[UI_ACTION]` marker detection alongside existing `[AGENT_REGISTERED]`/`[AGENT_STATUS]` parsing. Dispatch CustomEvent, strip marker from rendered text.

### `CLAUDE.md`

- Update "Job Help Requests" section: Julian should emit `[UI_ACTION] {"target":"job-form","action":"fill","data":{...}}` instead of a JSON code block. Include natural language response alongside the marker.
