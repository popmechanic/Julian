// tests/server/session-resilience.test.ts — the failure modes of the resume
// lifecycle: a disk that refuses the state write must never fail a start, and
// a remote deployment must never resume from a state file it does not write.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const REPO = resolve(import.meta.dir, "../..");
const FIXTURES = resolve(import.meta.dir, "fixtures");
const FIXTURES_SLOW = resolve(import.meta.dir, "fixtures-slow");

const PORT_DISK = 18200; // server whose state directory turns read-only mid-test
const PORT_REMOTE = 18201; // REMOTE_SESSION server with a seeded state file
const PORT_SLOW = 18202; // server whose CLI lingers after SIGTERM
const PORT_LATE = 18203; // server whose CLI boots slower than its predecessor dies
const DISK = `http://localhost:${PORT_DISK}`;
const REMOTE = `http://localhost:${PORT_REMOTE}`;
const SLOW = `http://localhost:${PORT_SLOW}`;
const LATE = `http://localhost:${PORT_LATE}`;

const tmpDisk = mkdtempSync(join(tmpdir(), "julian-disk-"));
const STATE_DIR = join(tmpDisk, "statedir");
const STATE_DISK = join(STATE_DIR, "session-state.json");
const LOG_DISK = join(tmpDisk, "fake-claude");

const tmpRemote = mkdtempSync(join(tmpdir(), "julian-remote-"));
const STATE_REMOTE = join(tmpRemote, "session-state.json");
const LOG_REMOTE = join(tmpRemote, "fake-claude");

const tmpSlow = mkdtempSync(join(tmpdir(), "julian-slow-"));
const STATE_SLOW = join(tmpSlow, "session-state.json");
const LOG_SLOW = join(tmpSlow, "fake-claude");

const tmpLate = mkdtempSync(join(tmpdir(), "julian-late-"));
const STATE_LATE = join(tmpLate, "session-state.json");
const LOG_LATE = join(tmpLate, "fake-claude");

let diskProc: Subprocess | null = null;
let remoteProc: Subprocess | null = null;
let slowProc: Subprocess | null = null;
let lateProc: Subprocess | null = null;

function spawnServer(port: number, extraEnv: Record<string, string>, fixtures = FIXTURES) {
  return Bun.spawn(["bun", "run", "server/server.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(port),
      ALLOWED_ORIGIN: `http://localhost:${port}`,
      OIDC_ISSUER: "", VITE_OIDC_ISSUER: "", // no-auth local mode
      SKIP_AUTH_SETUP_CHECK: "1", // hermetic: fake CLI fixture, never real creds
      PATH: `${fixtures}:${process.env.PATH}`, // fake claude wins
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForHealth(base: string, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch {}
    await Bun.sleep(200);
  }
  return false;
}

const start = (base: string, body: unknown) =>
  fetch(`${base}/api/session/start`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
const end = (base: string, body?: unknown) =>
  fetch(`${base}/api/session/end`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const argvLogs = (dir: string, prefix: string) =>
  readdirSync(dir).filter((f) => f.startsWith(`${prefix}.argv`)).sort()
    .map((f) => join(dir, f));
const stdinLogs = (dir: string, prefix: string) =>
  readdirSync(dir).filter((f) => f.startsWith(`${prefix}.stdin`));

const waitFor = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await Bun.sleep(100); }
};

beforeAll(async () => {
  mkdirSync(STATE_DIR, { recursive: true });
  // The remote server must find a perfectly resumable state file and still
  // refuse to resume — remote never writes state, so it must never read it.
  writeFileSync(STATE_REMOTE, JSON.stringify({
    claudeSessionId: "seeded-must-not-resume", lastActive: Date.now(), model: "fake-model",
  }));

  diskProc = spawnServer(PORT_DISK, {
    SESSION_STATE_PATH: STATE_DISK,
    FAKE_CLAUDE_LOG: LOG_DISK,
  });
  remoteProc = spawnServer(PORT_REMOTE, {
    SESSION_STATE_PATH: STATE_REMOTE,
    FAKE_CLAUDE_LOG: LOG_REMOTE,
    REMOTE_SESSION: "abc123session",
  });
  slowProc = spawnServer(PORT_SLOW, {
    SESSION_STATE_PATH: STATE_SLOW,
    FAKE_CLAUDE_LOG: LOG_SLOW,
    FAKE_CLAUDE_DEATH_DELAY_MS: "2000",
  }, FIXTURES_SLOW);
  lateProc = spawnServer(PORT_LATE, {
    SESSION_STATE_PATH: STATE_LATE,
    FAKE_CLAUDE_LOG: LOG_LATE,
    FAKE_CLAUDE_DEATH_DELAY_MS: "1500",
    FAKE_CLAUDE_BOOT_DELAY_MS: "3000", // outlives the predecessor's death
  }, FIXTURES_SLOW);
  await waitForHealth(DISK);
  await waitForHealth(REMOTE);
  await waitForHealth(SLOW);
  await waitForHealth(LATE);
});

afterAll(() => {
  try { chmodSync(STATE_DIR, 0o700); } catch {}
  diskProc?.kill();
  remoteProc?.kill();
  slowProc?.kill();
  lateProc?.kill();
});

describe("state writes are never load-bearing", () => {
  let firstId = "";

  test("a healthy start writes state (baseline)", async () => {
    const res = await start(DISK, { previousTranscript: [] });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; resumed: boolean };
    expect(body.resumed).toBe(false);
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    firstId = body.sessionId;
    await waitFor(() => existsSync(STATE_DISK));
  });

  test("a read-only state dir does not kill the server on pause", async () => {
    chmodSync(STATE_DIR, 0o500); // writes now fail; the file stays readable
    expect((await end(DISK)).ok).toBe(true); // plain end = pause; exit handler rewrites lastActive
    await Bun.sleep(500);
    const health = await fetch(`${DISK}/api/health`);
    expect(health.status).toBe(200); // an unhandled write failure would have taken it down
  });

  test("a failed post-spawn state write still yields a 200 start", async () => {
    const res = await start(DISK, { previousTranscript: [] });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; resumed: boolean };
    // The unwritable file is still readable, so the resume decision stands.
    expect(body.resumed).toBe(true);
    expect(body.sessionId).toBe(firstId);
    chmodSync(STATE_DIR, 0o700);
    await end(DISK, { final: true });
  });
});

describe("a superseded process cannot tear down the live session", () => {
  test("a predecessor dying after a restart leaves the new session running", async () => {
    const first = await start(SLOW, { previousTranscript: [] });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { sessionId: string };
    await waitFor(() => existsSync(STATE_SLOW));
    // Wait until the CLI has consumed the wake-up: by then it has installed
    // its SIGTERM handler, so the pause below really does linger.
    await waitFor(() => stdinLogs(tmpSlow, "fake-claude").length >= 1);

    // Pause: the server SIGTERMs the CLI and returns after a short wait, but
    // this CLI lingers for 2s — the old exit handler fires long after the
    // restart below has taken the process slot.
    expect((await end(SLOW)).ok).toBe(true);

    const second = await start(SLOW, { previousTranscript: [] });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { sessionId: string; resumed: boolean };
    expect(secondBody.resumed).toBe(true);
    expect(secondBody.sessionId).toBe(firstBody.sessionId);

    await Bun.sleep(3000); // outlive the predecessor's death throes

    const health = await (await fetch(`${SLOW}/api/health`)).json() as
      { sessionActive: boolean; sessionId: string | null };
    expect(health.sessionActive).toBe(true);
    expect(health.sessionId).toBe(secondBody.sessionId);
    expect(existsSync(STATE_SLOW)).toBe(true); // no spurious resume-failure clear

    await end(SLOW, { final: true });
  }, 20000);

  test("a predecessor's death is not read as THIS spawn's resume failure", async () => {
    const first = await start(LATE, { previousTranscript: [] });
    const firstBody = await first.json() as { sessionId: string };
    // The wake-up reaching stdin proves the CLI booted: SIGTERM now lingers.
    await waitFor(() => stdinLogs(tmpLate, "fake-claude").length >= 1, 15000);
    expect((await end(LATE)).ok).toBe(true);

    // This resume boots slower than the predecessor takes to die. The exit that
    // lands mid-boot belongs to the OLD spawn and must not be mistaken for this
    // one's failure — that would clear state and orphan the resumed context.
    const second = await start(LATE, { previousTranscript: [] });
    const secondBody = await second.json() as { sessionId: string; resumed: boolean };
    expect(secondBody.resumed).toBe(true);
    expect(secondBody.sessionId).toBe(firstBody.sessionId);
    expect(existsSync(STATE_LATE)).toBe(true); // never cleared by a false failure
    // Exactly two spawns: the fresh one and the resume — no panic respawn.
    expect(argvLogs(tmpLate, "fake-claude").length).toBe(2);

    await end(LATE, { final: true });
  }, 30000);
});

describe("REMOTE_SESSION never resumes from local state", () => {
  test("a seeded state file cannot suppress the inherited tail", async () => {
    const res = await start(REMOTE, { previousTranscript: [
      { role: "user", speakerType: "human", speakerName: "Marcus", text: "remote-tail-must-appear", ts: 1000 },
    ]});
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; resumed: boolean };
    expect(body.resumed).toBe(false);
    expect(body.sessionId).not.toBe("seeded-must-not-resume");

    // Remote mode passes the wake-up as the last CLI arg of a one-shot spawn.
    await waitFor(() => argvLogs(tmpRemote, "fake-claude").length >= 1);
    const argv = JSON.parse(await Bun.file(argvLogs(tmpRemote, "fake-claude")[0]).text()) as string[];
    const wakeUp = argv[argv.length - 1];
    expect(wakeUp).toContain('message-count="1"');
    expect(wakeUp).toContain("remote-tail-must-appear");
    expect(wakeUp).not.toContain("resuming this session after a pause");
    await end(REMOTE, { final: true });
  });
});
