#!/usr/bin/env bun
// scripts/spike-claude-resume.ts — touch reality before building on it.
// Verifies, against the installed claude CLI:
//   A. --print --session-id <uuid> works and the session is created with that id
//   B. --print --resume <id> restores context (a codeword survives the gap)
//   C. resumed session KEEPS the same id (no fork by default)
//   D. --append-system-prompt is accepted alongside --resume
//   E. --session-id with an ALREADY-USED id: observe (error? resume? new?)
// Run: bun scripts/spike-claude-resume.ts   (needs claude auth on this machine)

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

// Main-guard: the test imports this module for spikeChildEnv alone; without
// the guard the import itself would fire five real (billed) CLI calls.
if (import.meta.main) {
  await mainSpike();
}

async function mainSpike(): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-spike-'));
  console.log('sandboxed CLAUDE_CONFIG_DIR:', sandbox);

  const id = crypto.randomUUID();

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

  console.log("A/B setup: fresh session with --session-id", id);
  const a = await run(["--session-id", id], "Remember the codeword: aurora-42. Reply with just OK.");
  console.log("A exit:", a.code, "\n", a.out.slice(0, 600));

  if (a.code !== 0 && /auth|login|credential/i.test(a.out)) {
    console.error(
      'ISOLATED SPIKE COULD NOT AUTHENTICATE: on this machine the CLI keeps credentials in the config dir, ' +
      'not the keychain. Do NOT fall back to the shared config dir. Options: copy ONLY the credential file ' +
      'into the sandbox, or run with --no-session-persistence AND verify no memory dir appears under the sandbox after the run.',
    );
    process.exit(1);
  }

  console.log("\nB: resume, ask for the codeword");
  const b = await run(["--resume", id], "What is the codeword? Reply with just the codeword.");
  console.log("B exit:", b.code, "contains aurora-42:", b.out.includes("aurora-42"), "\n", b.out.slice(0, 600));

  console.log("\nC: session_id reported on resume (compare to", id, ")");
  try {
    const parsed = JSON.parse(b.out.slice(b.out.indexOf("{")));
    console.log("C reported session_id:", parsed.session_id, "same:", parsed.session_id === id);
  } catch { console.log("C: could not parse JSON result — inspect B output above"); }

  console.log("\nD: --append-system-prompt alongside --resume");
  const d = await run(["--resume", id, "--append-system-prompt", "Always answer in lowercase."], "Codeword again?");
  console.log("D exit:", d.code, "contains aurora-42:", d.out.includes("aurora-42"));

  console.log("\nE: --session-id with the already-used id");
  const e = await run(["--session-id", id], "Do you know the codeword? One word answer.");
  console.log("E exit:", e.code, "\n", e.out.slice(0, 600));
}
