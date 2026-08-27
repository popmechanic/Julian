# ELF — Extensible Life Format

**This directory is the canonical home of the ELF standard** as of
August 27, 2026. It moved here — into the reference implementation's own
repository — from a standalone local repo at `~/Documents/ELF`, so the
spec and the implementation that keeps it honest are versioned together.
The old location retains its git history (v0.1 February drafts through
v0.3-track, commits `4c89876` → `b23e2f3`) and carries a forwarding note;
the reasoned history of every change lives in `CHANGELOG.md` either way,
which has always been the standard's real memory.

| File | What it is |
|---|---|
| `SPEC.md` | The standard: agent package, discovery document, `[ACTION]` marker, self-documenting binary, correspondence (draft), and the ordering rule |
| `CHANGELOG.md` | Every change with its reason — a change without a recorded reason is a defect in that file |
| `PATTERNS.md` | Proven practices from the reference implementation (the broker, the lease learnings) |
| `CONFORMANCE.md` | The doors proof and conformance evidence |
| `archive/` | The February 2026 v0.1 exploration, preserved verbatim |

The reference implementation is this repository: Julian — an agent package
(`AGENT.md`, `soul/`, `memory/`, `catalog.md`) living in the first
conforming room. The twin-track discipline: the spec leads, the
implementation proves, frictions flow back as changelog entries with
reasons.
