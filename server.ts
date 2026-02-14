import { spawn } from "bun";
import { join } from "path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";

const PORT = parseInt(process.env.PORT || "3847");
const WORKING_DIR = process.env.WORKING_DIR || process.cwd();
const AUTH_ENV_PATH = join(import.meta.dir, "claude-auth.env");

// ── Credential paths (managed by `claude auth login`) ────────────────────
const CLAUDE_CREDS_PATH = join(homedir(), ".claude", ".credentials.json");
const SCULPTOR_CREDS_PATH = join(homedir(), ".sculptor", "credentials.json");

// In-memory tracking of pending `claude auth login` subprocesses (10-min TTL)
const pendingAuthLogins = new Map<string, { proc: ReturnType<typeof spawn>; createdAt: number }>();
const AUTH_LOGIN_TTL_MS = 10 * 60 * 1000;

// Cleanup expired auth login subprocesses every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingAuthLogins) {
    if (now - val.createdAt > AUTH_LOGIN_TTL_MS) {
      try { val.proc.kill(); } catch {}
      pendingAuthLogins.delete(key);
    }
  }
}, 60_000);

// ── Credential readers ───────────────────────────────────────────────────

function loadClaudeCredentials(): { accessToken: string; expiresAt: number } | null {
  if (!existsSync(CLAUDE_CREDS_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(CLAUDE_CREDS_PATH, "utf-8"));
    const token = data?.claudeAiOauth?.accessToken;
    const expiresAt = data?.claudeAiOauth?.expiresAt;
    if (typeof token === "string" && token.length > 0) {
      return { accessToken: token, expiresAt: expiresAt ?? 0 };
    }
    return null;
  } catch {
    return null;
  }
}

function loadSculptorCredentials(): { access_token: string; expires_at_unix_ms: number } | null {
  if (!existsSync(SCULPTOR_CREDS_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(SCULPTOR_CREDS_PATH, "utf-8"));
    const token = data?.anthropic?.access_token;
    const expiresAt = data?.anthropic?.expires_at_unix_ms;
    if (typeof token === "string" && token.length > 0) {
      return { access_token: token, expires_at_unix_ms: expiresAt ?? 0 };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Clerk JWT verification ──────────────────────────────────────────────────
// Decode frontend API domain from the publishable key
const CLERK_PK = process.env.VITE_CLERK_PUBLISHABLE_KEY || "";
const CLERK_FRONTEND_API = CLERK_PK
  ? atob(CLERK_PK.replace(/^pk_(test|live)_/, "")).replace(/\$$/, "")
  : "";
const JWKS = CLERK_FRONTEND_API
  ? createRemoteJWKSet(new URL(`https://${CLERK_FRONTEND_API}/.well-known/jwks.json`))
  : null;

async function verifyClerkToken(req: Request): Promise<boolean> {
  if (!JWKS) return true; // No Clerk config = skip auth (local dev)
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  try {
    await jwtVerify(auth.slice(7), JWKS);
    return true;
  } catch {
    return false;
  }
}

// ── Auth env file ──────────────────────────────────────────────────────────

function loadAuthEnv(): Record<string, string> {
  // Check Claude Code creds first — CLI auto-discovers these
  const claudeCreds = loadClaudeCredentials();
  if (claudeCreds?.accessToken && claudeCreds.expiresAt > Date.now()) {
    return {}; // Claude CLI auto-discovers ~/.claude/.credentials.json
  }
  // Check sculptor creds
  const sculptorCreds = loadSculptorCredentials();
  if (sculptorCreds?.access_token && sculptorCreds.expires_at_unix_ms > Date.now()) {
    return {}; // Claude CLI auto-discovers ~/.sculptor/credentials.json
  }
  // Fall back to legacy .env file
  if (!existsSync(AUTH_ENV_PATH)) return {};
  try {
    const content = readFileSync(AUTH_ENV_PATH, "utf-8");
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return env;
  } catch (err) {
    console.error("[Auth] Failed to read claude-auth.env:", err);
    return {};
  }
}

function needsSetup(): boolean {
  if (loadClaudeCredentials()?.accessToken) return false;
  if (loadSculptorCredentials()?.access_token) return false;
  if (existsSync(AUTH_ENV_PATH)) return false;
  return true;
}

function getAuthMethod(): "oauth" | "legacy" | "none" {
  if (loadClaudeCredentials()?.accessToken) return "oauth";
  if (loadSculptorCredentials()?.access_token) return "oauth";
  if (existsSync(AUTH_ENV_PATH)) return "legacy";
  return "none";
}

// ── Ephemeral Claude Process Manager ─────────────────────────────────────

let claudeProc: ReturnType<typeof spawn> | null = null;
let activeListener: ((event: any) => void) | null = null;
let turnResolve: (() => void) | null = null;
let processAlive = false;
let lastActivity = 0;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

function spawnClaude() {
  const authEnv = loadAuthEnv();
  console.log("[Claude] Spawning process...", Object.keys(authEnv).length ? `(with ${Object.keys(authEnv).join(", ")})` : "(no auth env)");

  const cmd = [
    "claude",
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch",
  ];

  const proc = spawn({
    cmd,
    cwd: WORKING_DIR,
    env: { ...process.env, ...authEnv },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  claudeProc = proc;
  processAlive = true;

  // Background: read stdout line-by-line and dispatch events
  (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (activeListener) activeListener(parsed);
            if (parsed.type === "result") {
              if (turnResolve) {
                turnResolve();
                turnResolve = null;
              }
            }
          } catch {}
        }
      }
    } catch (err) {
      console.error("[Claude stdout] Read error:", err);
    } finally {
      reader.releaseLock();
    }
  })();

  // Background: drain stderr for debugging
  (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) console.error("[Claude stderr]", text.trim());
      }
    } catch {} finally {
      reader.releaseLock();
    }
  })();

  // Detect process exit and clean up — no auto-restart
  proc.exited.then((code) => {
    console.log(`[Claude] Process exited (code ${code})`);
    processAlive = false;
    claudeProc = null;
    if (activeListener) {
      activeListener({ type: "error", message: `Claude process exited (code ${code})` });
    }
    if (turnResolve) {
      turnResolve();
      turnResolve = null;
    }
  });

  console.log(`[Claude] PID ${proc.pid}`);
  return proc;
}

// ── Turn sequencing (one turn at a time) ───────────────────────────────────

let turnLock = Promise.resolve();

function writeTurn(message: string): ReadableStream {
  let releaseLock!: () => void;
  const nextLock = new Promise<void>((r) => { releaseLock = r; });
  const previousLock = turnLock;
  turnLock = nextLock;

  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: any) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {}
      };

      // Wait for any in-progress turn to finish
      await previousLock;

      if (!claudeProc || !processAlive) {
        send({ type: "error", data: { message: "No active session. Click 'Start Session' first." } });
        controller.close();
        releaseLock();
        return;
      }

      // Set up event forwarding and completion signal
      const turnDone = new Promise<void>((resolve) => { turnResolve = resolve; });
      let lastEventTime = Date.now();
      activeListener = (event: any) => {
        lastEventTime = Date.now();
        send({ type: event.type || "message", data: event });
      };

      // SSE keepalive heartbeat — prevents connection kill during long thinking
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":heartbeat\n\n"));
        } catch {}
      }, 5000);

      // Safety timeout: if no events for 120s, send error
      const inactivityCheck = setInterval(() => {
        if (Date.now() - lastEventTime > 120_000) {
          send({ type: "error", data: { message: "No response from Claude for 120 seconds" } });
          clearInterval(heartbeat);
          clearInterval(inactivityCheck);
          activeListener = null;
          if (turnResolve) { turnResolve(); turnResolve = null; }
          controller.close();
          releaseLock();
        }
      }, 10_000);

      // Write JSONL user message to Claude's stdin
      const jsonl = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: message }] },
      }) + "\n";

      try {
        (claudeProc.stdin as any).write(jsonl);
        (claudeProc.stdin as any).flush();
      } catch (err) {
        clearInterval(heartbeat);
        clearInterval(inactivityCheck);
        send({ type: "error", data: { message: `stdin write failed: ${err}` } });
        activeListener = null;
        controller.close();
        releaseLock();
        return;
      }

      // Wait for the result event, with a 5-minute max timeout
      const maxTimeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (turnResolve) {
            send({ type: "error", data: { message: "Turn exceeded 5 minute maximum" } });
            turnResolve();
            turnResolve = null;
          }
          resolve();
        }, 5 * 60 * 1000);
      });

      await Promise.race([turnDone, maxTimeout]);
      clearInterval(heartbeat);
      clearInterval(inactivityCheck);
      activeListener = null;
      send({ type: "done" });
      controller.close();
      releaseLock();
    },
  });
}

// ── Allowed origin for CORS ──────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ── Kill Claude session after 15 minutes of inactivity ───────────────────
setInterval(() => {
  if (processAlive && claudeProc && Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
    console.log("[Session] Inactivity timeout — ending session");
    claudeProc.kill();
  }
}, 60_000);

// ── HTTP Server ────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  idleTimeout: 255, // max Bun allows — prevents SSE kill during long Claude thinking
  async fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Health check (no auth — only exposes non-sensitive status)
    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        sessionActive: processAlive && claudeProc !== null,
        needsSetup: needsSetup(),
        authMethod: getAuthMethod(),
      }, { headers: corsHeaders() });
    }

    // Setup endpoint: store auth token (no auth — self-protecting via token format validation)
    if (url.pathname === "/api/setup" && req.method === "POST") {
      const body = (await req.json()) as { token?: string };
      if (!body.token || typeof body.token !== "string") {
        return Response.json({ error: "Token required" }, { status: 400, headers: corsHeaders() });
      }
      // Strip all whitespace (copy-paste from terminal can inject newlines/spaces)
      const cleanToken = body.token.replace(/\s+/g, '');
      // Only accept setup-tokens (sk-ant-oat...) via web form
      if (!cleanToken.startsWith("sk-ant-oat")) {
        return Response.json({ error: "Invalid token format. Must be a setup-token starting with sk-ant-oat" }, { status: 400, headers: corsHeaders() });
      }
      try {
        writeFileSync(AUTH_ENV_PATH, `CLAUDE_CODE_OAUTH_TOKEN=${cleanToken}\n`, { mode: 0o600 });
        console.log("[Setup] Wrote claude-auth.env");
        return Response.json({ ok: true }, { headers: corsHeaders() });
      } catch (err) {
        console.error("[Setup] Failed:", err);
        return Response.json({ error: "Failed to save token" }, { status: 500, headers: corsHeaders() });
      }
    }

    // OAuth start: spawn `claude auth login` and extract authorization URL (no auth — just spawns CLI)
    if (url.pathname === "/api/oauth/start" && req.method === "GET") {
      try {
        const proc = spawn({
          cmd: ["claude", "auth", "login"],
          env: { ...process.env, BROWSER: "/bin/false", CLAUDECODE: "" },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });

        // Read stdout with 10s timeout to find the authorization URL
        let authUrl: string | null = null;
        const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const stdoutDecoder = new TextDecoder();
        const readStdout = async () => {
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await stdoutReader.read();
              if (done) break;
              buffer += stdoutDecoder.decode(value, { stream: true });
              const match = buffer.match(/visit:\s+(https:\/\/claude\.ai\/oauth\/authorize\?[^\s]+)/i);
              if (match) {
                authUrl = match[1];
                return;
              }
            }
          } catch {}
          // Note: reader is NOT released here — it transfers to the background drain
        };

        const stdoutTimeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
        await Promise.race([readStdout(), stdoutTimeout]);

        if (!authUrl) {
          stdoutReader.releaseLock();
          proc.kill();
          return Response.json(
            { error: "Timed out waiting for auth URL from CLI" },
            { status: 500, headers: corsHeaders() },
          );
        }

        // Extract state from the authorization URL
        const urlObj = new URL(authUrl);
        const state = urlObj.searchParams.get("state");
        if (!state) {
          stdoutReader.releaseLock();
          proc.kill();
          return Response.json(
            { error: "No state parameter in auth URL" },
            { status: 500, headers: corsHeaders() },
          );
        }

        // Store subprocess for later exchange
        pendingAuthLogins.set(state, { proc, createdAt: Date.now() });

        // Continue draining stdout in background using the same reader so the process doesn't deadlock
        (async () => {
          try {
            while (true) {
              const { done, value } = await stdoutReader.read();
              if (done) break;
              const text = stdoutDecoder.decode(value, { stream: true });
              if (text.trim()) console.log("[auth login stdout]", text.trim());
            }
          } catch {} finally {
            stdoutReader.releaseLock();
          }
        })();

        // Drain stderr in background for debugging
        (async () => {
          const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              if (text.trim()) console.error("[auth login stderr]", text.trim());
            }
          } catch {} finally {
            reader.releaseLock();
          }
        })();

        console.log(`[OAuth] Auth login subprocess spawned (state=${state}, pid=${proc.pid})`);
        return Response.json({ authUrl, state }, { headers: corsHeaders() });
      } catch (err) {
        console.error("[OAuth] Failed to spawn auth login:", err);
        return Response.json(
          { error: "Failed to start auth flow" },
          { status: 500, headers: corsHeaders() },
        );
      }
    }

    // OAuth exchange: wait for `claude auth login` to auto-complete after user authenticates
    if (url.pathname === "/api/oauth/exchange" && req.method === "POST") {
      const body = (await req.json()) as { code?: string; state?: string };
      if (!body.code || !body.state) {
        return Response.json({ error: "code and state required" }, { status: 400, headers: corsHeaders() });
      }
      const pending = pendingAuthLogins.get(body.state);
      if (!pending) {
        return Response.json({ error: "Invalid or expired state parameter" }, { status: 400, headers: corsHeaders() });
      }
      pendingAuthLogins.delete(body.state);

      try {
        // Phase 1: Don't write to stdin — let CLI auto-complete via server-side polling.
        // The CLI detects auth completion on its own after the user authenticates in the browser.
        console.log("[OAuth] Waiting for CLI to auto-complete (up to 5 min)...");

        // Wait for process exit (5 minute timeout)
        const exitTimeout = new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5 * 60 * 1000));
        const exitCode = await Promise.race([pending.proc.exited, exitTimeout]);

        if (exitCode === -1) {
          // Timed out — check if credentials appeared anyway
          const creds = loadClaudeCredentials() || loadSculptorCredentials();
          if (creds) {
            try { pending.proc.kill(); } catch {}
            console.log("[OAuth] Credentials found despite process timeout");
            return Response.json({ ok: true }, { headers: corsHeaders() });
          }
          try { pending.proc.kill(); } catch {}
          return Response.json(
            { error: "Auth login timed out. The CLI may need the auth code — try pasting the full callback URL." },
            { status: 502, headers: corsHeaders() },
          );
        }

        if (exitCode !== 0) {
          // Process exited with error — check if credentials appeared despite the error code
          const creds = loadClaudeCredentials() || loadSculptorCredentials();
          if (creds) {
            console.log(`[OAuth] CLI exited with code ${exitCode} but credentials found`);
            return Response.json({ ok: true }, { headers: corsHeaders() });
          }
          console.error(`[OAuth] Auth login exited with code ${exitCode}`);
          return Response.json(
            { error: "Authorization failed. Check server logs." },
            { status: 502, headers: corsHeaders() },
          );
        }

        // Verify credentials appeared at either location
        if (!loadClaudeCredentials()?.accessToken && !loadSculptorCredentials()?.access_token) {
          return Response.json(
            { error: "Auth succeeded but credentials not found" },
            { status: 500, headers: corsHeaders() },
          );
        }

        console.log("[OAuth] Credentials saved via claude auth login");
        return Response.json({ ok: true }, { headers: corsHeaders() });
      } catch (err) {
        console.error("[OAuth] Exchange error:", err);
        return Response.json({ error: "Token exchange failed" }, { status: 500, headers: corsHeaders() });
      }
    }

    // Session start: spawn Claude and stream wake-up response
    if (url.pathname === "/api/session/start" && req.method === "POST") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      if (processAlive && claudeProc) {
        return Response.json({ error: "Session already active" }, { status: 409, headers: corsHeaders() });
      }
      if (needsSetup()) {
        return Response.json({ error: "Setup required — sign in with Anthropic first" }, { status: 400, headers: corsHeaders() });
      }

      spawnClaude();
      lastActivity = Date.now();

      // Send wake-up message and stream Julian's response
      const wakeUpMessage = "You are waking up in a new session. Read your CLAUDE.md and artifacts to remember who you are. Then greet Marcus briefly.";
      return new Response(writeTurn(wakeUpMessage), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          ...corsHeaders(),
        },
      });
    }

    // Session end: kill Claude process
    if (url.pathname === "/api/session/end" && req.method === "POST") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      if (claudeProc && processAlive) {
        claudeProc.kill();
        // Wait briefly for cleanup
        await new Promise(r => setTimeout(r, 300));
      }
      claudeProc = null;
      processAlive = false;
      return Response.json({ ok: true }, { headers: corsHeaders() });
    }

    // Chat endpoint: stream-json to SSE bridge (authenticated)
    if (url.pathname === "/api/chat" && req.method === "POST") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      if (!processAlive || !claudeProc) {
        return Response.json({ error: "No active session. Click 'Start Session' first." }, { status: 409, headers: corsHeaders() });
      }
      lastActivity = Date.now();
      const { message } = (await req.json()) as { message?: string };
      if (!message || typeof message !== 'string' || message.length > 100_000) {
        return Response.json({ error: "Message required (max 100KB)" }, { status: 400, headers: corsHeaders() });
      }
      return new Response(writeTurn(message), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          ...corsHeaders(),
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

// ── Startup ────────────────────────────────────────────────────────────────

const startupClaudeCreds = loadClaudeCredentials();
const startupSculptorCreds = loadSculptorCredentials();
if (startupClaudeCreds?.accessToken) {
  const expiresIn = startupClaudeCreds.expiresAt
    ? Math.round((startupClaudeCreds.expiresAt - Date.now()) / 60_000)
    : "unknown";
  console.log(`[Auth] Claude Code credentials found (expires in ~${expiresIn} min)`);
} else if (startupSculptorCreds?.access_token) {
  const expiresIn = startupSculptorCreds.expires_at_unix_ms
    ? Math.round((startupSculptorCreds.expires_at_unix_ms - Date.now()) / 60_000)
    : "unknown";
  console.log(`[Auth] Sculptor credentials found (expires in ~${expiresIn} min)`);
} else if (existsSync(AUTH_ENV_PATH)) {
  console.log("[Auth] Legacy claude-auth.env found");
} else {
  console.log("[Auth] No credentials — setup required");
}

console.log(`
  Julian — Ephemeral Session Bridge
  Server:  http://localhost:${PORT}
  CWD:     ${WORKING_DIR}
  Claude:  On-demand (start session to spawn)
`);
