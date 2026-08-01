import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const TEST_PORT = 18100;
const BASE = `http://localhost:${TEST_PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "julian-continuity-"));
const STATE = join(tmp, "session-state.json");
const LOG = join(tmp, "fake-claude");
let serverProc: Subprocess | null = null;

const readLogs = (suffix: string) =>
  readdirSync(tmp).filter((f) => f.startsWith(`fake-claude.${suffix}`)).sort()
    .map((f) => Bun.file(join(tmp, f)));

// stdin fixtures record the raw bytes sent over the wire, which are
// `--input-format stream-json` envelopes — the wake-up text lives inside a
// JSON string field and its quotes are therefore escaped on the wire.
// Decode each JSONL envelope back to the plain message text before
// asserting on its contents, rather than string-matching escaped JSON.
function extractStdinText(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)?.message?.content?.[0]?.text ?? "";
      } catch {
        return "";
      }
    })
    .join("\n");
}

async function start(body: unknown) {
  return fetch(`${BASE}/api/session/start`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
async function end(body?: unknown) {
  return fetch(`${BASE}/api/session/end`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const waitFor = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await Bun.sleep(100); }
};

async function waitForServer(url: string, timeoutMs = 10000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

beforeAll(async () => {
  serverProc = Bun.spawn(["bun", "run", "server/server.ts"], {
    cwd: resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      ALLOWED_ORIGIN: BASE,
      OIDC_ISSUER: "", VITE_OIDC_ISSUER: "",           // no-auth local mode
      SESSION_STATE_PATH: STATE,
      FAKE_CLAUDE_LOG: LOG,
      // Hermetic: never touch real ~/.claude credentials on the host — the
      // fake CLI fixture needs no auth at all, so bypass the setup gate.
      SKIP_AUTH_SETUP_CHECK: "1",
      PATH: `${resolve(import.meta.dir, "fixtures")}:${process.env.PATH}`, // fake claude wins
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForServer(`${BASE}/api/health`);
});

afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited;
    serverProc = null;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("session continuity lifecycle", () => {
  let firstId = "";

  test("fresh start: --session-id UUID, tail block reaches stdin", async () => {
    const res = await start({ previousTranscript: [
      { role: "user", speakerType: "human", speakerName: "Marcus", text: "hello from the record", ts: 1000 },
      { role: "assistant", speakerType: "assistant", speakerName: "Julian", text: "remembered reply", ts: 2000 },
    ]});
    expect(res.ok).toBe(true);
    const body = await res.json() as { sessionId: string; resumed: boolean };
    expect(body.resumed).toBe(false);
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    firstId = body.sessionId;

    await waitFor(() => readLogs("argv").length >= 1);
    const argv = JSON.parse(await readLogs("argv")[0].text()) as string[];
    expect(argv).toContain("--session-id");
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(firstId);
    expect(argv).not.toContain("--continue");

    await waitFor(() => readLogs("stdin").length >= 1);
    const stdinRaw = (await Promise.all(readLogs("stdin").map((f) => f.text()))).join("\n");
    const stdin = extractStdinText(stdinRaw);
    expect(stdin).toContain('message-count="2"');
    expect(stdin).toContain("[human — Marcus]: hello from the record");
  });

  test("pause then start: resumes with --resume and the SAME id, no tail injected", async () => {
    expect((await end()).ok).toBe(true); // plain end = pause
    await waitFor(() => existsSync(STATE)); // state survived the pause
    const priorStdinCount = readLogs("stdin").length;

    const res = await start({ previousTranscript: [
      { role: "user", speakerType: "human", speakerName: "Marcus", text: "MUST-NOT-APPEAR", ts: 3000 },
    ]});
    const body = await res.json() as { sessionId: string; resumed: boolean };
    expect(body.resumed).toBe(true);
    expect(body.sessionId).toBe(firstId);

    await waitFor(() => readLogs("argv").length >= 2);
    const argv = JSON.parse(await readLogs("argv")[1].text()) as string[];
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe(firstId);

    await waitFor(() => readLogs("stdin").length > priorStdinCount);
    const newStdinRaw = (await Promise.all(readLogs("stdin").slice(priorStdinCount).map((f) => f.text()))).join("\n");
    const newStdin = extractStdinText(newStdinRaw);
    expect(newStdin).not.toContain("MUST-NOT-APPEAR");
    expect(newStdin).not.toContain("<previous-session");
    expect(newStdin).toContain("resuming this session after a pause");
  });

  test("resume FAILURE falls back to fresh with tail — never silent amnesia", async () => {
    expect((await end()).ok).toBe(true); // pause; state survives, resume expected next
    await waitFor(() => existsSync(STATE));
    await Bun.write(`${LOG}.fail-resume`, "1"); // arm the fallback drill
    const priorArgvCount = readLogs("argv").length;

    const res = await start({ previousTranscript: [
      { role: "user", speakerType: "human", speakerName: "Marcus", text: "tail-after-fallback", ts: 4000 },
    ]});
    const body = await res.json() as { sessionId: string; resumed: boolean };
    expect(body.resumed).toBe(false); // server reports the truth, not the attempt
    expect(body.sessionId).not.toBe(firstId);
    firstId = body.sessionId;

    // Two spawns recorded: the failed --resume, then the fresh --session-id.
    await waitFor(() => readLogs("argv").length >= priorArgvCount + 2);
    const argvs = await Promise.all(readLogs("argv").slice(priorArgvCount).map(async (f) => JSON.parse(await f.text()) as string[]));
    expect(argvs[0]).toContain("--resume");
    expect(argvs[1]).toContain("--session-id");

    const stdinRaw = (await Promise.all(readLogs("stdin").map((f) => f.text()))).join("\n");
    const stdin = extractStdinText(stdinRaw);
    expect(stdin).toContain("tail-after-fallback"); // the fallback spawn got the tail
    rmSync(`${LOG}.fail-resume`); // disarm
  });

  test("final end clears state; next start is fresh with a NEW id", async () => {
    expect((await end({ final: true })).ok).toBe(true);
    await waitFor(() => !existsSync(STATE));
    const priorArgvCount = readLogs("argv").length;

    const res = await start({ previousTranscript: [] });
    const body = await res.json() as { sessionId: string; resumed: boolean };
    expect(body.resumed).toBe(false);
    expect(body.sessionId).not.toBe(firstId);

    await waitFor(() => readLogs("argv").length >= priorArgvCount + 1);
    const argv = JSON.parse(await readLogs("argv")[priorArgvCount].text()) as string[];
    expect(argv).toContain("--session-id");

    await end({ final: true });
  });
});
