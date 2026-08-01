# Resume spike: `claude --print` session behaviors

Ran `bun scripts/spike-claude-resume.ts` against the installed `claude` CLI
(v2.1.220) on 2026-08-01. Fresh session id per run: a v4 UUID minted with
`crypto.randomUUID()`.

## Findings

**A — `--print --session-id <uuid>` creates a session with that id.**
Exit code `0`. The JSON result's `session_id` field equals the id we passed
(`5ac447b0-997b-44c3-b22a-8e8da5a54e63`). The CLI accepts and honors a
caller-supplied session id on first use.

**B — `--print --resume <id>` restores context.**
Exit code `0`. The reply contains `aurora-42`, the codeword planted in the A
prompt. Context survives the gap between the two separate process spawns —
resume is not just a flag that's accepted, it actually reloads prior
conversation state.

**C — the resumed session keeps the same id (no fork by default).**
The JSON result from B reports `session_id: 5ac447b0-997b-44c3-b22a-8e8da5a54e63`,
identical to the id passed to A. `--resume` does not fork to a new session id
under default flags — the server-minted/caller-supplied id is stable across
resumes.

**D — `--append-system-prompt` is accepted alongside `--resume`.**
Exit code `0`, and the reply still contains `aurora-42` — the appended system
prompt does not disrupt context restoration. Both flags can be passed
together on a resume spawn without conflict.

**E — `--session-id` with an already-used id fails hard.**
Exit code `1`. Stderr: `Error: Session ID 5ac447b0-997b-44c3-b22a-8e8da5a54e63
is already in use.` This is not a silent resume and not a silent new session
— it is a hard CLI error. Any code path that might re-mint a `--session-id`
that collides with an existing one (e.g. via a retry, or a race between two
spawns) will crash the spawn rather than degrade gracefully. Server wiring
that resumes an existing session must use `--resume`, never `--session-id`,
once an id has been used once.

## Re-verification (second independent run, 2026-08-01)

The spike was re-run from a clean worktree against the same installed CLI
(v2.1.220) to confirm the findings above are reproducible and not an artifact
of one session. Fresh session id for this run:
`d8acfa3c-e6af-45ff-ac28-933f1d31b94c`. Verbatim console outcomes:

```
A exit: 0        session_id: d8acfa3c-e6af-45ff-ac28-933f1d31b94c
B exit: 0        contains aurora-42: true
C reported session_id: d8acfa3c-e6af-45ff-ac28-933f1d31b94c  same: true
D exit: 0        contains aurora-42: true
E exit: 1        STDERR: Error: Session ID d8acfa3c-e6af-45ff-ac28-933f1d31b94c is already in use.
```

All five letters reproduced identically: `--session-id` honored on first use,
`--resume` restores context across separate process spawns, the id is stable
across resume (no fork), `--append-system-prompt` composes with `--resume`
without disrupting restoration, and reusing a spent `--session-id` is a hard
exit-1 error. No flag in the resume path hard-fails against the installed CLI,
so the server-wiring design (resume by explicit `--resume <id>`, never
`--continue`, never `--session-id` on a spent id) is clear to proceed.

## Not exercised

Compaction visibility in print mode (whether/how a compaction event surfaces
in `--print --output-format json`) was not exercised in this spike — the
design treats compaction as log-only, so no behavior in this codebase depends
on observing it from print-mode output.
