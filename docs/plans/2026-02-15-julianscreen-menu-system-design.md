# JulianScreen Menu System Design

A new menu mode for the 128x96 pixel JulianScreen display: a three-tab interface (Browser, Skills, Agents) with a scrollable icon grid, folder/file navigation, and filesystem-mirrored content.

## Motivation

JulianScreen currently serves as an expressive avatar display driven by agent commands. This adds a second mode: an interactive menu system that lets users browse Julian's memory artifacts, inspect installed skills, and view active agent teams — all rendered in pixel art on the same 128x96 canvas.

The Browser tab replaces the old `ArtifactViewer` React component (removed in `4d786f1`) by rebuilding file browsing inside the pixel screen itself.

## Architecture

### Client-side menu module

A new `julianscreen/client/menu.js` module owns the entire menu system. It runs client-side with no server round-trips for navigation — clicking a tab or folder is instant.

When menu mode is active, `menu.js`:
- Takes over the **draw layer** and **UI layer**, hides the avatar
- Maintains local state: current tab, directory path, scroll offset, item list
- Intercepts clicks before the existing `input.js` handler
- Renders the tab bar, breadcrumb, icon grid, scrollbar, and labels
- Emits **feedback events** for meaningful actions (file selected, tab changed)

When menu mode is inactive, the screen behaves exactly as before (avatar, backgrounds, buttons, etc.).

### New protocol commands

Three new commands added to `server/protocol.js`:

| Command | Args | Effect |
|---------|------|--------|
| `MENU <tab>` | `browser`, `skills`, `agents` | Enter menu mode on the specified tab |
| `MENU_NAV <path>` | Directory path string | Navigate to a specific directory within the current tab |
| `MENU_EXIT` | None | Exit menu mode, restore normal avatar display |

These let agents programmatically enter/exit the menu and navigate to specific paths.

### New feedback events

| Event | Payload | When |
|-------|---------|------|
| `FILE_SELECT` | `{"type":"FILE_SELECT","tab":"browser","file":"naming.html","path":"memory/"}` | User clicked a file icon |
| `MENU_TAB` | `{"type":"MENU_TAB","tab":"skills"}` | User switched tabs |

Feedback events are sent via the existing WebSocket feedback channel and queued at `GET /feedback` for agent polling.

### Integration with JulianScreenEmbed

The `JulianScreenEmbed` React component (chat.jsx:340-505) gains two responsibilities:

1. **Data provider**: Fetches file listings from API endpoints and passes them to `JScreen.setMenuData()`. The component has Clerk auth context, so it can call authenticated endpoints.

2. **File open handler**: Listens for `FILE_SELECT` feedback events. When the Browser tab emits a file selection, the React component loads that file in the existing artifact viewer iframe.

## Pixel Layout

```
128px wide x 96px tall

y=0-9:   TAB BAR (10px)
         ┌───────────────┬────────────┬─────────────┐
         │    BROWSER    │   SKILLS   │   AGENTS    │
         └───────────────┴────────────┴─────────────┘
y=10:    SEPARATOR LINE (1px, pink/magenta, palette 7)
y=11-18: BREADCRUMB BAR (8px)
         Current path or "< back" navigation
y=19-95: CONTENT AREA (77px)
         ┌──────────────────────────────────┬─────┐
         │                                  │  ▲  │
         │  3-column icon grid              │  █  │
         │  (x=0 to x=124)                 │     │
         │  3 visible rows x 3 columns     │     │
         │  = 9 items per page              │  ▼  │
         └──────────────────────────────────┴─────┘
                                        x=125-127: scrollbar
```

### Tab bar (y=0 to y=9)

Three tab zones across the full 128px width:

| Tab | X range | Label | Chars x 6px |
|-----|---------|-------|-------------|
| BROWSER | 0-42 | "BROWSER" | 7 x 6 = 42px |
| SKILLS | 43-85 | "SKILLS" | 6 x 6 = 36px |
| AGENTS | 86-127 | "AGENTS" | 6 x 6 = 36px |

- **Active tab**: Filled rectangle in pink/magenta (palette 7), text in near-black (palette 2)
- **Inactive tabs**: No fill, text in yellow (palette 1)
- Tab labels centered vertically (y=1) within their zone
- Clicking a tab zone switches tabs and emits a `MENU_TAB` feedback event

### Separator line (y=10)

Full-width 1px horizontal line in pink/magenta (palette 7). Extends from x=0 to x=127.

### Breadcrumb bar (y=11 to y=18)

Displays the current navigation path in yellow text (palette 1). Examples:
- Root: `memory/`
- Subdirectory: `memory/chapter-one/`
- Back navigation: `< back` (clickable, navigates up one level)

When at the root of a tab, shows the base path. When inside a directory, the `< back` text occupies the left side and is clickable (hit zone: x=0 to x=42, y=11 to y=18).

### Content grid (y=19 to y=95)

The main content area displays items in a 3-column scrollable grid.

**Column layout** (within x=0 to x=124):
- Column 0: x=0 to x=40 (icon centered at x=12)
- Column 1: x=41 to x=82 (icon centered at x=53)
- Column 2: x=83 to x=124 (icon centered at x=95)

**Row layout** (each row is 25px tall):
- Icon: 16x16 sprite, top-aligned in row
- Gap: 2px
- Label: 7px tall (5x7 bitmap font), centered below icon
- Bottom gap: variable

**Visible capacity**: 3 rows x 3 columns = 9 items per page.

**Item rendering**: Each item is either a folder (directory) or a file. Folders use the folder sprite, files use the file sprite. Labels are truncated to 7 characters with no ellipsis (pixel font is small enough that truncation is acceptable).

### Scrollbar (x=125 to x=127)

A 3px-wide vertical scrollbar on the right edge of the content area.

- **Track**: Dark gray (palette 12), full height from y=19 to y=95
- **Up arrow**: 3x3 pixel triangle at y=19, yellow (palette 1), clickable
- **Down arrow**: 3x3 pixel triangle at y=93, yellow (palette 1), clickable
- **Thumb**: Yellow (palette 1), height proportional to `visible_items / total_items`, minimum 4px
- **Scrollbar visibility**: Only rendered when total items exceed 9 (one page)
- **Click behavior**: Click above thumb = page up (scroll up 3 items / 1 row). Click below thumb = page down.

Scrolling is entirely client-side. No feedback events emitted for scroll actions.

## Icon Sprites

Two new 16x16 sprites added to `julianscreen/sprites/items.json`.

### Folder icon

Classic yellow folder with tab detail and blue accent square. Matches the design reference.

```
Row 0:  . . . . . . . . . . . . . . . .
Row 1:  . . 1 1 1 1 1 . . . . . . . . .
Row 2:  . 1 1 1 1 1 1 1 . . . . . . . .
Row 3:  1 1 1 1 1 1 1 1 1 1 1 1 1 1 . .
Row 4:  1 2 2 2 2 2 2 2 2 2 2 2 2 2 1 .
Row 5:  1 2 1 1 1 1 1 1 1 1 1 1 1 2 1 .
Row 6:  1 2 1 1 1 1 1 1 1 1 1 1 1 2 1 .
Row 7:  1 2 1 1 6 6 1 1 1 1 1 1 1 2 1 .
Row 8:  1 2 1 1 6 6 1 1 1 1 1 1 1 2 1 .
Row 9:  1 2 1 1 1 1 1 1 1 1 1 1 1 2 1 .
Row 10: 1 2 1 1 1 1 1 1 1 1 1 1 1 2 1 .
Row 11: 1 2 1 1 1 1 1 1 1 1 1 1 1 2 1 .
Row 12: . 1 2 2 2 2 2 2 2 2 2 2 2 1 . .
Row 13: . . 1 1 1 1 1 1 1 1 1 1 1 . . .
Row 14: . . . . . . . . . . . . . . . .
Row 15: . . . . . . . . . . . . . . . .
```

Palette: 0=transparent, 1=yellow (#FFD600), 2=near-black (#0F0F0F), 6=blue (#4488FF)

### File icon

White document with folded top-right corner and faint text lines.

```
Row 0:  . . . . . . . . . . . . . . . .
Row 1:  . . . 3 3 3 3 3 3 3 2 . . . . .
Row 2:  . . . 3 3 3 3 3 3 2 2 2 . . . .
Row 3:  . . . 3 3 3 3 3 2 12 12 2 . . .
Row 4:  . . . 3 3 3 3 3 2 2 2 2 . . . .
Row 5:  . . . 3 3 3 3 3 3 3 3 2 . . . .
Row 6:  . . . 3 12 12 12 12 12 3 3 2 . .
Row 7:  . . . 3 3 3 3 3 3 3 3 2 . . . .
Row 8:  . . . 3 12 12 12 12 12 3 3 2 . .
Row 9:  . . . 3 3 3 3 3 3 3 3 2 . . . .
Row 10: . . . 3 12 12 12 12 3 3 3 2 . .
Row 11: . . . 3 3 3 3 3 3 3 3 2 . . . .
Row 12: . . . 3 3 3 3 3 3 3 3 2 . . . .
Row 13: . . . 2 2 2 2 2 2 2 2 2 . . . .
Row 14: . . . . . . . . . . . . . . . .
Row 15: . . . . . . . . . . . . . . . .
```

Palette: 0=transparent, 2=near-black (#0F0F0F), 3=white (#FFFFFF), 12=dark gray (#444444)

## Content Model

### Browser tab

Filesystem navigator for Julian's HTML artifacts.

| Property | Value |
|----------|-------|
| Data source | `GET /api/artifacts` (existing, requires Clerk auth) |
| Root path | `memory/` |
| Content | HTML files as file icons, subdirectories as folder icons |
| Sort order | Alphabetical |
| Click behavior | Files: emit `FILE_SELECT`, loaded in artifact viewer. Folders: navigate into. |
| Dynamic | Yes — reflects actual filesystem at `memory/` |

The endpoint already returns `{ files: [{ name, modified }] }`. It will need enhancement to support subdirectory listing (currently flat). For the initial implementation, all 44 files appear as a flat scrollable grid. If subdirectories are created in `memory/`, they appear automatically as folder icons.

### Skills tab

Filesystem navigator for installed Claude Code skills.

| Property | Value |
|----------|-------|
| Data source | `GET /api/skills` (new endpoint) |
| Root path | Varies — aggregates multiple skill source directories |
| Content | Skill namespaces as folders, individual skills as files |
| Click behavior | Folders: navigate into. Files: show description in breadcrumb. Non-functional. |
| Dynamic | Yes — reflects installed skills on the filesystem |

The new endpoint walks skill source directories:
- `.claude/plugins/` and subdirectories containing `skills/` folders
- Project-local skill directories
- `~/.claude/plugins/` for user-level skills

Returns a tree structure: `{ entries: [{ name, type: "folder"|"file", path }] }`.

<!-- TODO: This tab will soon support a graphical interface for adding, removing,
     and updating skills at runtime. The filesystem-mirrored display is the
     foundation for a visual skill manager that lets users modify Julian's
     capabilities without touching the terminal. The API endpoint should be
     designed with future write operations (POST/DELETE) in mind. -->

### Agents tab

Active team manager showing running agent team instances.

| Property | Value |
|----------|-------|
| Data source | `GET /api/agents` (new endpoint) |
| Root path | `~/.claude/teams/` |
| Content | Active teams as folders, team members as files within |
| Click behavior | Folders: navigate into team. Files: show member role/status in breadcrumb. |
| Dynamic | Yes — reflects active teams |
| Empty state | "No active teams" text centered in content area |

The new endpoint reads `~/.claude/teams/` and for each team parses `config.json` to extract:
- Team name (directory name)
- Member list (name, agentType from config.json members array)

Returns: `{ teams: [{ name, members: [{ name, agentType }] }] }`.

Inside a team folder, each member appears as a file icon with their name as label.

<!-- TODO: This tab will soon support spawning new teams, adding/removing members,
     and monitoring task progress — a visual command center for Julian's agent
     ecosystem. The read-only display of active teams is the foundation for
     full team lifecycle management through the pixel screen interface. -->

## File Changes

### New files

| File | Purpose |
|------|---------|
| `julianscreen/client/menu.js` | Menu system module — rendering, state, click handling, scrollbar |
| `julianscreen/sprites/menu-icons.json` | Folder and file icon sprite data (16x16, palette-indexed) |

### Modified files

| File | Change |
|------|--------|
| `julianscreen/client/index.html` | Add `<script src="menu.js">` after `input.js` in load order |
| `julianscreen/server/protocol.js` | Add `MENU`, `MENU_NAV`, `MENU_EXIT` command parsing |
| `julianscreen/server/index.js` | Register new command handlers for menu commands |
| `julianscreen/sprites/items.json` | Add `folder` and `file` sprite entries |
| `chat.jsx` | Update `JulianScreenEmbed` to fetch menu data and handle `FILE_SELECT` events |
| `server/server.ts` | Add `GET /api/skills` and `GET /api/agents` endpoints |

### Module load order (updated)

```
renderer.js → sprites.js → tiles.js → text.js → input.js → effects.js → menu.js
```

`menu.js` loads last so it can intercept clicks before `input.js` and access `JScreen.drawText` from `text.js`.

## menu.js Internal Design

### State

```javascript
const menuState = {
  active: false,           // Whether menu mode is on
  tab: 'browser',          // Current tab: 'browser' | 'skills' | 'agents'
  path: [],                // Current directory path segments
  items: [],               // Current directory listing: [{ name, type: 'folder'|'file' }]
  scrollOffset: 0,         // Number of rows scrolled (0-based)
  totalItems: 0,           // Total items in current directory
  data: {                  // Data provided by React component
    browser: null,         // { entries: [...] }
    skills: null,          // { entries: [...] }
    agents: null,          // { teams: [...] }
  }
};
```

### Public API on JScreen

```javascript
JScreen.setMenuData(tab, data)   // Called by React component to provide file listings
JScreen.enterMenu(tab)           // Enter menu mode (also callable via MENU command)
JScreen.exitMenu()               // Exit menu mode (also callable via MENU_EXIT command)
JScreen.menuNavigate(path)       // Navigate to path (also callable via MENU_NAV command)
```

### Rendering pipeline

When `menuState.active` is true, menu.js takes over the draw and UI layers each frame:

1. Clear draw layer and UI layer
2. Render tab bar (3 zones, active tab highlighted)
3. Render separator line
4. Render breadcrumb bar (current path or `< back`)
5. Render content grid (icons + labels for visible items based on scrollOffset)
6. Render scrollbar (if items exceed one page)
7. Skip avatar rendering (set a flag that sprites.js checks)

### Click handling

menu.js registers a click handler that runs before input.js:

1. Convert pixel coordinates from click event
2. If in tab bar zone (y < 10): identify which tab, switch to it
3. If in breadcrumb zone (y 11-18) and showing `< back`: navigate up
4. If in scrollbar zone (x >= 125, y >= 19): handle scroll
5. If in content grid (x < 125, y >= 19): identify which cell was clicked
   - Calculate: `col = floor(x / 41)`, `row = floor((y - 19) / 25)`
   - Item index: `(scrollOffset + row) * 3 + col`
   - If folder: navigate into it
   - If file: emit `FILE_SELECT` feedback event
6. If click was handled, prevent propagation to input.js

### Sprite rendering

menu.js loads `menu-icons.json` at startup (same async fetch pattern as other modules). Icons are rendered to the draw layer using the same palette-indexed pixel rendering that sprites.js uses for items — iterate the 256-value array, plot non-zero pixels with the palette color.

## API Endpoints

### GET /api/skills (new)

Returns the installed skill tree by walking skill directories on the filesystem.

```json
{
  "entries": [
    { "name": "vibes", "type": "folder", "children": [
      { "name": "vibes", "type": "file", "description": "Generate React app" },
      { "name": "launch", "type": "file", "description": "End-to-end SaaS" },
      { "name": "sell", "type": "file", "description": "Add auth + billing" }
    ]},
    { "name": "superpowers", "type": "folder", "children": [
      { "name": "brainstorming", "type": "file" },
      { "name": "writing-plans", "type": "file" }
    ]}
  ]
}
```

Authentication: Requires Clerk token (same as `/api/artifacts`).

Implementation: Walk known skill directories, group by namespace prefix, read skill frontmatter for descriptions where available.

### GET /api/agents (new)

Returns active agent teams.

```json
{
  "teams": [
    {
      "name": "research-team",
      "members": [
        { "name": "frontend-dev", "agentType": "general-purpose" },
        { "name": "reviewer", "agentType": "code-reviewer" }
      ]
    }
  ]
}
```

Authentication: Requires Clerk token.

Implementation: Read `~/.claude/teams/`, parse each team's `config.json`, extract member roster. Return empty array if no teams directory exists or no active teams.

### GET /api/artifacts (existing, enhanced)

Currently returns a flat list of HTML files. Enhancement: support a `path` query parameter for subdirectory navigation.

```
GET /api/artifacts?path=chapter-one/
```

Returns entries within that subdirectory. Path traversal protection remains in place.

## Implementation Sequence

1. **Sprite data**: Create folder and file icon sprites in `items.json` or `menu-icons.json`
2. **Protocol**: Add `MENU`, `MENU_NAV`, `MENU_EXIT` parsing to `protocol.js`
3. **menu.js**: Build the client module — rendering, state management, click handling, scrollbar
4. **API endpoints**: Add `/api/skills` and `/api/agents` to `server/server.ts`
5. **JulianScreenEmbed**: Update React component to fetch menu data and handle file selections
6. **Integration test**: Verify menu enters/exits cleanly, tabs switch, files open in artifact viewer
7. **Polish**: Scroll animations, hover highlights, transition effects between modes

## Open Questions

- Should there be a keyboard shortcut or button on the main UI to toggle menu mode, or is it purely agent/command driven?
- When a file is selected in the Browser tab, should the menu auto-exit to show the avatar, or stay in menu mode?
- Should the scrollbar support click-and-drag on the thumb, or just click-to-page? (Click-to-page is simpler for the pixel resolution.)
