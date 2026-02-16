# Agent Teams Implementation — Prompt for Implementation Agent

## Context

You're picking up implementation work on the Julian project's "Agent Teams" feature. This feature adds 8 AI agent teammates to Julian's browser interface — each with their own pixel face, chosen name, color, and identity. The system uses Claude Code's Agent Teams (TeamCreate/SendMessage) for backend coordination and Fireproof for persistence.

## Key Documents

Read these two files before writing any code:

1. **Design spec**: `docs/plans/2026-02-15-agent-teams-design.md`
   The full system design — summoning ceremony, face variations, chat routing, persistence, re-awakening protocol, jobs system. This is the source of truth for what we're building.

2. **Prior implementation patch**: `agent-teams-uncommitted.patch` (in project root)
   ~745 lines of work from a previous session. This patch was written against an **old file structure** that no longer exists (`app.jsx` → now `chat.jsx`, `server.ts` → now `server/server.ts`). It cannot be applied directly, but contains substantial working code that should be evaluated for reuse.

## What the Patch Contains

The patch has three sections. Review each and decide whether to port directly, adapt, or rewrite:

### 1. CLAUDE.md additions (lines 1–80 of patch)
Agent message routing protocol and summoning protocol (TeamCreate, spawn prompts, Fireproof persistence). These are instructions for Julian's Claude session, not application code. **Likely reusable as-is** — just needs to be added to the current `CLAUDE.md`, which has been restructured since the patch was written.

### 2. chat.jsx components (lines 81–943 of patch, targeting old `app.jsx`)
This is the bulk of the work. Four major additions:

- **PixelFace variant system** (~120 lines): `EYE_VARIANTS` (4 shapes), `MOUTH_VARIANTS` (4 shapes with idle/talk1/talk2 frames), `GENDER_MARKERS` (eyelashes for women, brows for men), `AGENT_COLORS` array, `hashNameToFaceVariant()` function. The existing `PixelFace` component gains `color`, `eyes`, `mouth`, `gender` props. **This is pixel-level sprite data that was carefully authored — strongly favor direct reuse.** Verify it still integrates with the current `PixelFace` component in `chat.jsx`.

- **EggHatch component** (~100 lines): 32x32 canvas animation with 6 phases (appear → stillness → wobble → crack → split → reveal, ~3s total). Standalone component, no external dependencies. **Should port cleanly.**

- **AgentGrid component** (~130 lines): 3x3 CSS grid, Julian at center (position 4), cell states (empty/hatching/active/dormant/selected), SUMMON button. **Review against current layout** — the sidebar structure may have changed.

- **AgentFaceHeader component** (~45 lines): Shows agent face + name in their color when chatting with an agent, with back button to Julian. **Review against current sidebar header.**

- **App state integration** (~100 lines): `activeAgent`, `summoning` state, per-agent message scoping via `messagePrefix`, `useLiveQuery` for agent identities, `handleSelectAgent`, `handleSummon`, modified `sendMessage` to include `targetAgent` and scope messages by agent name. **This is the most likely section to need rewriting** — it depends on the `App` component structure which has changed significantly.

### 3. server/server.ts changes (lines 946–988 of patch, targeting old `server.ts`)
Two additions: (a) `targetAgent` field in the chat endpoint, prepending `[ROUTE TO AGENT: name]` prefix, and (b) new `POST /api/agents/summon` endpoint. **The logic is simple and correct, but the server file has been substantially rewritten and moved to `server/server.ts`.** Find the equivalent locations in the current server code and adapt.

## Current Codebase Structure

The frontend is split into three files with no build step (in-browser Babel):

| File | What's in it |
|------|-------------|
| `vibes.jsx` | Auto-generated vibes components (icons, panels, auth). ~1,878 lines. Don't modify. |
| `chat.jsx` | Chat components: PixelFace, StatusDots, JulianScreenEmbed, MessageBubble, ChatInput, etc. ~1,133 lines. **This is where the patch's component code belongs.** |
| `index.html` | HTML shell, CSS, App component, AppWrapper, initApp. ~1,177 lines. **App state integration goes here.** |
| `server/server.ts` | Bun server with Claude subprocess, SSE streaming, Clerk auth. **Server changes go here.** |

Load order: `vibes.jsx` → `chat.jsx` → inline App script in `index.html`. Components export to `window.*` for cross-script access.

## Implementation Plan

Work in this order (each step should be testable):

### Phase 1: Port the component code
1. Read `chat.jsx` — find the current `PixelFace` component
2. Port `EYE_VARIANTS`, `MOUTH_VARIANTS`, `GENDER_MARKERS`, `AGENT_COLORS`, `hashNameToFaceVariant()` from the patch
3. Modify `PixelFace` to accept `color`, `eyes`, `mouth`, `gender` props (as the patch does)
4. Port `EggHatch`, `AgentGrid`, `AgentFaceHeader` components
5. Export new components to `window.*` so `index.html` can use them

### Phase 2: Integrate into App state
1. Read `index.html` — find the `App` component
2. Add `activeAgent`, `summoning` state
3. Add per-agent message scoping (the `messagePrefix` pattern from the patch)
4. Add `useLiveQuery` for `agent-identity` documents
5. Add `handleSelectAgent`, `handleSummon` callbacks
6. Modify `sendMessage` to include `targetAgent`
7. Render `AgentGrid` in the sidebar
8. Conditionally render `AgentFaceHeader` vs Julian's header based on `activeAgent`

### Phase 3: Server endpoints
1. Read `server/server.ts` — find the chat endpoint
2. Add `targetAgent` field parsing and `[ROUTE TO AGENT: name]` prefix
3. Add `POST /api/agents/summon` endpoint

### Phase 4: CLAUDE.md protocol
1. Add the agent message routing instructions to `CLAUDE.md`
2. Add the summoning protocol (TeamCreate, spawn prompts, Fireproof persistence)

## Important Notes

- **No build system.** Everything runs through Babel standalone in the browser. Don't introduce imports, bundlers, or module syntax.
- **Fireproof database name**: `"claude-hackathon-chat"`
- **Cross-script communication**: Components in `chat.jsx` must be assigned to `window` (e.g., `window.AgentGrid = AgentGrid`) to be accessible from `index.html`'s App component.
- **Don't touch `vibes.jsx`** — it's auto-generated.
- The design spec is ambitious (summoning, jobs, re-awakening). Focus on **summoning + chat routing** first. Jobs and re-awakening are future phases.
