# Ableton Claude — AI-Assisted Music Composition for Ableton Live

**Date:** 2026-03-12
**Status:** Draft
**Branch:** TBD (dedicated repo)
**Context:** Sound design and music composition for the Pallid Mask art installation (Sou'wester Arts Week 2026, Ilwaco WA). No technical coupling to the Julian codebase.

---

## Overview

A system that enables natural language music composition and sound design in Ableton Live Suite through Claude Code. The user describes musical intent, Claude proposes specifics, the user refines, and Claude executes — either generating files offline or controlling a live Ableton session.

**Primary use case:** Creating sound effects, ambient textures, and music for the Pallid Mask installation. The aesthetic leans toward stoner doom, droning atmospheres, and unsettling sonic textures — but the system is not genre-locked.

**Interaction model:** Guided collaboration via Claude Code CLI. Claude proposes, user refines. Bidirectional communication with Ableton (send commands + read state). No autonomous listening.

---

## Architecture

Three layers, each building on the last:

```
┌─────────────────────────────────────────────────┐
│  Layer 3: Composition Abstractions              │
│  (Tone recipes, pattern templates, effect       │
│   chains, session templates — markdown files)   │
├─────────────────────────────────────────────────┤
│  Layer 2: Live Ableton Bridge                   │
│  (jpoindexter/ableton-mcp — 200+ tools)         │
│  Claude Code → MCP → TCP socket → Remote Script │
├─────────────────────────────────────────────────┤
│  Layer 1: Offline Composition Toolkit           │
│  (MIDI generation, audio processing, sample     │
│   manipulation, automation curves)              │
└─────────────────────────────────────────────────┘
```

**Runtime:** Python. The bridge is Python, the Remote Script is Python, the audio libraries are Python. No reason to fight the ecosystem.

---

## Layer 1: Offline Composition Toolkit

### Purpose

Draft musical ideas without Ableton running. Produces MIDI files, processed audio, and automation data that can be imported into Ableton or pushed via Layer 2.

### Capabilities

| Capability | Description | Tools |
|---|---|---|
| MIDI generation | Chord progressions, melodies, bass lines, drum patterns | `midiutil` |
| Audio processing | Timestretching, pitch shifting, layering, effects | `sox`, `ffmpeg`, `pydub` |
| Sample manipulation | Slicing, reversing, distortion, saturation, resampling | `sox`, `pydub` |
| Automation curves | Filter sweeps, volume swells, parameter modulation as MIDI CC | `midiutil` |

### Module APIs

**`tools/midi.py`**
```python
def generate_midi(notes: list[dict], tempo: int, time_sig: tuple[int, int], output_path: str) -> str:
    """Write a MIDI file from a list of note dicts. Returns the output path.
    Each note: {pitch: int, start: float, duration: float, velocity: int, channel: int}"""

def generate_drum_pattern(pattern: list[dict], tempo: int, bars: int, output_path: str) -> str:
    """Write a drum pattern MIDI file. Notes use GM drum mapping.
    Each hit: {drum: str, beat: float, velocity: int}  # drum = 'kick', 'snare', 'hihat', etc."""

def generate_automation(cc_num: int, points: list[tuple[float, int]], tempo: int, output_path: str) -> str:
    """Write MIDI CC automation as a MIDI file. points = [(beat, value), ...]"""
```

Each module exposes its functions via a CLI entrypoint (e.g., `python -m fire` or argparse). Claude invokes them via Bash with JSON arguments on stdin:
```bash
echo '{"notes": [...], "tempo": 120, "time_sig": [4, 4], "output_path": "output/test/chords.mid"}' | python tools/midi.py generate_midi
```

**`tools/audio.py`**
```python
def process_audio(input_path: str, operations: list[dict], output_path: str) -> str:
    """Apply a chain of operations to an audio file. Returns output path.
    Operations: {op: 'pitch_shift', semitones: int} | {op: 'timestretch', factor: float}
    | {op: 'reverse'} | {op: 'trim', start: float, end: float}
    | {op: 'distortion', gain: float} | {op: 'filter', type: str, freq: int}
    | {op: 'reverb', room: float} | {op: 'normalize'}"""

def layer_audio(inputs: list[str], gains: list[float], output_path: str) -> str:
    """Mix multiple audio files together with per-file gain. Returns output path."""

def slice_audio(input_path: str, slices: list[tuple[float, float]], output_dir: str) -> list[str]:
    """Chop audio into segments. slices = [(start_sec, end_sec), ...]. Returns list of output paths."""
```

### Error handling

- **Missing system dependencies:** `sox`/`ffmpeg` not installed → clear error message pointing to `setup.sh` or `brew install sox ffmpeg`. Do not attempt to process audio without them.
- **Invalid musical input:** Out-of-range MIDI note, negative duration, etc. → validate inputs at function boundaries, raise descriptive errors.
- **Audio decode failure:** `pydub` can't read a file → report the format/codec issue, suggest conversion via ffmpeg first.
- **Disk space/permissions:** Write failures → report the path and error, suggest checking the output directory.

### Output

Files written to `output/` in the repo. Naming convention: `output/<project>/<description>.<ext>` (e.g., `output/pallid-mask/idle-drone-v2.wav`). Formats: `.mid`, `.wav`.

### Integration with Layer 2

Layer 2 has no "load MIDI file" tool — the bridge creates notes programmatically. Two handoff paths:

1. **Programmatic re-entry:** Claude reads the generated MIDI, then enters the notes into Ableton via Layer 2's `add_notes_to_clip` tool. The Layer 1 file is the source of truth; Layer 2 is the delivery mechanism.
2. **Manual drag:** For audio files or complex MIDI, the user drags the file from `output/` into Ableton directly. Claude confirms the target track and continues working from there.

Audio files (`.wav`) can only be loaded manually — Layer 2 does not support audio file import.

---

## Layer 2: Live Ableton Bridge

### Purpose

Bidirectional control of a running Ableton Live Suite session.

### Foundation

**[jpoindexter/ableton-mcp](https://github.com/jpoindexter/ableton-mcp)** — 200+ tools with near-complete LOM coverage. Communicates via JSON over TCP socket (port 9877). Also exposes a REST API (FastAPI).

### Installation

1. Copy Remote Script to Ableton's MIDI Remote Scripts directory
2. Configure as Control Surface in Ableton preferences
3. Install MCP server (`uvx ableton-mcp` or from source)
4. Configure Claude Code's `.mcp.json` to point at it

### Available capabilities (from jpoindexter/ableton-mcp)

**Tracks:** Create/delete/duplicate MIDI and audio tracks, routing, grouping, volume, pan, sends, solo, mute, arm

**Clips:** Create, fire, stop, loop settings, warp modes, fades, follow actions, duplication

**MIDI editing:** Add/remove/transpose notes, quantize, humanize, duplicate loops

**Devices & effects:** Load instruments and effects from browser, get/set parameters, presets, device chains, drum pads, Simpler/Sampler control

**Automation:** Parameter manipulation for any device parameter — filter sweeps, gain staging, effect wet/dry

**Scenes:** Create, launch, duplicate, tempo override

**Transport:** Play, stop, record, tempo, time signature, metronome, loop control

**AI music helpers:** Scale reference (12+ types), drum pattern generation (8 styles), bassline generation (6 styles), timing/velocity humanization

### Communication model

- **Write:** Create tracks, load devices, write notes, set parameters, fire clips
- **Read:** Query track contents, device parameters, clip notes, mixer state, transport state
- **Not supported:** Autonomous event listening (user tells Claude what changed, or Claude polls on request)

### What we build for Layer 2

No new bridge code — the work is integration and validation:
1. Install and configure jpoindexter/ableton-mcp (Remote Script + MCP server)
2. **Validate MCP transport works with Claude Code CLI** — the upstream documents Claude Desktop and Cursor; we must confirm stdio MCP transport works via `uvx ableton-mcp` in `.mcp.json`. If it only exposes a REST API, we'll need a thin stdio wrapper or use the REST API via curl.
3. End-to-end smoke test: create a track, add notes, read them back
4. Document gaps discovered during use
5. Contribute upstream or patch locally if needed

### Error handling

- **Connection lost:** If TCP socket to Ableton drops, Claude should report the disconnection and suggest the user check that Ableton is running and the Control Surface is configured. Do not retry silently.
- **Tool timeout:** Complex operations may time out. Claude should break them into smaller steps rather than retrying the same call.
- **Ableton crash:** Claude has no visibility into Ableton's process state. If tools stop responding, Claude should suggest checking Ableton and reconnecting.

---

## Layer 3: Composition Abstractions

### Purpose

Higher-level vocabulary for translating musical intent into Layer 1 + Layer 2 operations. Not a code framework — structured knowledge files.

### Components

**Tone recipes** (`recipes/tones/`)
Reusable sound design descriptions. Example: "stoner doom power chord" = guitar amp sim → gain 80% → cabinet IR → octave-down layer → slow attack reverb with long pre-delay. Markdown files Claude references when executing.

**Pattern templates** (`recipes/patterns/`)
Common rhythmic and harmonic structures. Half-time doom groove, droning pedal tone, sludge riff shape. Documented patterns, not generated code.

**Effect chains** (`recipes/effects/`)
Signal flow recipes. "Haunted atmosphere" = reverb → pitch shift down → tape saturation → high-cut filter sweep. Claude executes these through Layer 2 tool calls.

**Session templates** (`recipes/sessions/`)
Starting points for project types. "Pallid Mask ambient cue" = 1 audio track (processed sample), 1 MIDI track (pad/drone), 1 return track (reverb), tempo 60-80, no metronome.

### Recipe file format

Markdown with YAML frontmatter. Claude globs the relevant `recipes/` subdirectory to find applicable recipes.

**Example tone recipe** (`recipes/tones/stoner-doom-powerchord.md`):
```markdown
---
name: Stoner Doom Power Chord
tags: [guitar, heavy, low, distorted]
devices: [Amp, Cabinet, Utility]
---

## Signal Chain

1. Load **Amp** (high gain model, e.g., Heavy) → gain 75-85%, bass boosted
2. Load **Cabinet** → 4x12 closed back
3. Add **Utility** on a parallel chain → pitch -12st for octave-down layer
4. Return track: **Reverb** → slow attack (pre-delay 80ms+), decay 3-5s, low-cut at 200Hz

## Notes

- Power chords only (root + fifth), voiced in drop tuning range (B1-E2)
- Palm muting via short note durations + low velocity (60-80)
- Let ring via long durations + higher velocity (100-120)
```

**Example session template** (`recipes/sessions/pallid-mask-ambient-cue.md`):
```markdown
---
name: Pallid Mask Ambient Cue
tags: [ambient, installation, drone, unsettling]
tempo: 60-80
---

## Tracks

1. MIDI track: Pad/drone instrument (Wavetable or Drift)
2. Audio track: Processed sample (field recording, found sound)
3. Return A: Reverb (long decay, high wet)
4. Return B: Delay (ping-pong, filtered feedback)

## Defaults

- Metronome off
- Loop on (length matches cue duration)
- Master volume -6dB (headroom for installation speakers)
```

### How they grow

We start with a handful of recipes and templates. As we work together and discover what sounds good, we add to the library. This is a living collection, not a fixed schema.

---

## Repository Structure

```
ableton-claude/
├── CLAUDE.md                  # Project instructions and conventions
├── .mcp.json                  # MCP server configuration (points to jpoindexter/ableton-mcp)
├── .gitignore                 # Ignores output/, .env, __pycache__, etc.
├── requirements.txt           # Python dependencies (midiutil, pydub, etc.)
├── setup.sh                   # System dependency check (sox, ffmpeg, python)
├── tools/
│   ├── midi.py                # MIDI generation + automation curve utilities
│   └── audio.py               # Audio processing utilities (sox/ffmpeg/pydub wrappers)
├── recipes/
│   ├── tones/                 # Tone recipe markdown files
│   ├── patterns/              # Pattern template markdown files
│   ├── effects/               # Effect chain markdown files
│   └── sessions/              # Session template markdown files
├── output/                    # Generated files (gitignored)
│   └── .gitkeep
├── tests/                     # Layer 1 utility tests
│   ├── test_midi.py
│   └── test_audio.py
└── docs/
    └── gaps.md                # Discovered limitations and workarounds
```

### CLAUDE.md contents

The CLAUDE.md is the primary interface contract. It must cover:

- **Layer 1 invocation:** Claude calls Layer 1 tools by running Python scripts via Bash (e.g., `python tools/midi.py` or inline `python -c` for simple operations). No import path magic — standalone scripts with CLI interfaces.
- **Layer 2 invocation:** Claude calls Layer 2 tools via MCP tool calls (they appear as tools in the conversation once `.mcp.json` is configured).
- **Recipe usage:** Before executing a composition task, glob `recipes/` for relevant files by tag. Read and follow applicable recipes. If no recipe exists, execute from musical knowledge and offer to save the approach as a new recipe afterward.
- **Output naming:** `output/<project>/<description>.<ext>` — e.g., `output/pallid-mask/idle-drone-v2.wav`. Claude creates subdirectories as needed.
- **Error conventions:** If `sox` or `ffmpeg` is missing, tell the user to run `setup.sh` or `brew install sox ffmpeg`. Never silently degrade.
- **Ableton connection:** Before issuing Layer 2 tool calls, verify connection with the test/ping tool. If it fails, tell the user Ableton needs to be running with the Control Surface configured.

---

## Collaboration Workflow

1. **User describes intent** — "I need an unsettling ambient drone for the mask's idle state, something that feels like it's breathing"
2. **Claude proposes specifics** — instrument choice, note content, processing chain, referencing recipes if applicable
3. **User refines** — "heavier saturation", "slower modulation", "use a Dm9 instead"
4. **Claude executes** — generates files (Layer 1) or sends commands to Ableton (Layer 2)
5. **User listens and iterates** — repeat from step 1 or 3

---

## Dependencies

| Dependency | Purpose | Layer |
|---|---|---|
| Python 3.11+ | Runtime | All |
| `midiutil` | MIDI file generation | 1 |
| `pydub` | Audio processing | 1 |
| `sox` (system) | Audio effects and manipulation | 1 |
| `ffmpeg` (system) | Audio format conversion, processing | 1 |
| jpoindexter/ableton-mcp | Live Ableton bridge (200+ MCP tools) | 2 |
| Ableton Live Suite | DAW | 2 |
| AbletonMCP Remote Script | Control Surface inside Ableton (bundled with jpoindexter/ableton-mcp) | 2 |

---

## Fallback Strategy

If jpoindexter/ableton-mcp proves unreliable or unmaintained:
- **First fallback:** ahujasid/ableton-mcp (2,307 stars, most battle-tested, fewer tools but solid foundation). Extend it ourselves.
- **Second fallback:** mawaha/AbleOscMcp (OSC-based, ~50 tools, no browser access but clean architecture).

---

## Out of Scope

- No web UI for composition — this is CLI-only via Claude Code
- No generative AI music model — Claude's musical knowledge drives decisions, not a trained model
- No real-time audio synthesis — we compose and process, Ableton plays
- No technical coupling to the Julian codebase or Pallid Mask server
- No autonomous listening to Ableton state changes
