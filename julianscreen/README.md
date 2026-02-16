# JulianScreen

640x480 pixel display SDK for Claude Code agents. 20x15 tile grid (32px tiles). Send text commands, get animated pixel art.

## Quick Start

```bash
cd julianscreen
bun run start
# Open http://localhost:3848 in browser
```

## Usage

Send commands via HTTP POST:

```bash
# Set background and avatar
curl -X POST localhost:3848/cmd -d 'BG home
P 4 3
S idle
T Hello!'

# Trigger animation
curl -X POST localhost:3848/cmd -d 'S thinking
W 800
S talking
T Working on it...
W 2000
S happy
F sparkle
T Done!'

# Add interactive buttons
curl -X POST localhost:3848/cmd -d 'BTN yes 2 5 YES
BTN no 5 5 NO
LISTEN btn'

# Poll for button clicks
curl localhost:3848/feedback
# → [{"type":"BTN","id":"yes"}]
```

## Architecture

```
Agent (curl) → POST /cmd → Bun server :3848 → WebSocket → Browser canvas
Browser clicks → WebSocket → Server queue → GET /feedback → Agent (curl)
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/cmd` | POST | Send commands (newline-delimited text body) |
| `/feedback` | GET | Poll feedback events (returns JSON array, clears queue) |
| `/health` | GET | Server status |
| `/ws` | WS | WebSocket for browser client |

See [protocol.md](protocol.md) for the full command reference.
