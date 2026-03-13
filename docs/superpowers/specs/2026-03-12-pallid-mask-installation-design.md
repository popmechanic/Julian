# Pallid Mask — Installation Architecture

Sou'wester Arts Week 2026 · Ilwaco, Washington

## Overview

A two-room fortune-telling installation. Room 1: Julian as MC on a CRT (independent, not covered here). Room 2: the Pallid Mask — a procedurally-animated mask entity that greets visitors by voice, receives their question via keyboard, performs stichomancy against two sacred texts using keystroke-timing entropy, interprets the result through Claude, and speaks the fortune aloud before displaying it on screen. Visitors receive a QR code linking to a permanent take-home page of their fortune.

One visitor at a time. Full reset between sessions.

---

## System Boundary

The Pallid Mask is a **standalone Bun server**, separate from Julian's main server. No shared state, no shared process. Independently deployable on dedicated installation hardware. Communicates with two external services: the Claude API (fortune generation + greeting) and ElevenLabs (text-to-speech).

---

## Ceremony State Machine

Eight states, linear progression. The ceremony module owns all transitions and is the only module aware of the overall flow.

```
WELCOME → SUMMON → INPUT → DIVINE → FORTUNE → REVEAL → QR_OFFER → QR_DISPLAY → WELCOME
```

### State Detail

| State | Display | Audio | Exit Trigger |
|-------|---------|-------|-------------|
| WELCOME | Text instructions: have a seat, press a key to begin. No mask visible. | None | Any keypress |
| SUMMON | Mask animates in (fade/scale). Sigils begin. Pre-fetched greeting plays once mask is visible. The greeting is a single continuous audio that covers both SUMMON and PROMPT — it greets the visitor, frames the ritual, and concludes by asking them to formulate a question. | ElevenLabs TTS: single audio from one Claude-generated greeting text. | Audio complete (ceremony advances directly to INPUT) |
| INPUT | Text prompt visible. Visitor types their question. Each keystroke's inter-key timing interval is recorded. | None | Enter key |
| DIVINE | Mask recedes. Sigil animations become prominent (loading mode). Narration text surfaces the divination steps sequentially. Server processes in parallel. | None | Server response received AND minimum narration duration elapsed |
| FORTUNE | Mask returns. Fortune is read aloud by the mask voice. No text on screen — just the face and voice. | ElevenLabs TTS: the interpreted fortune | Audio complete |
| REVEAL | Mask fades out. Fortune text appears on screen in `.entity-interpret` styling. | None | Timed (after text fully displayed) |
| QR_OFFER | Text: press a key to receive your fortune. | None | Any keypress |
| QR_DISPLAY | QR code displayed with scan instructions. | None | Any keypress OR 45-second timeout |

After QR_DISPLAY, the ceremony resets to WELCOME. During reset (or during the current visitor's session), the server pre-generates the next greeting so SUMMON has zero perceived latency.

### DIVINE Narration Sequence

During DIVINE, the display module shows a scripted sequence of status messages, timed to feel deliberate and ritualistic. Each line appears, holds, and fades:

- *gathering the intervals between your keystrokes...*
- *deriving a seed from the rhythm of your intention...*
- *consulting the first text...*
- *consulting the second text...*
- *two passages have been drawn...*
- *the mask is interpreting...*

The actual server processing (stichomancy + Claude API + ElevenLabs TTS) runs in parallel. The ceremony enforces a minimum narration duration — if the API returns fast, the narration continues. If the API takes longer, the final line holds until the response arrives. The ceremony waits for BOTH the narration minimum AND the server response before transitioning to FORTUNE.

---

## File Structure

```
pallid-mask/
├── client/
│   ├── ceremony.ts        ← state machine, keyboard listener, orchestrator
│   ├── mask.ts            ← SVG face, blink, smile, show/hide/recede
│   ├── sigils.ts          ← frame wave, top morph, bottom warp, loading mode
│   ├── display.ts         ← text overlays, transitions, QR render, narration
│   ├── input.ts           ← keystroke capture, timing intervals
│   ├── api.ts             ← fetch wrapper for /api/fortune, /api/greeting
│   ├── main.ts            ← entry point, wires modules together
│   └── types.ts           ← shared client types
├── server/
│   ├── index.ts           ← Bun.serve, routes, static files
│   ├── stichomancy.ts     ← seed calculation, passage lookup
│   ├── fortune.ts         ← Claude API prompt construction + call
│   ├── qr.ts              ← QR SVG generation
│   ├── fortune-page.ts    ← HTML page builder from template
│   ├── voice.ts           ← ElevenLabs TTS wrapper
│   └── types.ts           ← API contract types
├── public/
│   ├── index.html         ← installation display page
│   ├── styles.css         ← shared styles (installation + fortune pages)
│   └── dist/              ← bun build output (client bundle)
├── data/
│   ├── sigils.json        ← 200 sigil paths (converted from sigils-all.js)
│   ├── king-james-bible.txt  ← moved from pallid-mask/ root
│   └── king-in-yellow.txt    ← moved from pallid-mask/ root
├── templates/
│   └── fortune.html       ← fortune page template (slots for text + sigil)
├── fortunes/              ← generated static HTML pages (gitignored)
├── assets/
│   ├── Orpheus.otf
│   ├── mask.html          ← reference implementation
│   └── Cyber Sigils Vectors/
├── soul.md                ← Pallid Mask system prompt
├── CLAUDE.md
├── tsconfig.json
└── package.json
```

---

## Client Architecture

### Module Dependency Rule

**ceremony.ts is the only module that knows about the overall flow.** Every other module exposes a simple public API and knows nothing about ceremony states or other modules. They do not import each other.

### Modules

**ceremony.ts** — The brain. Manages the 8-state machine. Owns the keyboard listener and delegates meaning based on current state. Calls other modules' public methods (`mask.show()`, `sigils.loadingMode()`, `display.showNarration()`, etc.). No DOM manipulation of its own.

**mask.ts** — SVG face with autonomous blink and smile loops. Public API: `show()`, `hide()`, `recede()`, `startAnimations()`, `stopAnimations()`. Blink runs every 5–14s. Smile runs every 70–130s. Both start/stop on command but run autonomously once started. Contains all face SVG markup, triple-layer Gaussian glow filter, and CSS animation triggers.

**sigils.ts** — Consolidates three sigil systems into one module:
- Frame wave (clockwise displacement around viewport edges)
- Top morph (30fps cycling through 200 sigils)
- Bottom warp (displacement crossfade transitions)

Public API: `init(sigils)`, `start()`, `stop()`, `loadingMode()` (sigils become visually prominent while mask recedes during DIVINE), `normalMode()`. Loads `sigils.json` at initialization.

**display.ts** — Text rendering for all ceremony states. Handles: welcome instructions, prompt text, DIVINE narration sequence, fortune text display, QR code rendering. Manages fade transitions and typewriter effects. Public API: `showWelcome()`, `showPrompt()`, `showNarration(steps, onComplete)`, `showFortune(text)`, `showQR(svgString)`, `showQROffer()`, `clear()`.

**input.ts** — Captures keystrokes during INPUT state. Records inter-key timing intervals (ms between consecutive keystrokes). Returns the typed question string and timing array. Public API: `start()` → `Promise<{question: string, timings: number[]}>` (resolves on Enter key).

**api.ts** — Thin HTTP client. Two methods:
- `requestGreeting()` → `Promise<{text: string, audioUrl: string}>`
- `requestFortune(question, timings)` → `Promise<{fortune: string, qrSvg: string, publicUrl: string, audioUrl: string}>`

### Audio Playback

The client plays audio returned from the server (ElevenLabs TTS) using the Web Audio API or an `<audio>` element. The ceremony state machine listens for the `ended` event to trigger state transitions after voice playback completes.

---

## Server Architecture

### Entry Point (index.ts)

Bun.serve with three route groups:
- `POST /api/greeting` — generate a fresh Pallid Mask greeting
- `POST /api/fortune` — full fortune pipeline (stichomancy → Claude → TTS → QR → page)
- `GET /fortunes/*` — serve generated static fortune pages
- `GET /*` — serve static files from `public/`

Loads text databases (King James Bible, King in Yellow) into memory at startup. Both are tab-indexed text files totaling ~5 MB — trivial for a server process.

### stichomancy.ts

Pure function. Takes a timing array, returns two passage objects.

```
seed = sum of inter-key timing intervals (ms)
king_yellow_index = seed % 1662
bible_index = Math.floor(seed / 1662) % 31102
```

Looks up passage text from pre-loaded in-memory databases.

### fortune.ts

Builds the Claude API prompt and calls `@anthropic-ai/sdk` directly. Each call is stateless — no conversation history, no context accumulation.

**System prompt:** Contents of `soul.md` plus interpretation rules:
1. Abstract away recognizable biblical references (names, places, events) — find rough approximations that obscure the source. References to God are acceptable.
2. Abstract away recognizable King in Yellow references (Carcosa, Hastur, the Yellow Sign, etc.) — same treatment.
3. Shift all pronouns to "you" orientation in active or future tense, depending on context.
4. If a natural seam exists to join the two passages, do so lightly without altering the text too much. Some disjunction is acceptable.

**User message:** The two stichomancy passages plus the visitor's typed question.

**Model:** `claude-opus-4-6` with `thinking: {type: "adaptive"}`.

**Returns:** The interpreted fortune text (string).

### voice.ts

Wraps the ElevenLabs text-to-speech API.

- Voice ID: `50I72bKDereNurpy2q0d`
- Model: `eleven_multilingual_v2`
- Output: mp3
- API key from `.env` (`ELEVENLABS_API_KEY`)

Two use cases:
1. **Greeting TTS** — voices the Claude-generated greeting text
2. **Fortune TTS** — voices the Claude-generated fortune interpretation

Returns audio as an mp3 buffer. The server writes each mp3 to a temporary file in `public/audio/` and returns the local URL path (e.g., `/audio/{id}.mp3`). The client plays it via an `<audio>` element. Audio files are cleaned up on ceremony reset.

### fortune-page.ts

Generates a self-contained static HTML page for each fortune.

- Generates a unique fortune ID (nanoid or crypto.randomUUID)
- Reads the `templates/fortune.html` template
- Fills slots: `{{fortune}}`, `{{sigil}}`, `{{date}}`
- **Inlines all CSS** — the relevant subset of `styles.css` is baked directly into each page, plus the Orpheus font base64-encoded. Each fortune page is fully self-contained with zero external dependencies.
- Writes the result to `fortunes/{id}.html`
- Returns the public URL

### qr.ts

Generates a QR code as inline SVG pointing to the fortune's public URL. Uses a QR library (e.g., `qrcode` npm package) to produce SVG markup that the client renders during QR_DISPLAY.

### API Contracts

```
POST /api/greeting
Request:  {}
Response: { text: string, audioUrl: string }

POST /api/fortune
Request:  { question: string, timings: number[] }
Response: { fortune: string, qrSvg: string, publicUrl: string, audioUrl: string }

GET /fortunes/:id.html
→ Self-contained static HTML page (Pallid Mask aesthetic, responsive)
```

---

## Shared Styles

`public/styles.css` is the single source of truth for all typography and color. Both the installation display (`index.html`) and the fortune page template (`templates/fortune.html`) derive from it.

### Color Palette (oklch)

```css
--c1: oklch(52% 0.12 317);   /* dominant: dusty violet */
--c2: oklch(32% 0.086 287);  /* deep indigo-shadow */
--c3: oklch(42% 0.097 297);  /* mid blue-violet */
--c4: oklch(67% 0.092 307);  /* lighter violet */
--c5: oklch(77% 0.076 332);  /* pale mauve */
--c6: oklch(87% 0.065 347);  /* near-white rose */
```

### Typography

Font: Orpheus (`assets/Orpheus.otf`) — display font. All display text written in lowercase in HTML source; Orpheus renders as uniform small caps. Never use `text-transform: uppercase` or Title Case.

### Fortune Text Styling

Fortune text uses the existing `.entity-interpret` class from the mockup prototype: `color: var(--c5)`, `line-height: 2.0`, `letter-spacing: 0.03em`, double drop-shadow glow. This styling is shared between the installation display and the take-home fortune page.

---

## Fortune Page (Take-Home Artifact)

The page visitors see when they scan the QR code on their phone. Design principles:

- **Self-contained** — all CSS and the Orpheus font (base64) are inlined. No external dependencies. Works forever, even if the server goes offline after the event.
- **Pallid Mask aesthetic** — same color palette, same typography, same text styling as the installation. A memory anchor.
- **Responsive** — works on any phone width. The installation targets a 4K projector; the fortune page targets mobile screens.
- **Minimal** — just the interpreted fortune text in `.entity-interpret` styling, a single sigil derived from the visitor's fortune seed, and event metadata (date, location). No navigation, no branding, no JavaScript required to view.
- **No source passages** — only the interpreted fortune is shown. The raw Bible verse and King in Yellow passage are not included.
- **No CRT effects** — no scanlines, no flicker. Just the text treatment on a dark field.
- **Templated** — easy to iterate on styling. Changes to `styles.css` update the relevant CSS subset that gets inlined into future fortune pages.

---

## Pre-Fetched Greetings

To eliminate perceived latency at SUMMON, the server pre-generates greetings:

1. On startup and after each ceremony reset, the server proactively calls Claude + ElevenLabs to generate the next greeting.
2. The greeting (text + audio) is cached and ready before anyone presses a key.
3. When a visitor triggers SUMMON, the pre-fetched greeting plays immediately as the mask animates in.
4. While the current visitor proceeds through their session, the server can begin pre-generating the next greeting during idle states (QR_DISPLAY or after reset).

Each greeting is unique — Claude generates fresh text from the soul.md prompt each time, speaking as the Pallid Mask entity (not Julian). The greeting frames the ritual and invites the visitor to formulate a question.

---

## External Services

### Claude API

- Package: `@anthropic-ai/sdk`
- Model: `claude-opus-4-6`
- Thinking: `{type: "adaptive"}`
- Two stateless calls per visitor session (greeting + fortune interpretation)
- API key from `.env` (`ANTHROPIC_API_KEY`)

### ElevenLabs

- Voice ID: `50I72bKDereNurpy2q0d`
- Model: `eleven_multilingual_v2`
- Output format: mp3
- Two TTS calls per session (greeting voice + fortune voice)
- API key from `.env` (`ELEVENLABS_API_KEY`)

---

## Display Hardware

- **Room 2:** 4K full-color projector
- **Input:** Standard keyboard
- **Visitor policy:** One in, one out. Each visitor gets a complete ceremony, then the system resets.

---

## Build

TypeScript with Bun's built-in bundler. No Vite, no webpack.

- `bun build client/main.ts --outdir public/dist` — bundles client modules
- `bun run server/index.ts` — starts the server

Dependencies:
- `@anthropic-ai/sdk` — Claude API
- `@elevenlabs/elevenlabs-js` — ElevenLabs TTS
- QR code library (e.g., `qrcode`)
- `nanoid` or use `crypto.randomUUID()` for fortune IDs

---

## Error Handling

If a Claude API or ElevenLabs call fails during the ceremony (network error, rate limit, timeout), the ceremony displays a brief error message ("the mask has lost its voice — please press any key to begin again") and resets to WELCOME. No retry logic — the next visitor gets a fresh attempt. The pre-fetched greeting system provides natural retry: if the pre-fetch fails, it retries on a backoff until successful.

---

## Deployment

The server must be accessible at a public URL for fortune pages to work after the installation. The `PUBLIC_URL` environment variable (in `.env`) configures the base URL used for QR code generation (e.g., `https://pallid-mask.example.com`). Fortune pages are served at `{PUBLIC_URL}/fortunes/{id}.html`. The deployment mechanism (VM, tunnel, static host) is outside this spec but the server must serve both the installation display and the fortune pages.

---

## What Is NOT In Scope

- Room 1 (Julian MC mode on CRT) — independent system, not designed here
- Communication between Room 1 and Room 2 — none required
- Visitor authentication or identity — anonymous, no accounts
- Fortune persistence beyond static HTML files — no database
- Analytics or logging — not required for the installation
