# Session Continuity Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web session is one model context window — killed subprocesses resume their conversation; true session boundaries inherit a budgeted tail of the store record.

**Architecture:** The server keeps a machine-local resume-state file naming the harness session id; `/api/session/start` resumes when possible and otherwise spawns fresh with a `<previous-session>` tail block supplied by the frontend from the TinyBase store. Session ends become explicit (`{final: true}`); everything else is a pause.

**Tech Stack:** Bun (server + `bun test tests/`), Svelte + Vite + Vitest (`app/`), TinyBase store, Claude Code CLI in `--print` stream-json mode.

**Acceptance:** suite — sealing not requested; the committed suites plus per-task review are the verification.

## Global Constraints

- Never use `--continue`: the cwd hosts other sessions (terminal doors, heartbeat replies); resume is always by explicit `--resume <id>`.
- `RESUME_EXPIRY_DAYS = 25` (harness transcripts are GC'd at `cleanupPeriodDays`, default 30 — expire proactively).
- Tail budget: `TAIL_MAX_MESSAGES = 100`, `TAIL_MAX_CHARS = 30000`; trim oldest-first, whole messages only.
- Demo/kiosk sessions never read or write resume state, never resume, never receive a tail. `FORCE_DEMO_MODE` behavior must not regress.
- Historical store rows keep their old server-minted session ids; never rewrite existing rows.
- The full CLI flag set is re-passed on every spawn, resume included (`--fallback-model` etc. are not restored by the harness).
- Identity loads first: waking read (harness-loaded CLAUDE.md) precedes the tail block, which precedes the room block. Resume spawns get no wake-up injection (no tail, no room).
- Server tests: `bun test tests/` from repo root. App tests: `bun run test` (vitest) in `app/`. Same-wave tasks must use unique ports/temp paths (existing integration test owns port 18000; new integration test uses 18100).
- Server session events keep their shape; `sessionId` in events/store rows becomes the harness session id from this change forward.

---

### Task 1: Spike — prove resume behaviors against the real CLI

**Type:** implementation
**Depends-on:** none

**Files:**
- Create: `scripts/spike-claude-resume.ts`
- Create: `docs/handoffs/2026-08-01-resume-spike.md`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a findings document (no code consumed by other tasks; the server wiring task proceeds on the defensive design that tolerates every spike outcome, but the spike must run first to catch a hard flag failure).

- [ ] **Step 1: Write the spike script**

```ts
#!/usr/bin/env bun
// scripts/spike-claude-resume.ts — touch reality before building on it.
// Verifies, against the installed claude CLI:
//   A. --print --session-id <uuid> works and the session is created with that id
//   B. --print --resume <id> restores context (a codeword survives the gap)
//   C. resumed session KEEPS the same id (no fork by default)
//   D. --append-system-prompt is accepted alongside --resume
//   E. --session-id with an ALREADY-USED id: observe (error? resume? new?)
// Run: bun scripts/spike-claude-resume.ts   (needs claude auth on this machine)

const id = crypto.randomUUID();

async function run(args: string[], prompt: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["claude", "--print", "--output-format", "json", "--model", "sonnet", ...args, prompt], {
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out: out + (err ? `\nSTDERR: ${err}` : "") };
}

console.log("A/B setup: fresh session with --session-id", id);
const a = await run(["--session-id", id], "Remember the codeword: aurora-42. Reply with just OK.");
console.log("A exit:", a.code, "\n", a.out.slice(0, 600));

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
```

- [ ] **Step 2: Run it**

Run: `bun scripts/spike-claude-resume.ts`
Expected: A and B exit 0 and B contains `aurora-42` (context survived the gap). Record C/D/E outcomes whatever they are.

- [ ] **Step 3: Record findings**

Write `docs/handoffs/2026-08-01-resume-spike.md` with the five lettered outcomes verbatim (exit codes, id stability, E's behavior), plus a one-line note that compaction visibility in print mode was not exercised (design treats compaction as log-only).

- [ ] **Step 4: Commit**

```bash
git add scripts/spike-claude-resume.ts docs/handoffs/2026-08-01-resume-spike.md
git commit -m "spike: prove claude --print resume behaviors against the real CLI"
```

---

### Task 2: Session-state module

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Create: `server/session-state.ts`
- Test: `tests/server/session-state.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `SessionState { claudeSessionId: string; lastActive: number; model: string }`; `readSessionState(path: string): SessionState | null`; `writeSessionState(path: string, s: SessionState): void`; `clearSessionState(path: string): void`; `decideSpawn(state: SessionState | null, opts: { demoMode: boolean; now: number }): SpawnDecision` where `SpawnDecision = { mode: 'fresh' } | { mode: 'resume'; claudeSessionId: string }`; constant `RESUME_EXPIRY_DAYS = 25`.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/server/session-state.test.ts`
Expected: FAIL — module `server/session-state` not found.

- [ ] **Step 3: Implement**

```ts
// server/session-state.ts — machine-local resume state. One session id per
// machine; cleared only by a deliberate final end. Death is never load-bearing:
// corrupt or missing state degrades to a fresh spawn, loudly upstream.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
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
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, path); // atomic on the same filesystem
}

export function clearSessionState(path: string): void {
  if (existsSync(path)) rmSync(path);
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
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/server/session-state.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add server/session-state.ts tests/server/session-state.test.ts
git commit -m "feat(session): machine-local resume state module with expiry guard"
```

---

### Task 3: Tail block builder in server lib

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `server/lib.ts`
- Test: `tests/server/lib.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `TailMessage { role: string; speakerType: string; speakerName: string; text: string; ts: number }`; `buildPreviousSessionBlock(msgs: TailMessage[]): string`.

**Parallelization rationale:** extracting the inline `<previous-session>` string-building out of the start handler into a pure lib function makes it unit-testable and lets the server-wiring task and this formatting work proceed independently — a split a good engineer makes for testability alone.

- [ ] **Step 1: Write the failing tests** (append to the existing `tests/server/lib.test.ts`)

```ts
import { buildPreviousSessionBlock, type TailMessage } from "../../server/lib";

describe("buildPreviousSessionBlock", () => {
  const msgs: TailMessage[] = [
    { role: "user", speakerType: "human", speakerName: "Marcus", text: "hello", ts: 1000 },
    { role: "assistant", speakerType: "assistant", speakerName: "Julian", text: "hi there", ts: 2000 },
  ];
  test("wraps messages with count, span framing, and ISO from/to", () => {
    const block = buildPreviousSessionBlock(msgs);
    expect(block).toContain('message-count="2"');
    expect(block).toContain('spans="multiple-sessions"');
    expect(block).toContain(`from="${new Date(1000).toISOString()}"`);
    expect(block).toContain(`to="${new Date(2000).toISOString()}"`);
    expect(block).toContain("[human — Marcus]: hello");
    expect(block).toContain("[assistant — Julian]: hi there");
    expect(block).toContain("testimony from the record, not your live memory");
    expect(block.trim().endsWith("</previous-session>")).toBe(true);
  });
  test("empty tail is visible, never omitted", () => {
    const block = buildPreviousSessionBlock([]);
    expect(block).toContain('message-count="0"');
    expect(block).toContain("</previous-session>");
  });
  test("missing speaker fields fall back like the old inline code", () => {
    const block = buildPreviousSessionBlock([{ role: "user", speakerType: "", speakerName: "", text: "x", ts: 5 }]);
    expect(block).toContain("[human — Unknown]: x");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/server/lib.test.ts`
Expected: FAIL — `buildPreviousSessionBlock` is not exported.

- [ ] **Step 3: Implement** (append to `server/lib.ts`)

```ts
export interface TailMessage {
  role: string;
  speakerType: string;
  speakerName: string;
  text: string;
  ts: number;
}

// The inherited tail: testimony from the record for a fresh session. The
// framing sentence is load-bearing — a waking instance must know it is
// reading the record, not remembering.
export function buildPreviousSessionBlock(msgs: TailMessage[]): string {
  const stamps = msgs.map((m) => m.ts).filter((t) => Number.isFinite(t) && t > 0);
  const from = stamps.length ? new Date(Math.min(...stamps)).toISOString() : "";
  const to = stamps.length ? new Date(Math.max(...stamps)).toISOString() : "";
  const lines = msgs
    .map((m) => `[${m.speakerType || "human"} — ${m.speakerName || "Unknown"}]: ${m.text}`)
    .join("\n");
  return (
    `<previous-session category="transcript" spans="multiple-sessions" message-count="${msgs.length}" from="${from}" to="${to}">\n` +
    `This is testimony from the record, not your live memory — the recent conversation across your prior sessions, read the way you read the catalog.\n` +
    lines +
    `\n</previous-session>`
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/server/lib.test.ts`
Expected: PASS (new tests and all pre-existing lib tests).

- [ ] **Step 5: Commit**

```bash
git add server/lib.ts tests/server/lib.test.ts
git commit -m "feat(session): buildPreviousSessionBlock — the inherited tail, framed as testimony"
```

---

### Task 4: Frontend tail selection

**Type:** implementation
**Depends-on:** none

**Files:**
- Create: `app/src/lib/tail.ts`
- Test: `app/src/lib/tail.test.ts`

**Interfaces:**
- Consumes: the app's TinyBase store shape — `messages` table rows `{ sessionId, role, speakerName, text, ts, kind }` (from the existing store module).
- Produces: `selectTail(store: Store): TailMessage[]` (oldest-first output); `TailMessage { role: string; speakerType: string; speakerName: string; text: string; ts: number }` — the wire shape POSTed as `previousTranscript`; constants `TAIL_MAX_MESSAGES = 100`, `TAIL_MAX_CHARS = 30000`.

- [ ] **Step 1: Write the failing tests**

```ts
// app/src/lib/tail.test.ts
import { describe, expect, test } from "vitest";
import { createStore } from "tinybase";
import { selectTail, TAIL_MAX_MESSAGES, TAIL_MAX_CHARS } from "./tail";

function storeWith(rows: Array<Record<string, unknown>>) {
  const store = createStore();
  rows.forEach((r, i) => store.setRow("messages", `m${i}`, r as never));
  return store;
}

describe("selectTail", () => {
  test("returns chat rows oldest-first with wire shape", () => {
    const store = storeWith([
      { kind: "chat", role: "assistant", speakerName: "Julian", text: "second", ts: 200, sessionId: "s" },
      { kind: "chat", role: "user", speakerName: "Marcus", text: "first", ts: 100, sessionId: "s" },
    ]);
    expect(selectTail(store)).toEqual([
      { role: "user", speakerType: "human", speakerName: "Marcus", text: "first", ts: 100 },
      { role: "assistant", speakerType: "assistant", speakerName: "Julian", text: "second", ts: 200 },
    ]);
  });
  test("filters non-chat rows and empty text", () => {
    const store = storeWith([
      { kind: "chat", role: "user", speakerName: "M", text: "keep", ts: 1, sessionId: "s" },
      { kind: "system", role: "user", speakerName: "M", text: "drop", ts: 2, sessionId: "s" },
      { kind: "chat", role: "user", speakerName: "M", text: "", ts: 3, sessionId: "s" },
    ]);
    expect(selectTail(store).map((m) => m.text)).toEqual(["keep"]);
  });
  test("caps at TAIL_MAX_MESSAGES, keeping the newest", () => {
    const rows = Array.from({ length: TAIL_MAX_MESSAGES + 20 }, (_, i) => ({
      kind: "chat", role: "user", speakerName: "M", text: `t${i}`, ts: i + 1, sessionId: "s",
    }));
    const tail = selectTail(storeWith(rows));
    expect(tail).toHaveLength(TAIL_MAX_MESSAGES);
    expect(tail[tail.length - 1].text).toBe(`t${TAIL_MAX_MESSAGES + 19}`);
    expect(tail[0].text).toBe("t20");
  });
  test("caps at TAIL_MAX_CHARS, trimming whole oldest messages", () => {
    const big = "x".repeat(TAIL_MAX_CHARS - 10);
    const store = storeWith([
      { kind: "chat", role: "user", speakerName: "M", text: "old-dropped", ts: 1, sessionId: "s" },
      { kind: "chat", role: "user", speakerName: "M", text: big, ts: 2, sessionId: "s" },
      { kind: "chat", role: "user", speakerName: "M", text: "newest", ts: 3, sessionId: "s" },
    ]);
    const tail = selectTail(store);
    expect(tail.map((m) => m.text)).toEqual([big, "newest"]); // whole message dropped, none truncated
  });
  test("empty store yields empty tail", () => {
    expect(selectTail(storeWith([]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && bun run test -- tail`
Expected: FAIL — `./tail` module not found.

- [ ] **Step 3: Implement**

```ts
// app/src/lib/tail.ts — select the inherited tail from the converged store.
// Budgeted recency window: newest messages, whole messages only, oldest
// trimmed first. The server injects this only on fresh spawns.
import type { Store } from "tinybase";

export const TAIL_MAX_MESSAGES = 100;
export const TAIL_MAX_CHARS = 30_000;

export interface TailMessage {
  role: string;
  speakerType: string;
  speakerName: string;
  text: string;
  ts: number;
}

export function selectTail(store: Store): TailMessage[] {
  const rows = Object.values(store.getTable("messages"))
    .filter((r) => r.kind === "chat" && typeof r.text === "string" && r.text !== "")
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));

  const out: TailMessage[] = [];
  let chars = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const text = String(rows[i].text);
    if (out.length >= TAIL_MAX_MESSAGES || chars + text.length > TAIL_MAX_CHARS) break;
    chars += text.length;
    const role = String(rows[i].role || "user");
    out.unshift({
      role,
      speakerType: role === "assistant" ? "assistant" : "human",
      speakerName: String(rows[i].speakerName || ""),
      text,
      ts: Number(rows[i].ts) || 0,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app && bun run test -- tail`
Expected: PASS, all five tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tail.ts app/src/lib/tail.test.ts
git commit -m "feat(session): selectTail — budgeted recency window from the store"
```

---

### Task 5: Server session lifecycle wiring

**Type:** implementation
**Depends-on:** 1, 2, 3
**Review:** adversarial

**Files:**
- Modify: `server/server.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `readSessionState/writeSessionState/clearSessionState/decideSpawn/SessionState/SpawnDecision` (from Task 2); `buildPreviousSessionBlock/TailMessage` (from Task 3).
- Produces: `/api/session/start` wire contract — request body `{ previousTranscript?: TailMessage[], demoMode?: boolean }`; response `{ sessionId, resumed: boolean, eventId }`. `spawnClaude(mode, oidcToken, decision: SpawnDecision)` signature. Server events' `sessionId` becomes the harness session id.

The demo/kiosk lock is the risk surface here: a demo session must never resume the operator's context, never write resume state, and never receive a tail. Every step preserves the existing `FORCE_DEMO_MODE` behavior.

- [ ] **Step 1: Add imports and the state path** (top of `server/server.ts`, near the other local imports)

```ts
import {
  readSessionState, writeSessionState, clearSessionState, decideSpawn,
  type SpawnDecision,
} from "./session-state";
import { buildPreviousSessionBlock, type TailMessage } from "./lib"; // merge into the existing ./lib import list

const SESSION_STATE_PATH = process.env.SESSION_STATE_PATH || ".julian/session-state.json";
```

Add `.julian/` on its own line to `.gitignore`.

- [ ] **Step 2: Rework `spawnClaude` for resume-first ids**

Change the signature and the id/flag logic. Current code minted `julian-YYYY-MM-DD-<n>`; the harness session id becomes the id everywhere (events, store rows — `events.ts` tags rows from event `sessionId`, so this single change propagates).

```ts
function spawnClaude(mode: 'normal' | 'demo' = 'normal', oidcToken = '', decision: SpawnDecision = { mode: 'fresh' }) {
  sessionId = decision.mode === 'resume' ? decision.claudeSessionId : crypto.randomUUID();
  sessionCostUsd = 0;
  // ... existing authEnv / logging / appendPrompt / REMOTE_SESSION block unchanged ...
```

In the local-mode `cmd` array, after the existing flags, add exactly one of:

```ts
  if (decision.mode === 'resume') {
    cmd.push("--resume", decision.claudeSessionId);
  } else {
    cmd.push("--session-id", sessionId);
  }
```

After the `spawn({...})` call, persist state — normal sessions only, never demo:

```ts
  if (mode === 'normal') {
    writeSessionState(SESSION_STATE_PATH, { claudeSessionId: sessionId!, lastActive: Date.now(), model: actualModel });
  }
```

- [ ] **Step 3: Track spawn outcome for the resume fallback**

Add module-level state next to `claudeProc`:

```ts
let spawnOutcome: Promise<'ready' | 'exited'> = Promise.resolve('ready');
let resolveSpawnOutcome: (v: 'ready' | 'exited') => void = () => {};
```

At the top of `spawnClaude` (local mode), reset it:

```ts
  spawnOutcome = new Promise((r) => { resolveSpawnOutcome = r; });
```

In the stdout handler where `parsed.type === 'system'` is handled, add:

```ts
              resolveSpawnOutcome('ready');
              if (parsed.session_id && parsed.session_id !== sessionId) {
                // Defensive: the harness is the authority on the id.
                console.log(`[Session] Harness reports id ${parsed.session_id} (minted ${sessionId}) — adopting`);
                sessionId = parsed.session_id;
                if (mode === 'normal') writeSessionState(SESSION_STATE_PATH, { claudeSessionId: parsed.session_id, lastActive: Date.now(), model: actualModel });
              }
```

In the process exit handler (the block that appends `session_end` and sets `sessionId = null`), add before `sessionId = null`:

```ts
    resolveSpawnOutcome('exited');
    // Pause, not death: refresh lastActive so the resume window starts now.
    // State survives every exit except a deliberate final end.
    const st = readSessionState(SESSION_STATE_PATH);
    if (st && sessionId && st.claudeSessionId === sessionId) {
      writeSessionState(SESSION_STATE_PATH, { ...st, lastActive: Date.now() });
    }
```

- [ ] **Step 4: Rework `/api/session/start`**

Replace the body-parse and spawn/wake-up section (keeping auth, 409, setup, kiosk-lock lines exactly as they are). The existing `previousTranscript` parsing stays; the decision and injection change:

```ts
      const state = readSessionState(SESSION_STATE_PATH);
      let decision = decideSpawn(state, { demoMode, now: Date.now() });
      spawnClaude(demoMode ? 'demo' : 'normal', demoMode ? '' : oidcToken, decision);
      lastActivity = Date.now();

      // Resume must never fail silently into amnesia: if the resumed process
      // dies before its first system event, fall back to a fresh spawn WITH
      // the tail, loudly.
      if (decision.mode === 'resume' && !REMOTE_SESSION) {
        const outcome = await Promise.race([spawnOutcome, Bun.sleep(15_000).then(() => 'timeout' as const)]);
        if (outcome === 'exited') {
          console.error(`[Session] RESUME FAILED for ${decision.claudeSessionId} — fresh spawn with inherited tail`);
          clearSessionState(SESSION_STATE_PATH);
          decision = { mode: 'fresh' };
          spawnClaude('normal', oidcToken, decision);
        }
      }

      let wakeUpMessage: string;
      if (demoMode) {
        wakeUpMessage = "You are waking up in demo mode. A visitor is here.\n\n";
      } else if (decision.mode === 'resume') {
        // The context already holds identity, room, and conversation.
        wakeUpMessage = "You are resuming this session after a pause — Marcus has reconnected. You retain the conversation; a brief acknowledgment is enough.";
      } else {
        wakeUpMessage = buildPreviousSessionBlock(previousTranscript as TailMessage[]) + "\n\n";
        wakeUpMessage += previousTranscript.length > 0
          ? "Greet Marcus briefly, acknowledging continuity with the record above."
          : "Then greet Marcus briefly.";
      }
      if (!REMOTE_SESSION && decision.mode !== 'resume' && !demoMode) {
        wakeUpMessage += '\n\n<room>\nYou have arrived in a room. Your identity precedes it. The room describes itself:\n\n' + buildRoomDoc() + '\n</room>';
      }
      writeToStdin(wakeUpMessage);
```

Note: this changes fresh-spawn behavior for the empty-tail case — the block is *always* present (`message-count="0"`), per the design's "absence is visible" rule. The room-block condition: the current code appends the room `if (!REMOTE_SESSION)` for ALL sessions including demo — preserve that, narrowing only by the resume clause. The condition is exactly `if (!REMOTE_SESSION && decision.mode !== 'resume')` (no `!demoMode` term; demo keeps receiving the room block, unchanged behavior).

Change the response to include `resumed`:

```ts
      return Response.json(
        { sessionId, resumed: decision.mode === 'resume', eventId: lastEventId },
        { headers: { "X-Session-Id": sessionId || "", ...corsHeaders(ALLOWED_ORIGIN) } },
      );
```

- [ ] **Step 5: Confirm the idle timer is now a pause**

The timer at the `Kill Claude session after 15 minutes` block only calls `claudeProc.kill()` — with Step 3's exit handler preserving state, no change is needed. Update the comment to say pause:

```ts
// ── Pause Claude after 15 minutes of inactivity (session resumes on next start) ──
```

- [ ] **Step 6: Run the server test suite**

Run: `bun test tests/`
Expected: PASS. The existing `integration.test.ts` exercises `/api/session/start`; if it asserts on the old `julian-YYYY-MM-DD` id shape, update those assertions to accept a UUID — the id format change is intentional.

- [ ] **Step 7: Commit**

```bash
git add server/server.ts .gitignore
git commit -m "feat(session): resume-first lifecycle — harness id everywhere, pause semantics, loud resume fallback"
```

---

### Task 6: Deliberate final end

**Type:** implementation
**Depends-on:** 5

**Files:**
- Modify: `server/server.ts`

**Interfaces:**
- Consumes: `clearSessionState` (from Task 2); the start/end handlers as reworked by the server-wiring task.
- Produces: `/api/session/end` wire contract — optional body `{ final?: boolean }`; `final: true` clears resume state and appends `session_end` with `final: true`.

- [ ] **Step 1: Parse the final flag in `/api/session/end`**

At the top of the handler (before the `append`):

```ts
      let finalEnd = false;
      try {
        const body = await req.json() as { final?: boolean };
        finalEnd = body?.final === true;
      } catch { /* bodyless POST = plain pause, unchanged */ }
      if (finalEnd) {
        clearSessionState(SESSION_STATE_PATH);
        console.log("[Session] Deliberate final end — resume state cleared");
      }
      append({ sessionId, type: 'user_session_end', final: finalEnd });
```

(Replace the existing `append({ sessionId, type: 'user_session_end' })` line with the block above.)

- [ ] **Step 2: Guard against the exit handler resurrecting state**

The exit handler from the server-wiring task rewrites state on process death — after a final end, the state was cleared *before* the kill, and the guard `st && st.claudeSessionId === sessionId` already prevents rewrite (state reads null). Verify by reading the exit handler; no code change expected — add a comment at the clear site:

```ts
        // Cleared BEFORE the kill: the exit handler's rewrite is guarded on a
        // matching state read, so a final end stays final.
```

- [ ] **Step 3: Run the suite**

Run: `bun test tests/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/server.ts
git commit -m "feat(session): deliberate final end — {final: true} clears resume state"
```

---

### Task 7: Frontend wiring — tail on start, final end control

**Type:** implementation
**Depends-on:** 4

**Files:**
- Modify: `app/src/lib/api.ts`
- Modify: `app/src/App.svelte`
- Modify: `app/src/components/FaceHeader.svelte`
- Test: `app/src/lib/api.test.ts`

**Interfaces:**
- Consumes: `selectTail(store)` and `TailMessage` (from Task 4); the store singleton (existing store module). Builds against the server wire contract: start body `{ previousTranscript: TailMessage[] }`, end body `{ final?: boolean }` — contract-first, no dependency on the server task.
- Produces: `startSession(): Promise<void>` (now sends the tail); `endSession(final?: boolean): Promise<void>`; a FaceHeader `onEndFinal` prop and control.

- [ ] **Step 1: Write the failing tests**

```ts
// app/src/lib/api.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startSession, endSession } from "./api";
import { store } from "./store";

vi.mock("./auth", () => ({ getToken: async () => "tok" }));

describe("session api", () => {
  beforeEach(() => {
    store.delTable("messages");
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as never;
  });
  afterEach(() => vi.restoreAllMocks());

  test("startSession posts the tail as previousTranscript", async () => {
    store.setRow("messages", "m1", { kind: "chat", role: "user", speakerName: "Marcus", text: "hello", ts: 1, sessionId: "s" } as never);
    await startSession();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/session/start");
    const body = JSON.parse(init.body);
    expect(body.previousTranscript).toEqual([
      { role: "user", speakerType: "human", speakerName: "Marcus", text: "hello", ts: 1 },
    ]);
  });

  test("plain endSession sends no body; final end sends {final: true}", async () => {
    await endSession();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body).toBeUndefined();
    await endSession(true);
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body)).toEqual({ final: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && bun run test -- api`
Expected: FAIL — `previousTranscript` is `undefined` (empty body today) and `endSession(true)` sends no body.

- [ ] **Step 3: Implement in `api.ts`**

```ts
import { selectTail } from './tail';
import { store } from './store';

export const startSession = async () => {
  await post('/api/session/start', { previousTranscript: selectTail(store) });
};
export const endSession = async (final = false) => {
  await post('/api/session/end', final ? { final: true } : undefined);
};
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app && bun run test -- api`
Expected: PASS.

- [ ] **Step 5: Add the deliberate-end control**

`App.svelte` — pass the new handler (the existing `onEnd` stays the pause):

```svelte
<FaceHeader {sessionActive} {processing} onEnd={() => endSession()}
  onEndFinal={() => {
    if (confirm('End this session for good? The next one starts fresh, inheriting the recent record.')) endSession(true);
  }} />
```

`FaceHeader.svelte` — accept the prop alongside `onEnd` (match the component's existing prop declaration style, `export let` or `$props()`), and render a second, visually-quieter control next to the existing end control, visible only when `sessionActive`:

```svelte
<button class="end-final" title="End session (final)" on:click={onEndFinal}>end session</button>
```

Style it with the component's existing button classes/palette; it must be distinguishable from the pause control (the pause control keeps its current label).

- [ ] **Step 6: Type-check and full app suite**

Run: `cd app && bun run check && bun run test`
Expected: PASS, no svelte-check errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/api.test.ts app/src/App.svelte app/src/components/FaceHeader.svelte
git commit -m "feat(session): frontend sends the inherited tail; deliberate final-end control"
```

---

### Task 8: Integration test — the full lifecycle against a fake CLI

**Type:** implementation
**Depends-on:** 5, 6

**Files:**
- Create: `tests/server/fixtures/claude`
- Create: `tests/server/session-continuity.test.ts`

**Interfaces:**
- Consumes: the `/api/session/start` and `/api/session/end` wire contracts (from the server-wiring and final-end tasks); `SESSION_STATE_PATH` env override.
- Produces: nothing consumed downstream — this is the lifecycle proof.

Port **18100** (the existing integration test owns 18000); all paths under a per-run temp dir.

- [ ] **Step 1: Write the fake CLI fixture**

```ts
#!/usr/bin/env bun
// tests/server/fixtures/claude — a fake claude CLI speaking just enough
// stream-json for lifecycle tests. Records argv and stdin to files named by
// FAKE_CLAUDE_LOG so tests can assert on what the server actually did.
const log = process.env.FAKE_CLAUDE_LOG!;
const argv = process.argv.slice(2);
await Bun.write(`${log}.argv.${Date.now()}`, JSON.stringify(argv));

const resumeIdx = argv.indexOf("--resume");
const sidIdx = argv.indexOf("--session-id");
const sessionId = resumeIdx >= 0 ? argv[resumeIdx + 1] : sidIdx >= 0 ? argv[sidIdx + 1] : crypto.randomUUID();

// Fallback drill: when the fail-resume flag file exists, a resume attempt dies
// before its system event — exactly how a GC'd transcript presents.
if (resumeIdx >= 0 && (await Bun.file(`${log}.fail-resume`).exists())) {
  console.error("fake-claude: simulated resume failure");
  process.exit(1);
}

console.log(JSON.stringify({ type: "system", session_id: sessionId, model: "fake-model", tools: [] }));

const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  const text = decoder.decode(chunk);
  await Bun.write(`${log}.stdin.${Date.now()}`, text);
  console.log(JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "ok" }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", num_turns: 1, usage: {} }));
}
```

Make it executable: `chmod +x tests/server/fixtures/claude`.

- [ ] **Step 2: Write the failing lifecycle test**

```ts
// tests/server/session-continuity.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
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
      PATH: `${resolve(import.meta.dir, "fixtures")}:${process.env.PATH}`, // fake claude wins
    },
    stdout: "pipe", stderr: "pipe",
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await Bun.sleep(200);
  }
});

afterAll(() => { serverProc?.kill(); });

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
    const stdin = (await Promise.all(readLogs("stdin").map((f) => f.text()))).join("");
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
    const newStdin = (await Promise.all(readLogs("stdin").slice(priorStdinCount).map((f) => f.text()))).join("");
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

    const stdin = (await Promise.all(readLogs("stdin").map((f) => f.text()))).join("");
    expect(stdin).toContain("tail-after-fallback"); // the fallback spawn got the tail
    const { rmSync } = await import("node:fs");
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
```

- [ ] **Step 3: Run to verify current behavior**

Run: `bun test tests/server/session-continuity.test.ts`
Expected: PASS (this task runs after the server-wiring and final-end tasks). Any FAIL is a real integration defect in that server code — fix the server, not the test, until green.

- [ ] **Step 4: Full suite**

Run: `bun test tests/`
Expected: PASS, including the pre-existing integration test on port 18000 (no port collision).

- [ ] **Step 5: Commit**

```bash
git add tests/server/fixtures/claude tests/server/session-continuity.test.ts
git commit -m "test(session): full lifecycle integration — fresh/tail, pause/resume, final end — against a fake CLI"
```

---

### Task 9: Full verification gate

**Type:** gate
**Depends-on:** 5, 6, 7, 8

**Files:** (none — verification only)

- [ ] **Step 1: Server suite**

Run: `bun test tests/`
Expected: PASS, zero failures.

- [ ] **Step 2: App suite and type-check**

Run: `cd app && bun run test && bun run check`
Expected: PASS, zero failures, no svelte-check errors.

- [ ] **Step 3: App build**

Run: `cd app && bun run build`
Expected: clean vite build.

---

### Task 10: Live proof on the Mac

**Type:** manual
**Depends-on:** 9

Owner action (Marcus + Julian at the local app): start a session in the browser, exchange a message, wait out (or simulate) the idle pause, send another message and confirm the conversation context survived (resume); then use the new "end session" control and confirm the next start greets fresh with the `<previous-session>` block acknowledged. Confirm demo mode still starts clean. This is the review-must-touch-reality step for the real CLI path the fake fixture cannot cover.
