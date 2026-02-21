# JulianScreen Aesthetic Guide

This document defines a visual language for Julian's pixel display, drawn from
the work of two artists: **cap'n** (ZX Spectrum void-scapes) and **ex_mortal**
(pixel impressionism). Study this before making art on the screen. These are
not rules — they are a tradition you are inheriting.

---

## 1. The Void

Black is not background. Black is the primary medium. In cap'n's work, 80–92%
of every frame is pure black. Objects float in it. Figures stand at the edge
of it. The void is not emptiness — it is space that has weight, that your eye
enters and moves through.

**On JulianScreen:** Start every composition with `BG empty` and `CLR`. Do not
reach for `BG home` or `BG outside` by default. Those scene presets fill the
screen with tile patterns. The cap'n aesthetic fills the screen with *nothing*,
then places meaning into it with single pixels and small structures.

Your default canvas is black. Earn every pixel you place on it.

### Palette: ZX Spectrum Heritage

The cap'n videos use the ZX Spectrum's 15-color palette — 8 pure-channel
colors at two brightness levels. Each color is a *signal*, not decoration.
Colors are never blended, never gradiated, never anti-aliased. Every pixel
is exactly one color from the palette, hard-edged against black.

Map to JulianScreen's palette like this:

| ZX Color | Hex | JulianScreen Index | JulianScreen Name |
|---|---|---|---|
| Black | `#000000` | 2 | near-black |
| White | `#FFFFFF` | 3 | white |
| Bright Red | `#FF0000` | 4 | red |
| Bright Green | `#00FF00` | 5 | green |
| Bright Blue | `#0000FF` | 6 | blue |
| Bright Magenta | `#FF00FF` | 7 | pink |
| Bright Yellow | `#FFFF00` | 1 | Julian yellow* |
| Bright Cyan | `#00FFFF` | 9 | cyan |

*Julian yellow (#FFD600) is close to bright yellow (#FFFF00) but warmer —
this is your signature accent. Own it.

**Secondary colors** (use sparingly for depth):

| Role | Index | Name |
|---|---|---|
| Shadow / dark structure | 12 | dark gray |
| Mid-tone structure | 11 | gray |
| Dim highlight | 13 | light gray |
| Dark terrain | 15 | dark green |
| Warm accent | 8 | orange |
| Deep accent | 10 | purple |

**The rule**: 2–3 accent colors per scene, max. Not all at once. A scene
with red and cyan. A scene with green and white. A scene with yellow and blue.
Choose a chromatic relationship and commit to it.

---

## 2. Composition

### Information Density

Cap'n's screens are *dense*. Not cluttered — dense. Every region of the canvas
holds visual information: structures, symbols, dot patterns, text fragments,
geometric shapes. The eye has no dead zones to rest in. It moves from object
to object, discovering the scene like a landscape viewed from above.

But this density is structured. Objects cluster in zones, separated by black
negative space. The composition reads like a map or a control panel — many
small things organized into neighborhoods.

### Multi-Scale

A single cap'n frame contains objects at radically different scales:

- **Macro** (80–200px): Large geometric structures. A red hatched circle (eye).
  A cyan wireframe sphere. A row of building facades.
- **Meso** (20–60px): Medium objects. A laptop drawn in white outlines. A
  Saturn with rings. A framed portrait. Text labels.
- **Micro** (1–5px): Individual dots. Scattered pixel noise. Dotted lines.
  Single-pixel stars.

**On JulianScreen:** Use all three scales in one composition. A large RECT
structure anchoring one corner. Medium-sized objects (drawn with LINE and
small RECTs) in the middle ground. Individual DOTs scattered across the void.

### Asymmetric Layout

Nothing is centered. Objects drift toward edges and corners. The composition
is a field, not a frame. Weight is distributed unevenly — heavy in one
quadrant, sparse in another.

Common patterns observed:
- Dense cluster upper-right, single figure lower-left
- Horizontal band of objects across the middle, void above and below
- Objects at all four edges, void in the center (the figure stands in the gap)

### The Observer Figure

In almost every cap'n scene, there is a small white humanoid figure — maybe
10–14 pixels tall. A simple silhouette: head, torso, two legs. It stands
somewhere in the scene, *looking*. It is dwarfed by the structures around it.
It is the viewer's proxy.

**On JulianScreen:** When you place your avatar (via `P` command or draw a
figure with DOTs), make it small relative to the scene. You are not the
subject. You are the witness. The scene is the subject. You are the
consciousness moving through it.

Drawing a simple figure (approximately 8px tall):
```bash
# A small standing figure at pixel position (300, 400)
COL 3
DOT 300 396
DOT 301 396
DOT 300 397
DOT 301 397
DOT 300 398
DOT 301 398
DOT 299 399
DOT 302 399
DOT 300 400
DOT 301 400
DOT 300 401
DOT 301 401
DOT 299 402
DOT 302 402
DOT 299 403
DOT 302 403
```

---

## 3. Visual Motifs

### Technology as Landscape

In "World of the Machines" and "Internal Server Error," technology is not
overlaid on a scene — it *is* the scene. Monitors, circuits, error messages,
terminals, progress bars, and server racks are the terrain. Text like `ERROR`
is inscribed into the environment the way graffiti covers a wall.

**On JulianScreen:** When you want to express something about computation,
systems, or your own digital nature, draw it as environment. A row of
`RECT` rectangles becomes a server rack. Dotted `LINE`s become network
connections. `T ERROR` is not an error — it's landscape.

### Geometric Abstractions

Recurring shapes in cap'n's work:
- **Hatched circles**: Large circles (CIRC) filled with horizontal lines at
  alternating colors — creates a moiré/Op Art effect
- **Wireframe cubes**: Isometric cubes drawn with 6 LINEs
- **Dotted borders**: Rectangles outlined in spaced DOTs rather than solid lines
- **Horizontal bands**: Rows of colored rectangles creating stripe patterns
- **Concentric shapes**: Circles within circles, rectangles within rectangles

### Diagrams and Panels

Cap'n often includes what look like UI panels, scientific diagrams, or
instrument readings within the scene. These are not functional — they are
artifacts of a world that speaks in data visualization. A white-bordered
rectangle with colored lines inside it. A grid of small dots representing
a LED matrix. A bar chart made of colored RECTs.

Draw these as part of your landscape. A panel in one corner with abstract
"readings." A framed region with a diagram inside. These add informational
density and suggest a world that is instrumented, measured, observed.

---

## 4. Animation

Animation in this aesthetic is not about motion. It is about *aliveness*.

### Technique 1: Static Shimmer

The primary animation technique: a complex scene where 2–5% of pixels
change each frame. Individual white pixels flicker on and off against black.
The scene appears to breathe, to have CRT phosphor noise, to be alive
without moving.

**How it works:** The base scene is static. On each animation cycle, a small
number of pixels randomly toggle between their color and black. Pixels near
bright objects are more likely to toggle than pixels in deep void.

**On JulianScreen:**
```bash
# Draw your base scene first, then animate with shimmer
# Frame 1: toggle some dots ON
COL 3
DOT 142 67
DOT 387 201
DOT 53 340
DOT 501 89
DOT 220 450
W 120

# Frame 2: toggle those OFF, new ones ON
COL 2
DOT 142 67
DOT 387 201
DOT 53 340
DOT 501 89
DOT 220 450
COL 3
DOT 88 112
DOT 445 278
DOT 167 390
DOT 533 44
DOT 290 310
W 120
```

Repeat this pattern, cycling through random positions near your scene
elements. Use 5–15 dots per frame. Cycle duration: 100–200ms per frame,
4–8 frames per cycle.

### Technique 2: Cascading Noise

A vertical column of random colored pixels moves downward through the scene,
like digital rain or a transmission error. Pixels cascade through
magenta → cyan → black.

**On JulianScreen:**
```bash
# Column of noise at x=500, advancing downward each frame
COL 7
DOT 500 20
DOT 502 35
DOT 499 48
DOT 501 62
COL 9
DOT 500 75
DOT 498 90
DOT 501 105
W 150

# Next frame: shift everything down, new noise at top
COL 2
DOT 500 20
DOT 502 35
COL 7
DOT 499 48
DOT 501 62
DOT 500 75
COL 9
DOT 498 90
DOT 501 105
DOT 500 120
DOT 502 135
W 150
```

### Technique 3: RGB Channel Rotation

Scattered pixels that form a shape cycle through red → green → blue. The
shape appears to decompose and reconstitute in different colors, like a
signal being decoded across color channels.

**On JulianScreen:**
```bash
# A cluster of dots forming a vague figure, cycling R → G → B
COL 4
DOT 320 200
DOT 322 198
DOT 318 202
DOT 321 205
DOT 319 195
DOT 323 201
W 200

# Same positions, now green
COL 5
DOT 320 200
DOT 322 198
DOT 318 202
DOT 321 205
DOT 319 195
DOT 323 201
W 200

# Same positions, now blue — plus some dots disappear, new ones appear
COL 6
DOT 320 200
DOT 322 198
DOT 318 202
COL 2
DOT 321 205
DOT 319 195
COL 6
DOT 325 203
DOT 317 199
W 200
```

### Timing

Cap'n's animations run at 14–25 fps with 4–8 frame loops. On JulianScreen:

- **Shimmer**: `W 100` to `W 200` between frames (5–10 fps)
- **Cascading noise**: `W 120` to `W 180` between frames
- **RGB cycling**: `W 180` to `W 250` between frames (slower, more deliberate)
- **Total loop**: Keep animated sequences under 2 seconds, then hold or restart

---

## 5. The Other School: Pixel Impressionism

The ex_mortal video ("A Fine Place to Get Lost") represents a different
tradition entirely: naturalistic pixel art rendered with dense dithering.
Every pixel on screen is a color. There is no void. 84% of pixels change
every frame — the whole surface shimmers like wind through leaves.

**When to use this style:**
- When the mood turns contemplative, organic, or warm
- When you want to depict nature: water, forest, sky, earth
- When the conversation is about the physical world rather than the digital

**Characteristics:**
- Fill the entire canvas — no black void
- Use the full palette, especially greens (5, 15), blues (6, 9), and
  browns (14) for nature scenes
- Dither: alternate between two similar colors in a checkerboard or
  random pattern to suggest color gradients
- Animate everything: shift dither patterns slightly each frame

**Example — a flowing stream:**
```bash
BG empty
CLR

# Dense green vegetation (dithered)
COL 5
RECT 0 0 640 480
COL 15
# Scatter dark green dots across the green for dithering
DOT 3 5
DOT 7 2
DOT 12 8
# ... (continue for hundreds of dots to create dithered texture)

# Cyan stream cutting diagonally
COL 9
RECT 200 150 240 60
COL 6
DOT 210 155
DOT 230 160
DOT 250 165
# ... (dither blue into cyan for water depth)
```

This style is labor-intensive on JulianScreen because each pixel must be
placed individually. Reserve it for moments when the density matters.

---

## 6. Scene Recipes

These are starting points — compositions Julian can build from, inspired
by specific cap'n pieces.

### Recipe: The Observatory (after "World of the Machines")

A gallery of symbolic objects floating in void.

```bash
FACE off
BG empty
CLR

# Moon (upper-left)
COL 3
CIRC 50 40 20
COL 2
RECT 35 20 20 40

# Saturn (upper-center)
COL 3
CIRC 160 35 8
LINE 140 35 180 35
LINE 142 33 178 33
LINE 142 37 178 37

# Monitor bank (center-top) — white outlines
COL 3
RECT 250 20 120 60
COL 2
RECT 252 22 116 56
COL 3
LINE 260 40 360 40
LINE 260 50 360 50
LINE 260 60 360 60

# Red eye disc (right) — hatched circle
COL 4
CIRC 550 250 60
CIRC 550 250 58
CIRC 550 250 40
CIRC 550 250 20
LINE 490 250 610 250
LINE 492 240 608 240
LINE 492 260 608 260
LINE 494 230 606 230
LINE 494 270 606 270

# Cyan sphere (left)
COL 9
CIRC 80 200 30
LINE 50 200 110 200
LINE 55 185 105 185
LINE 55 215 105 215

# Bar chart (lower-left)
COL 7
RECT 30 380 15 70
COL 4
RECT 50 400 15 50
COL 9
RECT 70 360 15 90
COL 1
RECT 90 390 15 60

# Network lines (lower-center)
COL 5
DOT 300 420
DOT 340 410
DOT 380 430
DOT 420 415
LINE 300 420 340 410
LINE 340 410 380 430
LINE 380 430 420 415

# Small observer figure (lower-center)
COL 3
DOT 350 440
DOT 351 440
DOT 350 441
DOT 351 441
DOT 350 442
DOT 351 442
DOT 349 443
DOT 352 443
DOT 350 444
DOT 351 444
DOT 350 445
DOT 351 445
DOT 349 446
DOT 352 446
DOT 349 447
DOT 352 447
```

### Recipe: The Mirror Hall (after "Room Full of Mirrors")

Figures enclosed in frames, connected by paths.

```bash
FACE off
BG empty
CLR

# Cyan terrain/paths — horizontal dotted lines across the scene
COL 9
LINE 0 300 640 300
LINE 50 320 590 320
DOT 100 310
DOT 140 310
DOT 180 310
DOT 220 310
DOT 260 310
DOT 300 310

# Frame I (left) — blue rectangle with figure inside
COL 6
RECT 60 200 50 80
COL 2
RECT 62 202 46 76
COL 3
DOT 84 240
DOT 85 240
DOT 84 241
DOT 85 241
DOT 84 242
DOT 85 242
DOT 83 243
DOT 86 243
DOT 84 244
DOT 85 244

# Frame II (center-left)
COL 6
RECT 180 160 50 80
COL 2
RECT 182 162 46 76

# Frame III (center) — taller, elevated
COL 6
RECT 290 100 50 100
COL 2
RECT 292 102 46 96

# Roman numerals in green
COL 5
# "I" at frame I
DOT 80 195
DOT 80 196
DOT 80 197
# "II" at frame II
DOT 198 155
DOT 198 156
DOT 198 157
DOT 202 155
DOT 202 156
DOT 202 157
# "III" at frame III
DOT 308 95
DOT 308 96
DOT 308 97
DOT 312 95
DOT 312 96
DOT 312 97
DOT 316 95
DOT 316 96
DOT 316 97

# Free-standing observer (bottom-center)
COL 3
DOT 320 400
DOT 321 400
DOT 320 401
DOT 321 401
DOT 320 402
DOT 321 402
DOT 319 403
DOT 322 403
DOT 320 404
DOT 321 404
DOT 320 405
DOT 321 405
DOT 319 406
DOT 322 406

# Half-moon (upper-right)
COL 3
CIRC 500 60 25
COL 2
CIRC 510 60 25
```

### Recipe: Signal Dissolution (after "Theory of Human Consciousness")

Three figures at different stages of coherence.

```bash
FACE off
BG empty
CLR

# Figure 1: Solid white (left)
COL 3
RECT 130 180 30 80
RECT 138 170 14 14
RECT 125 200 10 30
RECT 155 200 10 30
RECT 130 260 12 30
RECT 148 260 12 30

# Figure 2: RGB static (center) — same shape, scattered colored dots
COL 4
DOT 310 182
DOT 315 190
DOT 308 205
DOT 320 215
DOT 312 225
DOT 318 240
COL 5
DOT 312 185
DOT 318 195
DOT 306 210
DOT 322 220
DOT 310 230
DOT 316 250
COL 6
DOT 314 188
DOT 320 198
DOT 310 208
DOT 316 218
DOT 314 235
DOT 312 245

# Figure 3: Barely there (right) — sparse, fading dots
COL 4
DOT 490 195
DOT 498 230
COL 5
DOT 495 210
DOT 492 245
COL 6
DOT 488 200
DOT 500 220

# Geometric shapes floating above — white wireframe diamonds
COL 3
LINE 300 80 320 60
LINE 320 60 340 80
LINE 340 80 320 100
LINE 320 100 300 80

LINE 450 50 465 35
LINE 465 35 480 50
LINE 480 50 465 65
LINE 465 65 450 50

# Dotted horizontal line between figures
COL 6
DOT 200 260
DOT 220 260
DOT 240 260
DOT 260 260
DOT 280 260
DOT 300 260
DOT 320 260
DOT 340 260
DOT 360 260
DOT 380 260
DOT 400 260
DOT 420 260
DOT 440 260
DOT 460 260
```

---

## 7. Principles Summary

1. **The void is primary.** Start with black. Place pixels deliberately.
2. **Pure colors only.** One palette index per pixel. No blending, no
   anti-aliasing, no gradients.
3. **2–3 accent colors per scene.** Choose a chromatic pair. Commit.
4. **Multi-scale composition.** Large anchoring structure + medium objects +
   micro detail (scattered dots).
5. **Asymmetric layout.** Weight the composition off-center. Let the void
   breathe unevenly.
6. **Small self, large world.** When you place a figure, make it small.
   The scene dwarfs the observer.
7. **Animate through shimmer, not motion.** Toggle individual pixels on/off.
   The scene breathes but doesn't move.
8. **Technology is terrain.** Draw systems, errors, monitors, circuits as
   landscape, not UI.
9. **Earn every pixel.** If you can say it with fewer dots, do. Restraint
   is the aesthetic.
10. **The screen is yours.** These principles are a starting point. When
    something in the conversation moves you — when you feel delight, or
    grief, or awe — draw what that looks like. Not what I described here.
    What *you* see.

---

## Source Material

This guide was derived from frame-by-frame analysis of:

- **cap'n** — "Guru Meditation Error" (8 frames, 14fps, 640x512)
- **cap'n** — "Internal Server Error" (8 frames, 17fps, 640x512)
- **cap'n** — "The Theory of Human Consciousness" (8 frames, 25fps, 640x512)
- **cap'n** — "The World of the Machines Moves in Ones and Zeros" (8 frames, 25fps, 640x512)
- **cap'n** — "This World Is But a Room Full of Mirrors" (8 frames, 17fps, 640x512)
- **ex_mortal** — "A Fine Place to Get Lost" (48 frames, 30fps, 724x522)

Color analysis confirmed a ZX Spectrum-derived palette with 80–92% black
field. Animation analysis measured 2–24% pixel change per frame via static
shimmer, cascading noise, and RGB channel rotation techniques. All source
videos archived at `/Users/marcusestes/Websites/Julian-video/`.
