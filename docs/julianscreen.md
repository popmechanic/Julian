# JulianScreen — Pixel Display SDK

JulianScreen is a 128x96 pixel display driven by Claude Code agents via text commands. An agent sends commands like `S happy` or `T Hello!` through HTTP POST, and a browser renders them as animated pixel art on a 4-layer composited canvas. The cost per display change is roughly 2-5 tokens — a single curl call with a few short lines.

The system is standalone. It runs on port 3848, separate from the Julian chat bridge on 3847. Any Claude Code agent can drive it. The browser client auto-connects via WebSocket and renders commands in real time.

## Starting the Server

```bash
cd /Users/marcusestes/Websites/Julian/julianscreen
bun run server/index.js
# → http://localhost:3848   (browser client)
# → ws://localhost:3848/ws  (WebSocket for renderer)
```

Open `http://localhost:3848` in a browser. The canvas will appear, connect via WebSocket, and display a yellow connection dot in the top-right corner.

## Sending Commands

Commands are plain text, one per line, sent via HTTP POST:

```bash
curl -s -X POST localhost:3848/cmd -d 'BG home
P 4 3
S idle
T Hello world!'
```

Response: `{"ok":true,"parsed":4}`. The `parsed` count tells you how many lines were valid commands. Invalid commands are silently dropped (logged to server stderr).

Multiple commands in one POST are processed sequentially. They arrive at the browser as a single WebSocket message and enter an async command queue. The `W` (wait) command pauses the queue, creating timed sequences:

```bash
curl -s -X POST localhost:3848/cmd -d 'S thinking
W 800
S talking
T Working on it...
W 2000
S happy
F sparkle
T'
```

This shows the thinking animation for 800ms, switches to talking with a speech bubble for 2 seconds, then switches to happy with a sparkle effect and clears the bubble.

## Coordinate System

The screen is 128x96 pixels, divided into a 8x6 grid of 16x16 pixel tiles.

```
     col 0   col 1   col 2   col 3   col 4   col 5   col 6   col 7
      0,0     16,0    32,0    48,0    64,0    80,0    96,0   112,0
row 0 ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
      │ (0,0) │ (1,0) │ (2,0) │ (3,0) │ (4,0) │ (5,0) │ (6,0) │ (7,0) │  y=0-15
row 1 ├───────┼───────┼───────┼───────┼───────┼───────┼───────┼───────┤
      │ (0,1) │ (1,1) │ (2,1) │ (3,1) │ (4,1) │ (5,1) │ (6,1) │ (7,1) │  y=16-31
row 2 ├───────┼───────┼───────┼───────┼───────┼───────┼───────┼───────┤
      │ (0,2) │ (1,2) │ (2,2) │ (3,2) │ (4,2) │ (5,2) │ (6,2) │ (7,2) │  y=32-47
row 3 ├───────┼───────┼───────┼───────┼───────┼───────┼───────┼───────┤
      │ (0,3) │ (1,3) │ (2,3) │ (3,3) │ (4,3) │ (5,3) │ (6,3) │ (7,3) │  y=48-63
row 4 ├───────┼───────┼───────┼───────┼───────┼───────┼───────┼───────┤
      │ (0,4) │ (1,4) │ (2,4) │ (3,4) │ (4,4) │ (5,4) │ (6,4) │ (7,4) │  y=64-79
row 5 ├───────┼───────┼───────┼───────┼───────┼───────┼───────┼───────┤
      │ (0,5) │ (1,5) │ (2,5) │ (3,5) │ (4,5) │ (5,5) │ (6,5) │ (7,5) │  y=80-95
      └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
```

**Two coordinate systems are used:**

- **Tile coordinates** `(tx, ty)` — used by avatar position (`P`), items (`I`), buttons (`BTN`), tile rows (`B`), and scenes (`BG`). Range: tx 0-7, ty 0-5. Mapped to pixels as `(tx * 16, ty * 16)`.
- **Pixel coordinates** `(x, y)` — used by drawing primitives (`RECT`, `CIRC`, `LINE`, `DOT`) and progress bars (`PROG`). Range: x 0-127, y 0-95.

The avatar default position is tile (4, 3) — center of the screen.

---

## Complete Command Reference

### Avatar Commands

#### `S <state>` — Set Avatar State

Switches the avatar to a looping animation. The previous state is replaced immediately.

| State | Animation | Frame Duration | Visual |
|-------|-----------|---------------|--------|
| `idle` | Single idle frame | 1000ms | Neutral face, random blink every 2-5s |
| `happy` | happy_0 ↔ happy_1 | 400ms | Crescent eyes, wide smile, vertical bounce |
| `sad` | Single sad_0 frame | 1000ms | Drooped eyes, downturned mouth |
| `excited` | excited_0 ↔ excited_1 | 250ms | Wide eyes, open mouth, fast bounce |
| `confused` | Single confused frame | 1000ms | Asymmetric eyes, squiggle mouth |
| `thinking` | think_0 → think_1 → think_2 → think_1 | 600ms | Eyes up-left, thought dots accumulate |
| `talking` | talk_0 ↔ talk_1 | 150ms | Mouth opens and closes rapidly |
| `working` | work_0 ↔ work_1 | 500ms | Focused expression, tool motion |
| `sleeping` | sleep_0 ↔ sleep_1 | 800ms | Closed eyes, "z"/"Z" alternating |
| `alert` | Single alert frame | 1000ms | Wide eyes, exclamation pixel |
| `busy` | (maps to `work` animation) | — | Same as working |
| `listening` | (maps to `idle` animation) | — | Same as idle |
| `reading` | (maps to `think` animation) | — | Same as thinking |

**Blink overlay:** During `idle`, `work`, `think`, `confused`, and `sad` states, the avatar blinks randomly every 2-5 seconds (120ms blink duration). Blinks do not occur during one-shot events.

**Note:** `busy`, `listening`, and `reading` are accepted by the protocol parser and mapped to states in the animation system, but the avatar.json currently only defines explicit animations for the first 10 states. These three fall through to similar animations. If finer visual distinction is needed, add animations to `sprites/avatar.json`.

#### `E <event>` — Trigger One-Shot Event

Plays a short animation once, then returns to the previous state.

| Event | Frames | Frame Duration | Total Duration |
|-------|--------|---------------|---------------|
| `nod` | nod_0 → nod_1 → idle | 200ms | 600ms |
| `shake` | shake_0 → shake_1 → shake_0 → shake_1 → idle | 150ms | 750ms |
| `wave` | wave_0 → wave_1 → wave_0 → wave_1 → idle | 200ms | 1000ms |
| `celebrate` | celebrate_0 → celebrate_1 → (repeat) → happy_0 | 200ms | 1000ms |
| `flinch` | flinch → idle | 300ms | 600ms |
| `shrug` | shrug_0 → idle | 500ms | 1000ms |

Events interrupt the current state. When the event animation completes, the avatar returns to whatever state was active before the event.

#### `P <tx> <ty>` — Position Avatar

Moves the avatar to tile position (tx, ty). Clamped to 0-7 horizontal, 0-5 vertical. The speech bubble (if visible) follows the avatar.

Default position: `P 4 3` (center).

### Text Commands

#### `T <text>` — Show Speech Bubble

Displays a speech bubble above the avatar containing the text. The bubble:

- Auto-sizes to fit content
- Word-wraps at ~16 characters per line (max bubble width 100px)
- Uses 5x7 bitmap font at 6px per character (5px glyph + 1px spacing)
- Has a black background, 1px yellow border, and triangular pointer toward avatar
- Clamps to screen bounds (won't overflow off-screen)
- Positions above the avatar, centered horizontally on the avatar's center

The speech bubble renders on the UI layer and persists until cleared or replaced.

#### `T` — Clear Speech Bubble

Sending `T` with no text (or empty text) clears the bubble.

**Text encoding:** The bubble renders characters A-Z, a-z, 0-9, and: `. , ! ? : ; ' " - + = / ( ) < > @ # _` plus space. Any character not in the font is silently skipped. Total: 82 glyphs.

### Background Commands

#### `BG <scene>` — Set Background Scene

Fills the entire 6x8 tile grid with a preset arrangement:

| Scene | Row 0-1 | Row 2 | Row 3-5 | Visual |
|-------|---------|-------|---------|--------|
| `home` | wall | floor | floor | Indoor room — dark brick walls, wood floor |
| `outside` | sky | sky | grass | Outdoor — blue sky with clouds, green grass |
| `night` | stars | stars | stars | Night sky with star points everywhere |
| `rain` | sky | sky | grass | Same layout as outside (rain effect via `F rain`) |
| `empty` | empty | empty | empty | Black/transparent — clean slate |
| `terminal` | grid | grid | grid | Graph paper grid pattern |
| `space` | stars | stars | dots | Starfield top, dot pattern bottom |

#### `B <row> <t0> <t1> <t2> ...` — Set Tile Row

Sets individual tiles in a specific row. Row 0 is top, row 5 is bottom. Supply up to 8 tile names (columns 0-7). Fewer than 8 only sets the provided columns; the rest are unchanged.

Available tiles: `empty`, `floor`, `wall`, `brick`, `grass`, `sky`, `water`, `grid`, `dots`, `stars`, `circuit`

`water` is animated — it alternates between two frames every 500ms automatically.

Example: `B 0 sky sky sky sky sky sky sky sky` fills the top row with sky.

### Item Commands

#### `I <sprite> <tx> <ty>` — Place Item

Places a 16x16 item sprite at tile position (tx, ty). Items stack — placing multiple items at the same position layers them. Items render on the sprite layer (above background, below UI).

Available items: `star`, `heart`, `lightning`, `music`, `gear`

#### `CLRITM` — Clear All Items

Removes every item from the screen.

### UI Commands

#### `BTN <id> <tx> <ty> <label>` — Create Button

Creates a clickable button at tile position (tx, ty). The button renders as a black rectangle with a 1px yellow border and pixel-font label. It is 11px tall (fits within one tile) and positioned at the bottom of the tile cell.

- `id` — unique identifier, returned in feedback when clicked (e.g., `ask`, `confirm`, `option1`)
- `tx ty` — tile position (clamped 0-7, 0-5)
- `label` — display text (remaining args joined by spaces)

If a button with the same `id` already exists, it is replaced.

**Important:** Buttons are only clickable when `btn` is in the active listen types. See `LISTEN` below.

#### `CLRBTN` — Clear All Buttons

Removes every button from the screen.

#### `PROG <x> <y> <w> <pct>` — Progress Bar

Draws a 4px-tall progress bar at pixel coordinates (x, y) with width w pixels, filled to pct percent. The background is dark gray, fill is yellow.

Example: `PROG 10 90 108 75` — a progress bar near the bottom of the screen, 75% filled.

Progress bars are drawn on the UI layer. They persist until the UI layer is cleared or overwritten.

### Drawing Primitives

Drawing commands render to the **draw layer** (above background, below sprites). The draw layer is persistent — pixels stay until explicitly cleared with `CLR`.

#### `COL <index>` — Set Draw Color

Sets the color used by all subsequent drawing commands. Default: 1 (yellow).

| Index | Color | Hex |
|-------|-------|-----|
| 0 | transparent | — |
| 1 | Julian yellow | #FFD600 |
| 2 | near-black | #0F0F0F |
| 3 | white | #FFFFFF |
| 4 | red | #FF4444 |
| 5 | green | #44FF44 |
| 6 | blue | #4488FF |
| 7 | pink | #FF88FF |
| 8 | orange | #FFAA00 |
| 9 | cyan | #00CCCC |
| 10 | purple | #8844FF |
| 11 | gray | #888888 |
| 12 | dark gray | #444444 |
| 13 | light gray | #CCCCCC |
| 14 | brown | #664400 |
| 15 | dark green | #226622 |

#### `RECT <x> <y> <w> <h>` — Fill Rectangle

Fills a rectangle at pixel coordinates. Example: `RECT 10 10 20 15`

#### `CIRC <x> <y> <r>` — Circle Outline

Draws a circle outline (Bresenham midpoint algorithm) centered at (x, y) with radius r. Not filled.

#### `LINE <x1> <y1> <x2> <y2>` — Line

Draws a line (Bresenham algorithm) between two pixel coordinates.

#### `DOT <x> <y>` — Single Pixel

Sets one pixel at (x, y) to the current draw color.

#### `CLR` — Clear Draw Layer

Erases the entire draw layer. Does not affect background, sprites, or UI.

### Effect Commands

#### `F <effect>` — Screen Effect

Triggers a temporary visual effect that plays once and disappears.

| Effect | Duration | Visual |
|--------|----------|--------|
| `sparkle` | 800ms | Random yellow pixels flash across the screen, fading out |
| `hearts` | 1200ms | Five red pixel hearts float upward at staggered heights |
| `flash` | 200ms | Brief white overlay that fades quickly |
| `shake` | 300ms | Canvas shakes via CSS transform oscillation (does not affect pixels) |
| `rain` | 2000ms | Vertical blue streaks fall across the screen |
| `snow` | 3000ms | White dots drift slowly downward with horizontal drift |
| `glitch` | 200ms | Horizontal band displacement (reads and shifts pixel data) |

Effects render on the UI layer and animate over time via `progress` (0→1). Multiple effects can overlap.

### Flow Control

#### `W <ms>` — Wait

Pauses the command queue for `ms` milliseconds (max 10000). Only affects commands in the same POST body — the wait happens client-side in the browser's async queue.

This is the mechanism for scripted sequences. Without waits, all commands in a POST execute in the same frame.

#### `LISTEN <types...>` — Configure Feedback

Enables feedback event types. By default, no feedback is generated. You must call LISTEN before feedback events will be sent.

| Type | Feedback Event | When |
|------|---------------|------|
| `btn` | `{"type":"BTN","id":"<id>"}` | User clicks a button |
| `tap` | `{"type":"TAP","tx":<n>,"ty":<n>}` | User clicks anywhere (tile coords) |
| `tick` | `{"type":"TICK","ts":<unix_ms>}` | Server timer (requires `TICK_INTERVAL` env var > 0) |

Example: `LISTEN btn tap` enables button clicks and tap location reporting.

Calling `LISTEN` replaces the previous listen types. `LISTEN` with no arguments disables all feedback.

---

## Receiving Feedback

The agent polls for browser events:

```bash
curl -s localhost:3848/feedback
# → [{"type":"BTN","id":"ask"},{"type":"TAP","tx":3,"ty":2}]
```

This returns a JSON array of all queued events and clears the queue. If no events are pending, returns `[]`.

**Queue size limit:** 200 events. Oldest events are dropped if the queue overflows.

**Feedback flow:**
1. User clicks canvas
2. Browser translates click to pixel coordinates using the display scale factor
3. Hit-test against button rects (if `btn` listen active) → sends `BTN` event via WebSocket
4. If no button hit and `tap` listen active → sends `TAP` event with tile coordinates via WebSocket
5. Server queues the event
6. Agent retrieves via `GET /feedback`

---

## HTTP API

| Method | Path | Request Body | Response |
|--------|------|-------------|----------|
| `POST` | `/cmd` | Newline-delimited commands (text/plain) | `{"ok":true,"parsed":<n>}` |
| `GET` | `/feedback` | — | JSON array of events, clears queue |
| `GET` | `/health` | — | `{"status":"ok","connections":<n>,"queueDepth":<n>}` |
| `GET` | `/ws` | — | WebSocket upgrade |
| `GET` | `/` | — | Serves `client/index.html` |
| `GET` | `/<file>` | — | Serves files from `client/` |
| `GET` | `/sprites/<file>` | — | Serves files from `sprites/` |

All endpoints include `Access-Control-Allow-Origin: *` for local dev. No authentication.

---

## Rendering Pipeline

### Four Compositing Layers

The display composites four offscreen canvases onto the main canvas every frame (30fps target):

```
Layer 4 (top):  uiLayer    — speech bubbles, buttons, progress bars, effects overlay
Layer 3:        spriteLayer — avatar animation, item sprites (cleared each frame)
Layer 2:        drawLayer   — drawing primitives (persistent until CLR)
Layer 1 (base): bgLayer     — tile background (only redrawn when dirty flag set)
Background:     #0F0F0F fill — always drawn first
```

Each layer is a 128x96 offscreen `<canvas>`. The main canvas composites them bottom-to-top with `drawImage`. Transparent pixels (palette index 0) pass through to lower layers.

### Animation Loop

The `requestAnimationFrame` loop runs at 30fps. Each frame:

1. Clear the sprite layer (it's redrawn every frame)
2. Call `JScreen.tickAnimations(timestamp)` — a chain of tick functions:
   - **effects.js** tick: update active effects, render particles/overlays
   - **tiles.js** tick: cycle water animation frames (500ms), redraw bg if dirty
   - **sprites.js** tick: advance avatar animation, handle blink overlay, render avatar + items
3. Composite all four layers onto the main canvas

The tick chain is built via function wrapping — each module captures the previous `JScreen.tickAnimations` and calls it before running its own tick. Load order determines chain order: `renderer.js` → `sprites.js` → `tiles.js` → `text.js` → `input.js` → `effects.js`.

### Display Scaling

The 128x96 canvas is scaled to fill the browser viewport using integer scaling (no sub-pixel blur). The scale factor is `min(floor(viewportWidth/128), floor(viewportHeight/96))`. At a typical 1440x900 viewport, scale = 9 → display size 1152x864 pixels.

`image-rendering: pixelated` ensures sharp pixel edges. Click coordinates are divided by the scale factor to convert back to canvas coordinates.

---

## Module Architecture

All client modules communicate through the `window.JScreen` global object, set up by `renderer.js`:

```
JScreen.init(canvas)           — Initialize main canvas and start animation loop
JScreen.registerHandler(type, fn) — Register a command handler by type string
JScreen.enqueueCommands([...]) — Add parsed commands to the async queue
JScreen.tickAnimations(ts)     — Chained tick function, called every frame
JScreen.sendFeedback(event)    — Send feedback event to server via WebSocket

JScreen.bgLayer     — { canvas, ctx } for background tiles
JScreen.drawLayer   — { canvas, ctx } for drawing primitives
JScreen.spriteLayer — { canvas, ctx } for avatar and items
JScreen.uiLayer     — { canvas, ctx } for bubbles, buttons, effects

JScreen.avatarX     — Avatar pixel X position (set by sprites.js)
JScreen.avatarY     — Avatar pixel Y position (set by sprites.js)
JScreen.drawText    — drawText(ctx, text, x, y, paletteIndex) function (set by text.js)
JScreen._renderButtons — re-render button display (set by input.js)
JScreen._scale      — current integer scale factor (set by index.html resize handler)

JScreen.SCREEN_W = 128
JScreen.SCREEN_H = 96
JScreen.TILE_SIZE = 16
JScreen.COLS = 8
JScreen.ROWS = 6
JScreen.PALETTE = [16 color strings]
```

### Handler Registration

Each command type maps to exactly one handler function. Handlers are registered during module initialization:

| Module | Handles | Source File |
|--------|---------|-------------|
| renderer.js | RECT, CIRC, LINE, DOT, CLR, COL | `client/renderer.js` |
| sprites.js | STATE, EVENT, POS, ITEM, CLRITM | `client/sprites.js` |
| tiles.js | SCENE, TILEROW | `client/tiles.js` |
| text.js | TEXT | `client/text.js` |
| input.js | BTN, CLRBTN, LISTEN, PROG | `client/input.js` |
| effects.js | EFFECT | `client/effects.js` |

The `WAIT` command is handled directly by the command queue processor in `renderer.js` — it pauses the queue with a `setTimeout` promise.

---

## Sprite Data Format

All sprite data is stored as JSON files in `sprites/`. Each frame is a flat array of 256 values (16x16, row-major order). Each value is a palette index (0-15). Index 0 means transparent.

### `sprites/avatar.json`

```json
{
  "frames": {
    "idle": [0,0,0,...256 palette indices],
    "blink": [...],
    "talk_0": [...],
    ...
  },
  "animations": {
    "idle": { "frames": ["idle"], "frameDuration": 1000, "loop": true },
    "happy": { "frames": ["happy_0", "happy_1"], "frameDuration": 400, "loop": true },
    ...
  },
  "events": {
    "nod": { "frames": ["nod_0", "nod_1", "idle"], "frameDuration": 200 },
    "wave": { "frames": ["wave_0", "wave_1", "wave_0", "wave_1", "idle"], "frameDuration": 200 },
    ...
  }
}
```

**Available frames (28 total):** idle, blink, talk_0, talk_1, think_0, think_1, think_2, happy_0, happy_1, sad_0, excited_0, excited_1, confused, sleep_0, sleep_1, work_0, work_1, alert, wave_0, wave_1, nod_0, nod_1, shake_0, shake_1, celebrate_0, celebrate_1, flinch, shrug_0

**Animations (10):** idle, talk, think, happy, sad, excited, confused, sleep, work, alert

**Events (6):** nod, shake, wave, celebrate, flinch, shrug

### `sprites/items.json`

Flat object mapping item names to 256-value palette-indexed arrays:

```json
{
  "star": [256 values],
  "heart": [256 values],
  "lightning": [256 values],
  "music": [256 values],
  "gear": [256 values]
}
```

### `sprites/tiles.json`

Same format as items — tile names to 256-value arrays. Animated tiles use suffixed names (`water_0`, `water_1`); the `water` name in commands is resolved at render time.

**Tiles (12):** empty, floor, wall, brick, grass, sky, water_0, water_1, grid, dots, stars, circuit

### `sprites/font.json`

Maps characters to 35-value arrays (5x7, row-major). Each value is 0 (off) or 1 (on). The rendering code uses the current palette color for on-pixels.

**82 glyphs:** 0-9, A-Z, a-z, `. , ! ? : ; ' " - + = / ( ) < > @ # _` and space.

Character cell width: 6px (5px glyph + 1px spacing). Character height: 7px. Line spacing: 8px (7px glyph + 1px gap).

---

## Agent Integration Patterns

### Basic Scene Setup

Every session should start by establishing a scene:

```bash
curl -s -X POST localhost:3848/cmd -d 'BG home
P 4 3
S idle
LISTEN btn'
```

### Interactive Dialog

Create buttons, wait for user response:

```bash
# Pose question
curl -s -X POST localhost:3848/cmd -d 'S talking
T Want to continue?
BTN yes 2 5 YES
BTN no 5 5 NO
LISTEN btn'

# Poll for response (in a loop, or after delay)
RESPONSE=$(curl -s localhost:3848/feedback)
# → [{"type":"BTN","id":"yes"}]
```

### Progress Indication

Show work in progress:

```bash
curl -s -X POST localhost:3848/cmd -d 'S working
T Building...
PROG 10 88 108 0'

# Update progress
curl -s -X POST localhost:3848/cmd -d 'PROG 10 88 108 50
T Halfway there...'

# Complete
curl -s -X POST localhost:3848/cmd -d 'PROG 10 88 108 100
S happy
F sparkle
T Done!'
```

### Emotional Reactions

Express reactions to events:

```bash
# Success
curl -s -X POST localhost:3848/cmd -d 'S happy
E celebrate
F sparkle'

# Error
curl -s -X POST localhost:3848/cmd -d 'S alert
F shake
T Something went wrong'

# Thinking
curl -s -X POST localhost:3848/cmd -d 'S thinking
T Let me consider...'
```

### Clearing State

To reset the screen:

```bash
curl -s -X POST localhost:3848/cmd -d 'T
CLRBTN
CLRITM
CLR
BG empty
S idle
P 4 3'
```

---

## Server Internals

### `server/index.js` (168 lines)

Bun HTTP + WebSocket server. Key behaviors:

- **POST /cmd** parses body into lines, runs each through `parseCommand()`, broadcasts valid commands to all WebSocket clients
- **GET /feedback** returns the feedback queue as JSON and clears it
- **GET /health** returns connection count and queue depth
- **WebSocket /ws** on connect: sends `[{"type":"READY"}]` signal. On message: parses JSON, queues as feedback
- **File serving**: serves `client/`, `sprites/`, and `index.html` relative to the package directory
- **CORS**: `Access-Control-Allow-Origin: *` on all responses

### `server/protocol.js` (244 lines)

Pure parsing and validation. `parseCommand(line)` returns a command object or null. Key behaviors:

- Strips optional `@agentname ` prefix from lines before parsing
- Validates all arguments (ranges, known values)
- Clamps numeric values to valid ranges (tile coords 0-7/0-5, palette 0-15, wait 0-10000)
- Invalid or unknown commands return null (logged to stderr, not sent to browser)

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `JULIANSCREEN_PORT` | `3848` | Server port |
| `TICK_INTERVAL` | `0` | Server-side tick timer in ms (0 = disabled) |

---

## File Map

```
julianscreen/
├── server/
│   ├── index.js       (168 lines) — Bun HTTP + WebSocket server
│   └── protocol.js    (244 lines) — Command parser + validation
├── client/
│   ├── index.html      (80 lines) — Canvas, scaling, WebSocket connect
│   ├── renderer.js    (213 lines) — 4-layer compositing, drawing primitives, command queue
│   ├── sprites.js     (229 lines) — Avatar animation engine, item rendering
│   ├── tiles.js       (142 lines) — Tile grid, scene presets, water animation
│   ├── text.js        (167 lines) — Bitmap font, speech bubbles
│   ├── input.js       (153 lines) — Button rendering, click detection, feedback
│   └── effects.js     (173 lines) — Sparkle, hearts, flash, shake, rain, snow, glitch
├── sprites/
│   ├── avatar.json   (19.8 KB) — 28 frames, 10 animations, 6 events
│   ├── items.json     (3.0 KB) — 5 item sprites
│   ├── tiles.json     (8.0 KB) — 12 tile patterns
│   └── font.json      (7.1 KB) — 82 character glyphs (5x7 bitmap)
├── package.json
├── protocol.md         — Command quick-reference
└── README.md           — Quick start guide
```

---

## Known Limitations and Gotchas

### Shared UI Layer

The speech bubble (text.js) and buttons (input.js) both render to `uiLayer`. The text handler clears only its tracked bubble region before redrawing, then calls `JScreen._renderButtons()` to repaint buttons. If you clear the UI layer manually, both bubbles and buttons will disappear.

### Async Module Initialization

sprites.js, tiles.js, and text.js all fetch JSON data asynchronously on load. Commands sent before data loads will find no registered handler and log a warning. In practice, JSON loads in <50ms locally, but if you send commands immediately after page load, the first few may be missed. The `READY` WebSocket signal fires on connection, before JSON loads complete.

### Button Clicks Require LISTEN

Buttons are always visible after creation, but clicks only generate feedback events when `LISTEN btn` is active. This is intentional — it lets you display buttons decoratively without generating feedback noise.

### Speech Bubble Width

Max bubble width is 100px (~16 characters per line). Longer text wraps. The bubble is clamped to screen bounds, so text at screen edges may have the pointer offset from the avatar center.

### No State Query

There is no command to read the current state. The server does not store state — it broadcasts commands and forgets them. The browser is the only source of truth for what's currently displayed. If you need to know the state, track it yourself.

### Draw Layer Persistence

Drawing primitives (`RECT`, `LINE`, etc.) persist on the draw layer until `CLR` is called. If you draw something and then change the background, the drawing remains. If you want a clean canvas, send `CLR` before redrawing.

### Effect Timing

Effects use `performance.now()` timestamps, not the command queue's wait system. If you send `F sparkle` followed by `W 800` followed by `F hearts`, the sparkle starts immediately, the wait delays the hearts command by 800ms, but the sparkle has already been running for 800ms by then. Effects are fire-and-forget.

### No Multi-Agent Isolation

The `@agent` prefix is stripped by the protocol parser but otherwise ignored. All commands from all agents share the same display state. If two agents send conflicting commands, the last one wins.

---

## Not Yet Implemented

These features were planned but not built in the initial implementation:

- **`DEF`/`FRAME`/`ADEF` — runtime sprite definition**: Custom sprites defined via commands rather than JSON files
- **State transition animations**: Brief bounce/blink when switching between states (currently switches immediately)
- **Multi-agent namespacing**: `@agent` prefix is stripped but could be used to scope display regions
- **`READY` polling from agent side**: Agent has no way to know when the browser is ready except polling `/health` for `connections > 0`
- **Deployment to production**: Runs via `julian-screen` systemd service on port 3848. The browser connects through the WebSocket proxy at `/screen/ws` in server.ts.

---

## Integration with Julian Bridge

JulianScreen is currently standalone on port 3848, separate from the Julian chat bridge on port 3847. To integrate:

1. **Start alongside bridge**: Add to systemd or run `bun run julianscreen/server/index.js` alongside `julian-bridge`
2. **Agent drives both**: A Julian session can POST to both `:3847/api/chat` (conversation) and `:3848/cmd` (display) — they're independent channels
3. **Embed in main UI**: The JulianScreen canvas could be embedded in `index.html` as an iframe or by inlining the client code. The 128x96 canvas at the existing PixelFace location would replace the 32x32 face with a full expressive display.
4. **Replace PixelFace**: The existing `PixelFace` component in `index.html:2285-2395` is a 32x32 canvas with basic eye/mouth animation. JulianScreen's 16x16 avatar (with 28 frames and 16 animation states) is a superset of that functionality at half the pixel resolution but vastly more expressiveness.

The simplest integration path: start the JulianScreen server as a sibling process, have the Julian bridge subprocess send curl commands to `:3848/cmd` as part of its responses, and point an iframe in the main UI to `http://localhost:3848`.
