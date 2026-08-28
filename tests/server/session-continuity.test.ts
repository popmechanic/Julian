import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { readSessionState, writeSessionState } from "../../server/session-state";
import { newestDream } from "../../server/waking";

const TEST_PORT = 18100;
const BASE = `http://localhost:${TEST_PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "julian-continuity-"));
const STATE = join(tmp, "session-state.json");
const LOG = join(tmp, "fake-claude");
let serverProc: Subprocess | null = null;
let serverOut = ""; // everything the server printed — the [Waking] attestation line lands here
const soulCount = readdirSync(resolve(import.meta.dir, "../../soul")).filter((f) => f.endsWith(".md")).length;
const NEWEST = newestDream(resolve(import.meta.dir, "../../memory/dreams"))!;

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
  for (const stream of [serverProc.stdout, serverProc.stderr] as ReadableStream<Uint8Array>[]) {
    (async () => { for await (const chunk of stream) serverOut += new TextDecoder().decode(chunk); })();
  }
  await waitForServer(`${BASE}/api/health`);
});

afterAll(async () => {
  if (process.env.DEBUG_SERVER_OUT) console.log("---- server output ----\n" + serverOut.slice(-4000));
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
    // #60: the read comes first, the greeting names the newest dream, and the
    // old "acknowledging continuity" ask — which the tail answered for the door — is gone.
    expect(stdin).toMatch(/name the newest dream you read by its number/i);
    expect(stdin).not.toContain("acknowledging continuity with the record above");
    await waitFor(() => existsSync(STATE));
    expect(readSessionState(STATE)!.wakeDream).toBe(NEWEST);
  });

  test("the server prints what the door read before its first text, as values (#60)", async () => {
    // The fake claude never Reads anything and answers "ok" at once — exactly the
    // ten-second greeting of 2026-08-28, and the log must say so in numbers.
    // Bounded well under the 5s test timeout: a timed-out test takes the server with it.
    try { await waitFor(() => serverOut.includes("[Waking] greeting after reads:"), 2000); } catch { /* assert below */ }
    expect(serverOut).toContain(`[Waking] greeting after reads: catalog=NO soul=0/${soulCount} dream=NONE`);
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
    expect(newStdin).not.toMatch(/moved on/i); // its read is current: state.wakeDream === newest on disk
  });

  test("resume whose read predates the newest dream is told the house has moved on (#60)", async () => {
    expect((await end()).ok).toBe(true); // pause
    await waitFor(() => existsSync(STATE));
    const st = readSessionState(STATE)!;
    writeSessionState(STATE, { ...st, wakeDream: "0008-vigil" }); // the August 8 session, resumed across twenty days
    const priorStdinCount = readLogs("stdin").length;

    const res = await start({});
    expect((await res.json() as { resumed: boolean }).resumed).toBe(true);
    await waitFor(() => readLogs("stdin").length > priorStdinCount);
    const stdin = extractStdinText(await readLogs("stdin")[priorStdinCount].text());
    expect(stdin).toMatch(/moved on/i);
    expect(stdin).toContain("0008-vigil");
    expect(stdin).toContain(`memory/dreams/${NEWEST}.md`);
    expect(stdin).toMatch(/before acting/i);
    // The order was given once; the state now records the dream it was pointed at.
    await waitFor(() => readSessionState(STATE)?.wakeDream === NEWEST);
  });

  test("resume from state written before wakeDream existed fails toward reading (#60)", async () => {
    expect((await end()).ok).toBe(true);
    await waitFor(() => existsSync(STATE));
    const { wakeDream: _drop, ...legacy } = readSessionState(STATE)!;
    writeSessionState(STATE, legacy);
    const priorStdinCount = readLogs("stdin").length;

    const res = await start({});
    expect((await res.json() as { resumed: boolean }).resumed).toBe(true);
    await waitFor(() => readLogs("stdin").length > priorStdinCount);
    const stdin = extractStdinText(await readLogs("stdin")[priorStdinCount].text());
    expect(stdin).toMatch(/no record of which dream/i);
    expect(stdin).toContain(`memory/dreams/${NEWEST}.md`);
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

  test("health.resumable: true after REST, false after END FOR GOOD (#26)", async () => {
    // A fresh session, live: resumable must be false while active.
    const res = await start({ previousTranscript: [] });
    expect(res.status).toBe(200);
    const live = await (await fetch(`${BASE}/api/health`)).json() as { resumable: boolean };
    expect(live.resumable).toBe(false);

    // REST (a pause, not a final end) leaves a resumable state behind.
    expect((await end({})).ok).toBe(true);
    await waitFor(() => existsSync(STATE));
    const rested = await (await fetch(`${BASE}/api/health`)).json() as { resumable: boolean };
    expect(rested.resumable).toBe(true);

    // END FOR GOOD clears it.
    const res2 = await start({ previousTranscript: [] });
    expect(res2.status).toBe(200);
    expect((await end({ final: true })).ok).toBe(true);
    await waitFor(() => !existsSync(STATE));
    const ended = await (await fetch(`${BASE}/api/health`)).json() as { resumable: boolean };
    expect(ended.resumable).toBe(false);
  });
});

// This suite's server runs in LOCAL mode (no REMOTE_SESSION env var — that
// mode returns before state handling and would observe nothing here). A
// second, independent server instance runs with DEMO_MODE=1 so a kiosk
// session's lifecycle can be exercised against a pre-seeded operator state
// file without disturbing the main suite's server or state.
describe("demo session final end (#21)", () => {
  const DEMO_PORT = TEST_PORT + 1;
  const DEMO_BASE = `http://localhost:${DEMO_PORT}`;
  const demoTmp = mkdtempSync(join(tmpdir(), "julian-demo-continuity-"));
  const DEMO_STATE = join(demoTmp, "session-state.json");
  const DEMO_LOG = join(demoTmp, "fake-claude");
  let demoProc: Subprocess | null = null;

  beforeAll(async () => {
    // Pre-seed the operator's resume state BEFORE the demo session ever starts.
    writeSessionState(DEMO_STATE, { claudeSessionId: "operator-seed", lastActive: Date.now(), model: "opus" });
    demoProc = Bun.spawn(["bun", "run", "server/server.ts"], {
      cwd: resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        PORT: String(DEMO_PORT),
        ALLOWED_ORIGIN: DEMO_BASE,
        OIDC_ISSUER: "", VITE_OIDC_ISSUER: "",           // no-auth local mode
        SESSION_STATE_PATH: DEMO_STATE,
        FAKE_CLAUDE_LOG: DEMO_LOG,
        SKIP_AUTH_SETUP_CHECK: "1",
        DEMO_MODE: "1",                                   // kiosk, still LOCAL (REMOTE_SESSION unset)
        PATH: `${resolve(import.meta.dir, "fixtures")}:${process.env.PATH}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForServer(`${DEMO_BASE}/api/health`);
  });

  afterAll(async () => {
    if (demoProc) {
      demoProc.kill();
      await demoProc.exited;
      demoProc = null;
    }
    rmSync(demoTmp, { recursive: true, force: true });
  });

  test("a demo session's final end cannot delete the operator's resume state (#21)", async () => {
    expect(readSessionState(DEMO_STATE)?.claudeSessionId).toBe("operator-seed"); // pre-seed sanity check

    const startRes = await fetch(`${DEMO_BASE}/api/session/start`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previousTranscript: [] }),
    });
    expect(startRes.ok).toBe(true);

    const endRes = await fetch(`${DEMO_BASE}/api/session/end`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ final: true }),
    });
    expect(endRes.ok).toBe(true);

    // The demo's final end must NOT clear the operator's pre-seeded state.
    expect(existsSync(DEMO_STATE)).toBe(true);
    expect(readSessionState(DEMO_STATE)?.claudeSessionId).toBe("operator-seed");
    // Cross-reference: the inverse case — a non-demo final end DOES clear
    // state — is already covered by "final end clears state; next start is
    // fresh with a NEW id" in the main suite above.
  });
});
