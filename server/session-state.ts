// server/session-state.ts — machine-local resume state. One session id per
// machine; cleared only by a deliberate final end. Death is never load-bearing:
// corrupt or missing state degrades to a fresh spawn, loudly upstream.
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const RESUME_EXPIRY_DAYS = 25; // harness GC's transcripts at cleanupPeriodDays (default 30)

export interface SessionState {
  claudeSessionId: string;
  lastActive: number; // epoch ms
  model: string;
}

export type SpawnDecision = { mode: "fresh" } | { mode: "resume"; claudeSessionId: string };

export function readSessionState(path: string): SessionState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed?.claudeSessionId === "string" && parsed.claudeSessionId &&
      typeof parsed?.lastActive === "number" &&
      typeof parsed?.model === "string"
    ) {
      return { claudeSessionId: parsed.claudeSessionId, lastActive: parsed.lastActive, model: parsed.model };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeSessionState(path: string, s: SessionState): void {
  mkdirSync(dirname(path), { recursive: true });
  // Collision-proof temp name: concurrent doors share this cwd, so a fixed
  // `${path}.tmp` name can let two writers interleave and publish torn JSON.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, path); // atomic on the same filesystem
}

export function clearSessionState(path: string): void {
  rmSync(path, { force: true }); // race-free: no check-then-act
}

export function decideSpawn(
  state: SessionState | null,
  opts: { demoMode: boolean; now: number },
): SpawnDecision {
  if (opts.demoMode || !state) return { mode: "fresh" };
  const ageDays = (opts.now - state.lastActive) / 86_400_000;
  if (ageDays > RESUME_EXPIRY_DAYS) return { mode: "fresh" };
  return { mode: "resume", claudeSessionId: state.claudeSessionId };
}
