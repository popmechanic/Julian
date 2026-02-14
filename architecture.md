# Julian — Technical Architecture

Julian is a persistent, browser-based conversational agent built on Claude Code. A Bun server manages a long-lived Claude CLI subprocess and bridges its stream-json protocol to an SSE-driven React SPA. HTML artifacts (the agent's memory and creative output) live on the filesystem and are rendered in-browser via iframes. Deployed at **julian.exe.xyz**.

## Request Flow

```
Browser (index.html)
  │  Clerk JWT in Authorization header
  ▼
nginx (julian.exe.xyz:443)
  │  proxy_pass
  ▼
Bun server (server.ts, port 3847)
  │  stream-json on stdin
  ▼
claude CLI subprocess (persistent, --print mode)
  │  stream-json on stdout
  ▼
Bun server
  │  SSE (data: JSON\n\n)
  ▼
Browser (React state → Fireproof put)
  │
  ├─→ Chat messages displayed in sidebar
  └─→ Write tool detected → /api/artifacts poll → iframe render
```

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Bun | Server + process spawning |
| Server | `server.ts` (684 lines) | HTTP, SSE, process management |
| Frontend | `index.html` (3952 lines) | Single-file SPA, no build step |
| Framework | React 19 via CDN | ESM import maps, esm.sh |
| Transpiler | Babel Standalone 7.26 | In-browser JSX compilation |
| CSS | Tailwind Browser 4 + CSS variables | No build step |
| Auth (user) | Clerk | JWT verification via jose/JWKS |
| Auth (Claude) | Anthropic OAuth / setup-token | Three-tier priority |
| Storage | Fireproof (CRDT) | IndexedDB + cloud sync via Clerk |
| Font | VT323 (Google Fonts) | Monospace, retro terminal aesthetic |
| Design system | Vibes DIY (25 components) | BrutalistCard, VibesButton, HiddenMenuWrapper, etc. |

## Server (`server.ts`)

### Process Management

The server maintains a single persistent Claude CLI subprocess:

- **Spawn command**: `claude --print --input-format stream-json --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch`
- **Session resume**: If the process dies mid-conversation, `--resume <sessionId>` resumes the previous session. Session ID is captured from `result` events.
- **`ensureProcess()`**: Called before every turn. Respawns the subprocess if it has exited.
- **Deferred restart on token refresh**: If a token refresh occurs during an active turn (`activeListener !== null`), the process kill is deferred with a 2-second polling loop (max 5 minutes).

### HTTP Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/health` | Clerk JWT | Returns `{ status, processAlive, needsSetup, authMethod }` |
| `POST` | `/api/setup` | Clerk JWT | Saves `sk-ant-oat` token to `claude-auth.env`, restarts Claude |
| `GET` | `/api/oauth/start` | Clerk JWT | Generates PKCE challenge, returns Anthropic authorization URL |
| `POST` | `/api/oauth/exchange` | Clerk JWT | Exchanges authorization code for OAuth tokens, saves to `claude-auth.json` |
| `POST` | `/api/chat` | Clerk JWT | Sends message to Claude stdin, returns SSE stream of events |
| `GET` | `/api/artifacts` | Clerk JWT | Lists `*.html` files (excluding `index.html`) sorted by mtime desc |
| `GET` | `/api/artifacts/:filename` | None | Serves HTML artifact file (unauthenticated — iframes can't send Bearer headers) |
| `GET` | `/` or `/index.html` | None | Serves `index.html` (dev fallback; nginx serves in production) |
| `OPTIONS` | `*` | None | CORS preflight |

Static file whitelist (dev fallback): `fireproof-clerk-bundle.js`, `favicon.svg`, `favicon.ico`, `favicon-96x96.png`, `apple-touch-icon.png`, `site.webmanifest`, `sw.js`, PWA manifest icons.

### SSE Streaming

The `writeTurn()` function returns a `ReadableStream` that bridges Claude's stdout to SSE:

- **Turn sequencing**: A promise-chain lock (`turnLock`) ensures only one turn executes at a time. Each turn awaits the previous lock before proceeding.
- **Event forwarding**: Each JSON line from Claude stdout is wrapped as `data: {"type": <event.type>, "data": <event>}\n\n` and enqueued to the SSE stream.
- **Heartbeat**: `:heartbeat\n\n` comment every 5 seconds prevents connection kill during long thinking.
- **Inactivity timeout**: If no Claude events for 120 seconds, an error event is sent and the stream closes.
- **Max turn timeout**: 5-minute hard ceiling via `Promise.race`.
- **Bun `idleTimeout`**: Set to 255 seconds (Bun maximum) to prevent premature SSE disconnection.
- **Completion**: Stream sends `{"type": "done"}` and closes after the `result` event.

### Authentication — Dual Auth System

Julian has two independent auth layers serving different purposes:

#### Clerk (Application Layer)

Controls **who can access Julian's web UI**. Part of the Vibes framework.

- `ClerkFireproofProvider` wraps the app; `<SignedIn>` / `<SignedOut>` gates content.
- Frontend calls `window.Clerk.session.getToken()` to get a short-lived JWT.
- All protected endpoints (`/api/session/start`, `/api/session/end`, `/api/chat`) require `Authorization: Bearer <clerk-jwt>`.
- Server verifies JWTs via JWKS (`jose.jwtVerify()`) with 10s clock tolerance.
- JWKS URL derived from publishable key: base64-decode `pk_test_...` → Clerk frontend API domain → `https://<domain>/.well-known/jwks.json`.
- If no `VITE_CLERK_PUBLISHABLE_KEY`, auth is skipped (local dev mode).
- Health and OAuth endpoints are public (no Clerk auth required).

#### Anthropic OAuth (API Layer)

Provides **Claude Code API credentials**. Direct PKCE flow — no subprocess.

- **Credential priority**: (1) `~/.claude/.credentials.json` with valid `claudeAiOauth.accessToken`, (2) `~/.sculptor/credentials.json`, (3) legacy `claude-auth.env` with `sk-ant-oat` token.
- **PKCE flow**: Server generates verifier/challenge, stores in-memory `pendingPKCE` map. User authorizes at `claude.ai/oauth/authorize`, pastes code back. Server exchanges code + verifier for tokens.
- **Token refresh**: Proactive — if token expires within 30 minutes, auto-refreshes via `POST /v1/oauth/token` with `grant_type: refresh_token`. Checked at startup and before spawning Claude.
- **Token lifetime**: ~8 hours. Refresh tokens rotate on each refresh (old refresh token invalidated).
- **Credentials written** to `~/.claude/.credentials.json` with `mode: 0o600`.

#### Auth Flow (End to End)

```
User visits julian.exe.xyz
  → Clerk sign-in (application access)
  → If needsSetup: Anthropic OAuth PKCE flow (API credentials)
  → "Start Session" → Clerk JWT verified → Claude Code spawned with OAuth token
```

#### Gotchas

1. **Token endpoint requires JSON**: `Content-Type: application/json` only — `application/x-www-form-urlencoded` returns "Invalid request format".
2. **`state` required in token exchange body**: Non-standard — most OAuth providers only use `state` for CSRF validation on the redirect, but Anthropic's endpoint requires it in the exchange POST body.
3. **In-memory PKCE state**: `pendingPKCE` map lives in server memory — a server restart during an in-progress auth flow will invalidate the flow.
4. **8-hour token expiry**: Tokens expire after ~8 hours. Refresh happens proactively at 30 min before expiry.
5. **Refresh token rotation**: Each refresh invalidates the previous refresh token. If a refresh fails mid-way (network error after server accepts but before response), the old refresh token is gone.
6. **No auth during restart**: Don't restart the server while a user is in the middle of the OAuth flow — the `pendingPKCE` map will be lost.

### OAuth Constants

| Constant | Value |
|----------|-------|
| Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| Authorize URL | `https://claude.ai/oauth/authorize` |
| Token URL | `https://platform.claude.com/v1/oauth/token` |
| Redirect URI | `https://platform.claude.com/oauth/code/callback` |
| Scopes | `user:profile user:inference user:sessions:claude_code user:mcp_servers` |

## Frontend (`index.html`)

### Architecture

A single HTML file containing everything: CSS variables, Vibes design system components (25 pre-compiled React components in a `<script type="module">` block), and the main application in a `<script type="text/babel" data-type="module">` block transpiled by Babel Standalone at runtime.

**Module loading**: ESM import maps resolve `react`, `react-dom`, `@clerk/clerk-react`, `use-fireproof`, and `@fireproof/clerk` to CDN URLs (esm.sh) or local bundles (`/fireproof-clerk-bundle.js`).

### Auth Flow

1. `initApp()` dynamically imports `@fireproof/clerk`, exposing `ClerkFireproofProvider`, `SignedIn`, `SignedOut`, `SignInButton`.
2. `AppWrapper` wraps the app in `ClerkFireproofProvider` with publishable key from `window.__VIBES_CONFIG__`.
3. `SignedOut` renders `AuthGate` (Clerk modal sign-in).
4. `SignedIn` renders `HiddenMenuWrapper > App`.
5. All `/api/*` calls include `Authorization: Bearer <clerk-session-token>` via `getAuthHeaders()`.

### Setup Screen

Shown when `/api/health` returns `needsSetup: true`. Two tabs:

- **OAuth tab** ("Sign in with Anthropic"): Two-step flow — click to open Anthropic auth in new tab, paste authorization code back. Calls `/api/oauth/start` then `/api/oauth/exchange`. **Note: broken since Jan 2026** (Anthropic blocks third-party OAuth apps).
- **Legacy tab** ("Paste Token"): User runs `claude setup-token` in terminal, pastes `sk-ant-oat` token. Calls `POST /api/setup`. **This is the working path.**

Both tabs poll `/api/health` after setup until `processAlive && !needsSetup`.

### Chat Interface

**Layout**: Three states based on app state:
1. **Loading**: Yellow background, PixelFace, blinking "BOOTING..." text.
2. **Welcome** (no messages): Full-screen terminal panel with face, status, and centered input.
3. **Chat + Artifacts** (has messages): Two-column layout — 420px fixed-width chat sidebar + flexible artifact viewer.

**Message flow**:
1. User types in `ChatInput`, hits Enter.
2. `sendMessage()` writes user message to Fireproof database with `createdAt` key prefixed by conversation ID.
3. POST to `/api/chat` with `{ message: text }`.
4. SSE response parsed line-by-line. `assistant` events update `liveAssistant` state (streaming blocks). `result` event finalizes.
5. On `result`, assistant message is persisted to Fireproof.
6. `useLiveQuery("createdAt", { range })` provides sorted message list from Fireproof.
7. `liveAssistant` (in-flight message) is appended to the display list.

**Write tool detection**: When an SSE event contains a `tool_use` block with `name === "Write"` and a `.html` file path (not `index.html`), `loadArtifact()` is called after 1.5 seconds to auto-display the new artifact.

### Artifact System

- **Polling**: `refreshArtifacts()` calls `GET /api/artifacts` every 10 seconds.
- **Display**: `ArtifactViewer` renders a dropdown selector and an `<iframe>` pointed at `/api/artifacts/<filename>`.
- **Iframe sandbox**: `allow-scripts allow-popups allow-popups-to-escape-sandbox` (no `allow-same-origin`).
- **Open in new tab**: Direct link to `/api/artifacts/<filename>`.
- **Tracking**: CLAUDE.md maintains a manually-updated list of all artifacts with descriptions.

### Key Components

| Component | Purpose |
|-----------|---------|
| `PixelFace` | 32x32 pixel canvas animation — eyes blink randomly (2-5s interval), mouth animates when `talking` prop is true (150ms toggle) |
| `StatusDots` | Three dots, first glows yellow when connected |
| `ThinkingDots` | "> PROCESSING" with blinking cursor |
| `ToolCallBlock` | Displays tool name and formatted input (file paths for Read/Write/Edit, commands for Bash, patterns for Glob/Grep) |
| `MessageBubble` | Renders user messages (prefixed `//`) or assistant messages (blocks: text with markdown, tool_use) |
| `ChatInput` | Text input + circular "A" send button, Enter to send |
| `ArtifactViewer` | Dropdown artifact selector + iframe viewer with CRT scanline overlay |
| `SetupScreen` | Tabbed OAuth/legacy token setup |
| `App` | Main app: Fireproof database, SSE streaming, artifact polling, conversation management |
| `AppWrapper` | Clerk auth gate, error boundaries |

**Vibes design system** (25 components, pre-compiled in `<script type="module">`):
`useMobile`, `useIsMobile`, `BackIcon`, `InviteIcon`, `LoginIcon`, `RemixIcon`, `SettingsIcon`, `GoogleIcon`, `GitHubIcon`, `MoonIcon`, `SunIcon`, `BrutalistCard`, `LabelContainer`, `AuthScreen`, `VibesSwitch`, `HiddenMenuWrapper`, `VibesButton`, `VibesPanel`, plus style helpers. All exposed on `window.*` for cross-script access.

### Styling

- **Theme**: Yellow (#FFD600) background, black (#0F0F0F) terminal panels, amber (#AA8800) secondary text
- **Font**: VT323 monospace throughout, loaded from Google Fonts
- **CRT effect**: Scanline overlay via CSS gradients (`linear-gradient` at 2px/3px intervals, 8-10% opacity)
- **CSS variables**: Vibes design system variables for colors, buttons, cards (see `:root` block)
- **Mobile breakpoint**: 768px (via `useMobile` / `useIsMobile` hooks)
- **Scrollbar**: Custom dark theme (6px width, #333 thumb, #FFD600 on hover)
- **PWA**: Service worker registration, theme-color meta, apple-mobile-web-app-capable

## Data Flow & Storage

### Three Storage Layers

| Layer | What | Where | Sync |
|-------|------|-------|------|
| Filesystem | HTML artifacts (~37 files) | `/opt/julian/*.html` (prod), `WORKING_DIR` (dev) | None (manual rsync deploy) |
| Fireproof CRDT | Chat messages | IndexedDB + cloud sync via Clerk auth | Automatic cross-device |
| Server memory | OAuth tokens (also persisted to JSON/env), PKCE state, turn lock, session ID | Bun process | Lost on restart (except token files) |

### Message Lifecycle

```
User types → ChatInput.handleSend()
  → database.put({ type:"message", role:"user", text, createdAt, conversationId })
  → POST /api/chat { message: text }
  → writeTurn() acquires lock, writes JSONL to Claude stdin
  → Claude stdout events → activeListener → SSE enqueue
  → Browser: ReadableStream reader → parse SSE lines → setLiveAssistant()
  → On result event: database.put({ type:"message", role:"assistant", blocks })
  → setLiveAssistant(null), release lock
```

### Artifact Lifecycle

```
Claude executes Write tool → file written to WORKING_DIR
  → Frontend detects Write tool_use in SSE stream
  → setTimeout(loadArtifact, 1500) for the written filename
  → GET /api/artifacts returns updated file list
  → ArtifactViewer sets activeArtifact → iframe src updates
  → Developer manually updates CLAUDE.md artifact tracking list
```

### Conversation ID

- Generated as `conv-<base36-timestamp>-<random>` on first load.
- Stored in `localStorage` under key `claude-hackathon-conv-id`.
- Used as Fireproof query range prefix for message isolation.
- "NEW" button generates a fresh ID and reloads the page.

## Deployment

**Production**: `julian.exe.xyz`

- nginx reverse-proxies to Bun on port 3847
- nginx serves static files directly; Bun serves them only as dev fallback
- Files live at `/opt/julian/` on the server

**Deploy process** (manual):

```bash
rsync server.ts index.html *.html /opt/julian/ user@julian.exe.xyz:/opt/julian/
ssh julian.exe.xyz "cd /opt/julian && bun server.ts"
```

No CI/CD pipeline. No automated tests.

## Configuration Reference

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3847` | Bun HTTP server port |
| `WORKING_DIR` | `process.cwd()` | Directory for Claude subprocess and artifact storage |
| `ALLOWED_ORIGIN` | `*` | CORS `Access-Control-Allow-Origin` header |
| `VITE_CLERK_PUBLISHABLE_KEY` | (none) | Clerk publishable key for JWT verification |

### Auth File Locations

| File | Format | Purpose |
|------|--------|---------|
| `claude-auth.json` | `{ access_token, refresh_token, expires_at }` | OAuth tokens (preferred) |
| `claude-auth.env` | `KEY=value` lines | Legacy setup-token storage |

### Frontend Config

Set in `window.__VIBES_CONFIG__` (hardcoded in index.html):

```js
{
  tokenApiUri: "https://vibes-share-studio.exe.xyz/api/",
  cloudBackendUrl: "fpcloud://vibes-share-studio.exe.xyz?protocol=wss",
  clerkPublishableKey: "pk_test_..."
}
```

## Known Issues & Debt

- **OAuth flow working**: Direct PKCE flow (no subprocess) implemented in server.ts. Legacy `sk-ant-oat` token paste also supported as fallback.
- **Monolithic `index.html`**: 3952 lines with no build step means no code splitting, tree shaking, or minification. The Vibes design system alone is ~1500 lines of pre-compiled React components.
- **Manual SSE parsing**: The frontend manually reads the response body stream and parses `data: ` lines. Could use the native `EventSource` API (though POST support would require a wrapper).
- **Artifact polling**: 10-second interval poll to `/api/artifacts`. Could use filesystem watch + WebSocket push for instant updates.
- **No CI/CD**: Manual rsync + ssh deploy.
- **No automated tests**: No unit, integration, or e2e tests.
- **Iframe sandbox**: Artifacts run with `allow-scripts` but without `allow-same-origin`, limiting their access to parent page APIs. This is intentional for security but limits artifact-to-app communication.
- **Backup file accumulation**: 17 `index.*.bak.html` files in the project root from iterative development.
- **Single-process architecture**: One Claude subprocess serves all users. No horizontal scaling or user isolation.
