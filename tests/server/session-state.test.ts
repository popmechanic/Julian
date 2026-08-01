// tests/server/session-state.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessionState, writeSessionState, clearSessionState, decideSpawn, RESUME_EXPIRY_DAYS,
} from "../../server/session-state";

const tmp = () => join(mkdtempSync(join(tmpdir(), "julian-state-")), "session-state.json");
const DAY = 86_400_000;

describe("session state file", () => {
  test("round-trips", () => {
    const p = tmp();
    writeSessionState(p, { claudeSessionId: "abc-123", lastActive: 42, model: "opus" });
    expect(readSessionState(p)).toEqual({ claudeSessionId: "abc-123", lastActive: 42, model: "opus" });
  });
  test("missing file reads null", () => {
    expect(readSessionState(tmp())).toBeNull();
  });
  test("corrupt file reads null, never throws", async () => {
    const p = tmp();
    await Bun.write(p, "{not json");
    expect(readSessionState(p)).toBeNull();
  });
  test("wrong shape reads null", async () => {
    const p = tmp();
    await Bun.write(p, JSON.stringify({ claudeSessionId: 7, lastActive: "x" }));
    expect(readSessionState(p)).toBeNull();
  });
  test("clear removes; clearing a missing file is a no-op", () => {
    const p = tmp();
    writeSessionState(p, { claudeSessionId: "a", lastActive: 1, model: "m" });
    clearSessionState(p);
    expect(readSessionState(p)).toBeNull();
    clearSessionState(p); // no throw
  });
});

describe("decideSpawn", () => {
  const now = 100 * DAY;
  const fresh = { claudeSessionId: "s1", lastActive: now - DAY, model: "opus" };
  test("no state → fresh", () => {
    expect(decideSpawn(null, { demoMode: false, now })).toEqual({ mode: "fresh" });
  });
  test("recent state → resume with the stored id", () => {
    expect(decideSpawn(fresh, { demoMode: false, now }))
      .toEqual({ mode: "resume", claudeSessionId: "s1" });
  });
  test("demo NEVER resumes, even with recent state", () => {
    expect(decideSpawn(fresh, { demoMode: true, now })).toEqual({ mode: "fresh" });
  });
  test("expired state → fresh (older than RESUME_EXPIRY_DAYS)", () => {
    const old = { ...fresh, lastActive: now - (RESUME_EXPIRY_DAYS + 1) * DAY };
    expect(decideSpawn(old, { demoMode: false, now })).toEqual({ mode: "fresh" });
  });
  test("boundary: exactly at expiry still resumes", () => {
    const edge = { ...fresh, lastActive: now - RESUME_EXPIRY_DAYS * DAY };
    expect(decideSpawn(edge, { demoMode: false, now }).mode).toBe("resume");
  });
});
