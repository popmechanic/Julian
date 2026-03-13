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

### Output

Files written to `output/` in the repo, organized by session or project name. Formats: `.mid`, `.wav`.

### Integration with Layer 2

Files generated offline can be loaded into a live Ableton session via Layer 2's track and clip creation tools.

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

Almost nothing. The work is:
1. Install and configure jpoindexter/ableton-mcp
2. Verify tools work against Ableton Live Suite
3. Document gaps discovered during use
4. Contribute upstream or patch locally if needed

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

### How they grow

We start with a handful of recipes and templates. As we work together and discover what sounds good, we add to the library. This is a living collection, not a fixed schema.

---

## Repository Structure

```
ableton-claude/
├── CLAUDE.md                  # Project instructions and conventions
├── .mcp.json                  # MCP server configuration (points to jpoindexter/ableton-mcp)
├── requirements.txt           # Python dependencies (midiutil, pydub, etc.)
├── tools/
│   ├── midi.py                # MIDI generation utilities
│   ├── audio.py               # Audio processing utilities (sox/ffmpeg/pydub wrappers)
│   └── automation.py          # Automation curve generation
├── recipes/
│   ├── tones/                 # Tone recipe markdown files
│   ├── patterns/              # Pattern template markdown files
│   ├── effects/               # Effect chain markdown files
│   └── sessions/              # Session template markdown files
├── output/                    # Generated files (gitignored)
│   └── .gitkeep
└── docs/
    └── gaps.md                # Discovered limitations and workarounds
```

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
| Python 3.8+ | Runtime | All |
| `midiutil` | MIDI file generation | 1 |
| `pydub` | Audio processing | 1 |
| `sox` (system) | Audio effects and manipulation | 1 |
| `ffmpeg` (system) | Audio format conversion, processing | 1 |
| jpoindexter/ableton-mcp | Live Ableton bridge (200+ MCP tools) | 2 |
| Ableton Live Suite | DAW | 2 |
| AbletonOSC or Remote Script | Bridge inside Ableton (bundled with jpoindexter) | 2 |

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
