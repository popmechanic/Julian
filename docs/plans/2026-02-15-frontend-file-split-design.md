# Frontend File Split

**Date:** 2026-02-15
**Status:** Design approved, ready for implementation

## Problem

`index.html` grew to ~4,171 lines — past the 25K token read limit. Every edit
requires multiple partial reads and loses the holistic view that makes
single-file development efficient for AI agents.

## Solution

Split into three files, each under 2,000 lines, loaded via in-browser Babel
script tags. No build step, no new dependencies.

---

## File Structure

| File | Contents | ~Lines | Role |
|---|---|---|---|
| `vibes.jsx` | Auto-generated vibes components: icons, style utilities, BrutalistCard, LabelContainer, AuthScreen, VibesSwitch, HiddenMenuWrapper, VibesButton, VibesPanel | ~1,871 | UI library (rarely changes) |
| `chat.jsx` | useAI hook, error components, markdown utils, PixelFace, StatusDots, JulianScreenEmbed, ThinkingDots, ToolCallBlock, MessageBubble, SetupScreen, ChatInput | ~1,100 | Chat UI components |
| `index.html` | HTML shell, CSS, imports, script tags, App component, AppWrapper, initApp | ~1,200 | Orchestration + entry point |

---

## Extraction Mechanics

1. Cut vibes component block (lines 240-2111) into `vibes.jsx`
2. Cut chat component block (lines 2114-3236) into `chat.jsx`
3. Add `window.*` exports at the bottom of `chat.jsx` for every component/function
   the App references
4. Update App to destructure from `window.*` instead of same-scope access
5. Add two script tags in `index.html` before the App's inline script:

```html
<script type="text/babel" src="/vibes.jsx"></script>
<script type="text/babel" src="/chat.jsx"></script>
```

Babel processes script tags in document order. Load order is guaranteed.

---

## Serving

The Bun server already serves any file from WORKING_DIR via its static file
handler. No server changes needed.

## Vibes Skill Impact

The vibes skill generates components into `index.html`. After this split, vibes
components live in `vibes.jsx`. If the skill regenerates, move output to
`vibes.jsx`. Add a note to CLAUDE.md documenting the layout.

## Deploy Impact

`rsync` in the deploy skill syncs all root files. `vibes.jsx` and `chat.jsx`
in the project root are picked up automatically.

---

## Design Decisions

| Decision | Chosen | Alternatives considered |
|---|---|---|
| Load method | Separate .jsx + Babel script tags | Pre-bundled .js (adds build step), inline script blocks (doesn't help read limit) |
| Number of files | 3 | 2 (vibes + everything else — still tight on index.html size) |
| SetupScreen location | chat.jsx | index.html (tightly coupled to auth state, but simpler rule: all components in chat.jsx) |
| Vibes skill update | CLAUDE.md note only | Modify skill assembly step (over-engineering for now) |
