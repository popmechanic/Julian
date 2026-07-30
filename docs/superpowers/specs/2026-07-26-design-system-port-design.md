# Design System Port — Legacy Julian UI into the Svelte App

**Date:** 2026-07-26
**Branch:** `ultra/integration-20260726-012506` (all work stays here; no merge to main)
**Approved intent (Marcus):** a clean, pixel-for-pixel port of the legacy Julian UI.
The Svelte app must look essentially identical to the pre-rewrite app for every
feature it has. Features that did not survive the rewrite (agents, jobs, ledger,
browser) are NOT faked in the chrome; their navigation returns when they do.

## Sources of truth

| Source | What it provides |
|---|---|
| `index.html` lines 111–273 | Global style block: timing/easing tokens, button press feedback, `message-enter`, scrollbars, reduced-motion, hover guards |
| `index.html` lines ~1840–1915 | App-level CSS: yellow body, `×` corner marks, selection color, scrollbar hover |
| `index.html` lines ~1917–2450 | Desktop + mobile layout composition (yellow room, left machine, right console, glass tab bar) |
| `chat.jsx` | Component styling: MessageBubble, ChatInput, ToolCallBlock, ThinkingDots, SetupScreen, ArtifactViewer, JulianScreenEmbed, StatusDots, PixelFace sprite data + canvas renderer |
| `index.html` lines 1–110 | `SoundManager` (event-driven SFX, mute persistence) |
| `sfx/` | 15 placeholder mp3s (Marcus will redo the palette later; pure asset swap) |

Legacy mobile breakpoint: `window.innerWidth < 768`.

## 1. Token layer — `app/src/app.css`

Replace the placeholder file with the full design system as CSS custom properties
on `:root`, plus the shared vocabulary as global classes/keyframes.

Colors:

```
--j-yellow: #FFD600;        /* shell, my text, my color */
--j-yellow-key: #C8A800;    /* keyboard input, tool-call rule */
--j-yellow-dim: #AA8800;    /* dim labels, secondary buttons */
--j-yellow-black: #1A1A00;  /* yellow-tinted black (code bg, NEW button) */
--j-crt-0: #0A0A0A;         /* screen embed bg */
--j-crt-1: #0C0C0C;         /* right console bg */
--j-crt-2: #0F0F0F;         /* chat machine panels */
--j-bezel: #2A2A2A;         /* 4px panel borders */
--j-cyan: #00AFD1;          /* secondary accent: active tabs, actions */
--j-red: #FF4444;  --j-red-soft: #FF6B6B;  --j-red-black: #1A0000;
--j-green: #22C55E; --j-green-soft: #4ADE80;
--j-amber: #F59E0B;
--j-gray-{333,444,555,666,999}, --j-text: #E5E5E5, --j-text-dim: #CCC;
```

Type and motion:

```
--font-terminal: 'VT323', monospace;
--font-ui: 'Inter', sans-serif;
--ease-out: cubic-bezier(0.25, 0.46, 0.45, 0.94);
--ease-out-quart: cubic-bezier(0.165, 0.84, 0.44, 1);
--duration-fast: 100ms; --duration-standard: 150ms; --duration-slow: 250ms;
```

Global rules (verbatim ports): body = yellow shell + `×` corner pseudo-elements;
`::selection`; 6px scrollbars (`#333` thumb, yellow hover); button press feedback
(`scale(0.97)` active, yellow focus ring); keyframes `message-enter`, `blink`,
`thinking-pulse`, `pulse-warn`, `pulse-dot`, `fadeIn`, `screen-icon-glow`;
`.scanlines` overlay class (the repeated CRT gradient, extracted since it appears
five times in legacy code); `prefers-reduced-motion` kill switch; hover effects
gated behind `(hover: hover) and (pointer: fine)`.

Fonts: self-host as woff2 in `app/public/fonts/`, declared via `@font-face` in
`app.css`: VT323 (single regular weight) and the Inter variable font (one file
covers the 300–700 range the legacy UI uses). No Google Fonts runtime
dependency. Both are OFL-licensed.

## 2. Layout port — `App.svelte`

Desktop (≥768px): yellow room (`padding: 16px`, `gap: 16px`, flex row).

- **Left machine, 420px (min 320):** three stacked panels, `--j-crt-2` on 4px
  `--j-bezel` borders, 12px outer radii, dashed `#333` internal separators,
  inset shadows top and bottom.
  - *Face header:* `SYS.VER` label (VT323 0.75rem, dim yellow, letterspaced),
    StatusDots top-right, PixelFace (56px) + JULIAN title (VT323 1.4rem yellow) +
    status line (OFFLINE / PROCESSING... / LISTENING, dim yellow), NEW and END
    buttons (VT323, yellow-black / red-black chips).
  - *Messages panel:* scrollable, `.scanlines` overlay, MessageBubbles.
  - *Input footer:* START SESSION state (yellow button, 2px black border,
    `3px 3px 0 #000` shadow) or ChatInput.
- **Right console, flex 1:** `--j-crt-1`, 1px `#333` border, 12px radius.
  Glass tab bar (48px, `rgba(255,255,255,0.03)` + `backdrop-filter: blur(10px)`,
  hairline bottom): Inter 10px uppercase letterspaced pill tabs — active = cyan
  fill, black text, cyan glow; inactive = ghost with cyan hover. Tabs: SCREEN,
  ARTIFACTS (only features that exist; the bar accepts more as features return).
  Right side of bar: SyncStatus dot + SFX mute toggle.

Mobile (<768px): legacy stacked variant — compact face header with bottom bezel
border, ScreenEmbed in 4:3, artifact viewer replaces chat when an artifact is
open (CLOSE VIEWER chip), chat panel + input at bottom.

## 3. Component restyles (pixel-for-pixel mappings)

| Svelte component | Legacy source | Key treatments |
|---|---|---|
| `MessageBubble` | chat.jsx MessageBubble/ToolCallBlock/ThinkingDots | `> ` prefix + yellow VT323 1.1rem for Julian; `// ` prefix + white/80% for user; blink `_` cursor while streaming; `> PROCESSING` + three pulse dots while thinking; tool calls: 3px `--j-yellow-key` left rule, `[NAME]` uppercase dim yellow, gray args; markdown code blocks on `--j-yellow-black` |
| `ChatInput` | chat.jsx ChatInput | `--j-yellow-key` inset "keyboard" textarea (VT323 uppercase, bold black, autogrow 50→200px with 150ms height animation) + 60px round **A** button (`#E5E5E5`, `0 4px 0 #999` 3D press, translateY on :active) |
| `ChatView` | index.html messages panel | CRT panel + scanlines; smooth scroll |
| `SessionBar` | index.html face header | Becomes the face header described above (absorbs NEW/END/status) |
| `SetupScreen` | chat.jsx SetupScreen | Dark `--j-crt-2` full-screen panel, tabbed shell, Inter body type. Contents change again in the Pocket ID spec; this pass ports the shell + button/input vocabulary |
| `ArtifactPanel` / `ArtifactTree` | chat.jsx ArtifactViewer | Retro dropdown pill, round `↗` open-in-tab button, 8×8 pixel-grid empty state with `> SELECT ARTIFACT...` captions |
| `ScreenEmbed` | chat.jsx JulianScreenEmbed | 4px bezel, 12px radius, scanline overlay, yellow/red connection dot (mostly present; align exactly) |
| `SyncStatus` | legacy StatusDots idiom | Small labeled dot, VT323, green/yellow/red states |

## 4. PixelFace port

New `app/src/components/PixelFace.svelte` + `app/src/lib/faces.ts`: sprite data
(eye/mouth variants) and the canvas renderer from `chat.jsx` (~lines 166–460),
TypeScript-strict, Svelte 5 runes (`$props`, `$effect` for canvas redraw).
Driven by existing state: `talking` = `processing`, size 56 in header.
Only Julian's own face is needed (agent variants/colors stay in the source for
the day agents return, but no agent UI ships).

## 5. Sound — placeholder port

New `app/src/lib/sfx.ts`: named-event player (`boot`, `tab`, `open`, `close`,
`select`, `error`, `success`, `notification`, `shutdown`, …) mapped to
`/sfx/*.mp3`, volume 0.40, mute toggle persisted to `localStorage`
(`julian-sfx-muted`), boot sound gated on first user gesture. Wire the legacy
trigger points that exist in the Svelte app: boot, tab switch, session
start/end, error. Mute button lives in the tab bar. The mp3s are explicitly
placeholders — Marcus intends to redo the sound palette; swapping files is the
whole upgrade path. Serve `sfx/` through the Bun server if not already reachable.

## 6. Error handling

Purely presentational work — no new failure modes. Sound playback failures are
swallowed (legacy behavior: audio errors never break UI). Missing font files
fall back to `monospace`/`sans-serif` stacks.

## 7. Testing & verification

- Per-package suites stay green: `bun install && bunx vitest run` in app (16
  tests incl. store regression + ScreenEmbed behavior), plus `svelte-check`
  with 0 errors. Existing component tests must not lose coverage.
- New unit tests where logic is added: `sfx.ts` (mute persistence, event→file
  map), `faces.ts` (sprite lookup), autogrow height clamp if extracted.
- Visual verification in Chrome: legacy app (port 8000) vs new app (PORT=8099)
  side-by-side, surface by surface: setup, idle (no session), active session,
  streaming, tool call, artifact open, screen tab, mobile width (<768).
- No changes to: `memory/`, `soul/`, letter pipeline, JulianScreen server,
  sync worker, store schemas. TypeScript strict throughout.

## Out of scope

Agents/jobs/ledger/browser features and their tabs; redesigned sounds; any
functional change to chat/sync/auth (auth is the companion spec); rebuilding
the legacy canvas menu inside JulianScreen (owned by the JulianScreen server).
