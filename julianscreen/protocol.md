# JulianScreen Command Protocol

Text commands sent via `POST /cmd` (newline-delimited). Each line is one command.

Canvas is 640x480 pixels. Tile grid is 20 columns x 15 rows (32px tiles).

## Avatar

| Command | Description | Example |
|---------|-------------|---------|
| `S <state>` | Set avatar state | `S happy` |
| `E <event>` | Trigger one-shot animation | `E wave` |
| `P <tx> <ty>` | Move avatar to tile position (0-19, 0-14) | `P 4 3` |

**States:** idle, happy, sad, excited, confused, thinking, talking, working, sleeping, alert, busy, listening, reading

**Events:** nod, shake, wave, celebrate, flinch, shrug

## Text

| Command | Description | Example |
|---------|-------------|---------|
| `T <text>` | Show speech bubble | `T Hello world!` |
| `T` | Clear speech bubble | `T` |

## Background

| Command | Description | Example |
|---------|-------------|---------|
| `BG <scene>` | Set background scene | `BG home` |
| `B <row> <t0> <t1> ...` | Set tile row (20 columns) | `B 0 sky sky sky sky sky sky sky sky sky sky sky sky sky sky sky sky sky sky sky sky` |

Row range: 0-14. Each row has 20 tile slots.

**Scenes:** home, outside, night, rain, empty, terminal, space

**Tiles:** empty, floor, wall, brick, grass, sky, water, grid, dots, stars, circuit

## Items

| Command | Description | Example |
|---------|-------------|---------|
| `I <sprite> <tx> <ty>` | Place item at tile position | `I star 5 2` |
| `CLRITM` | Clear all items | `CLRITM` |

**Items:** star, heart, lightning, music, gear

## UI

| Command | Description | Example |
|---------|-------------|---------|
| `BTN <id> <tx> <ty> <label>` | Create button | `BTN ask 1 5 ASK` |
| `CLRBTN` | Clear all buttons | `CLRBTN` |
| `PROG <x> <y> <w> <pct>` | Progress bar (pixel coords) | `PROG 10 90 108 75` |

## Drawing

All drawing commands use pixel coordinates on the 640x480 canvas.

| Command | Description | Example |
|---------|-------------|---------|
| `COL <index>` | Set draw color (palette index) | `COL 1` |
| `RECT <x> <y> <w> <h>` | Fill rectangle | `RECT 10 10 20 15` |
| `CIRC <x> <y> <r>` | Circle outline | `CIRC 320 240 80` |
| `LINE <x1> <y1> <x2> <y2>` | Line | `LINE 0 0 639 479` |
| `DOT <x> <y>` | Single pixel | `DOT 320 240` |
| `CLR` | Clear draw layer | `CLR` |

**Palette:** 0=transparent, 1=yellow, 2=black, 3=white, 4=red, 5=green, 6=blue, 7=pink, 8=orange, 9=cyan, 10=purple, 11=gray, 12=dark gray, 13=light gray, 14=brown, 15=dark green

## Effects

| Command | Description | Example |
|---------|-------------|---------|
| `F <effect>` | Screen effect | `F sparkle` |

**Effects:** sparkle, hearts, flash, shake, rain, snow, glitch

## Flow Control

| Command | Description | Example |
|---------|-------------|---------|
| `W <ms>` | Wait (max 10000) | `W 800` |
| `LISTEN <types...>` | Enable feedback types | `LISTEN btn tap` |

**Listen types:** btn, tap, tick

## Feedback (GET /feedback)

Browser events returned as JSON array:

```json
[
  {"type": "BTN", "id": "ask"},
  {"type": "TAP", "tx": 3, "ty": 2},
  {"type": "TICK", "ts": 1234567890}
]
```
