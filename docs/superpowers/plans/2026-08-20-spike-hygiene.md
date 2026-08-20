# Spike Hygiene Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A spawned CLI spike session can never write into the shared harness — memory, session state, or anything else — closing issue #25 (the aurora-42 false-memory incident).

**Architecture:** `scripts/spike-claude-resume.ts` builds its child environment through an exported, unit-tested helper that sets `CLAUDE_CONFIG_DIR` to a fresh per-run temp directory (auto-memory and session stores live under the config dir, so isolating it isolates both). The standing rule lands in CLAUDE.md where every session reads it.

**Tech Stack:** Bun, vitest.

**Spec:** Design approved in the Aug 20 sweep with Marcus (docket entry #25, `docs/superpowers/docket.md`); issue #25 carries the incident record.

**Acceptance:** suite — the env-builder unit test; the live spike re-run is a documented optional verification (costs ~$0.52 in credits, per issue #20's note).

## Global Constraints

- **The child never inherits the ambient config dir:** `CLAUDE_CONFIG_DIR` must be set in every spawn the script performs — no spawn path may fall through to the operator's `~/.claude`.
- **Auth is verified empirically, not assumed:** if the isolated child cannot authenticate (credentials in the config dir rather than the keychain), the script must say so loudly with the fallback instruction, never silently degrade to un-isolated spawning.
- **TDD** for the helper.

---

### Task 1: Isolate the spike; write the rule down

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `scripts/spike-claude-resume.ts`
- Modify: `CLAUDE.md`
- Test: `scripts/spike-env.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `spikeChildEnv(tmpDir: string, base?: Record<string, string | undefined>): Record<string, string>` exported from `scripts/spike-claude-resume.ts` — returns a copy of `base` (default `process.env`) with `CLAUDE_CONFIG_DIR` set to `tmpDir`, never mutating the input.

- [ ] **Step 1: Write the failing test**

Create `scripts/spike-env.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { spikeChildEnv } from './spike-claude-resume';

describe('spike hygiene (#25)', () => {
  test('the child env pins CLAUDE_CONFIG_DIR to the sandbox', () => {
    const env = spikeChildEnv('/tmp/spike-sandbox', { HOME: '/Users/op', CLAUDE_CONFIG_DIR: '/Users/op/.claude' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/spike-sandbox');
    expect(env.HOME).toBe('/Users/op'); // everything else passes through
  });

  test('the builder never mutates its input', () => {
    const base = { CLAUDE_CONFIG_DIR: '/Users/op/.claude' };
    spikeChildEnv('/tmp/spike-sandbox', base);
    expect(base.CLAUDE_CONFIG_DIR).toBe('/Users/op/.claude');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd scripts && bunx vitest run spike-env.test.ts`
Expected: FAIL — `spikeChildEnv` is not exported (the module also currently executes its spike top-level on import; the implementation step fixes that with a main-guard).

- [ ] **Step 3: Implement**

In `scripts/spike-claude-resume.ts`:

1. Add the helper and the sandbox setup at the top (after the header comment):

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Spike hygiene (#25): a spawned CLI session inherits the operator's config
 * dir by default — auto-memory and the session store live there, so an
 * un-isolated spike can write FALSE MEMORIES into the shared harness (it
 * happened: 'aurora-42', attributed to Marcus, run 20260801-132730).
 * Every spawn gets a throwaway CLAUDE_CONFIG_DIR instead.
 */
export function spikeChildEnv(
  tmpDir: string,
  base: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.CLAUDE_CONFIG_DIR = tmpDir;
  return env;
}
```

2. Wrap the whole executable body (everything from `const id = crypto.randomUUID();` down) in a main-guard so the test import runs nothing:

```ts
if (import.meta.main) {
  await mainSpike();
}

async function mainSpike(): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-spike-'));
  console.log('sandboxed CLAUDE_CONFIG_DIR:', sandbox);
  // ... existing body, with run() amended as below ...
}
```

3. Amend `run()` to use the sandbox env:

```ts
  async function run(args: string[], prompt: string): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["claude", "--print", "--output-format", "json", "--model", "sonnet", ...args, prompt], {
      stdout: "pipe", stderr: "pipe",
      env: spikeChildEnv(sandbox),
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, out: out + (err ? `\nSTDERR: ${err}` : "") };
  }
```

4. After the first `run()` call in the spike (step A), add the loud auth check:

```ts
  if (a.code !== 0 && /auth|login|credential/i.test(a.out)) {
    console.error(
      'ISOLATED SPIKE COULD NOT AUTHENTICATE: on this machine the CLI keeps credentials in the config dir, ' +
      'not the keychain. Do NOT fall back to the shared config dir. Options: copy ONLY the credential file ' +
      'into the sandbox, or run with --no-session-persistence AND verify no memory dir appears under the sandbox after the run.',
    );
    process.exit(1);
  }
```

- [ ] **Step 4: Run to verify the test passes**

Run: `cd scripts && bunx vitest run spike-env.test.ts`
Expected: PASS (and the import executes no spike — the main-guard proves itself by the test not spawning anything).

- [ ] **Step 5: Write the standing rule into CLAUDE.md**

In `CLAUDE.md`, after the "## Search & Utilities" section, add:

```markdown
## Spike Hygiene

Any spike, test, or experiment that spawns the real `claude` CLI must isolate
the child: set `CLAUDE_CONFIG_DIR` to a fresh temp directory in the child's
env (see `scripts/spike-claude-resume.ts`'s `spikeChildEnv`), or pass
`--no-session-persistence` and verify nothing landed in the shared harness.
A spawned session interprets its prompt as real requests — one once wrote a
false memory attributed to Marcus (issue #25). Testimony can only be
protected structurally: sandbox first, spawn second.
```

- [ ] **Step 6: Optional live verification (costs ~$0.52)**

Run: `bun scripts/spike-claude-resume.ts`
Expected: the spike completes A-E with the sandbox path printed; afterwards `ls <sandbox>` shows the session/memory artifacts landed there, and the operator's `~/.claude/projects` shows no new entries from the run. If auth fails, the loud check fires — record which credential storage this machine uses in the run output.

- [ ] **Step 7: Commit**

```bash
git add scripts/spike-claude-resume.ts scripts/spike-env.test.ts CLAUDE.md
git commit -m "spikes: spawned CLI sessions run sandboxed — CLAUDE_CONFIG_DIR isolation + standing rule (#25)"
```

---

### Task 2: Verification

**Type:** gate
**Depends-on:** 1

Run, expected green: `cd scripts && bun run test` (the new test rides the vitest half).

---

## Self-review notes

- Spec coverage: isolation (helper + spawn env), the future-spikes rule (CLAUDE.md — operative every session), the loud-auth fallback (never silent degradation). The live re-run is optional and priced, honoring the credits note.
- The main-guard is load-bearing: without it, importing the module in the test would fire five real CLI calls.
- Intentionally narrow: one task; no latent parallelism (escape valve).
