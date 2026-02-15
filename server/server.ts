import { spawn } from "bun";
import { join, resolve } from "path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { createHash, randomBytes } from "crypto";

const PORT = parseInt(process.env.PORT || "8000");
const WORKING_DIR = process.env.WORKING_DIR || process.cwd();
const AUTH_ENV_PATH = join(import.meta.dir, "..", "claude-auth.env");

// ── Credential paths ────────────────────────────────────────────────────
const CLAUDE_CREDS_PATH = join(homedir(), ".claude", ".credentials.json");
const SCULPTOR_CREDS_PATH = join(homedir(), ".sculptor", "credentials.json");

// ── OAuth PKCE constants (extracted from Claude CLI binary) ─────────────
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const OAUTH_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers";

// In-memory tracking of pending PKCE flows (10-min TTL)
const pendingPKCE = new Map<string, { verifier: string; createdAt: number }>();
const PKCE_TTL_MS = 10 * 60 * 1000;

// Cleanup expired PKCE flows every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingPKCE) {
    if (now - val.createdAt > PKCE_TTL_MS) {
      pendingPKCE.delete(key);
    }
  }
}, 60_000);

// ── PKCE helpers ────────────────────────────────────────────────────────
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

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
  // Check Authorization header, fall back to X-Authorization (exe.dev edge proxy strips Authorization)
  const auth = req.headers.get("Authorization") || req.headers.get("X-Authorization");
  if (!auth?.startsWith("Bearer ")) {
    console.warn("[Clerk] No Authorization header in request");
    return false;
  }
  try {
    await jwtVerify(auth.slice(7), JWKS, { clockTolerance: 10 });
    return true;
  } catch (err) {
    console.error("[Clerk] JWT verification failed:", (err as Error).message);
    return false;
  }
}

// ── Token refresh ───────────────────────────────────────────────────────

async function refreshTokenIfNeeded(): Promise<boolean> {
  const claudeCreds = loadClaudeCredentials();
  if (!claudeCreds?.accessToken) return false;

  // Read full credentials to get refresh token
  let data: any;
  try {
    data = JSON.parse(readFileSync(CLAUDE_CREDS_PATH, "utf-8"));
  } catch { return false; }

  const refreshToken = data?.claudeAiOauth?.refreshToken;
  if (!refreshToken) return false;

  const expiresAt = data?.claudeAiOauth?.expiresAt ?? 0;
  const thirtyMinutes = 30 * 60 * 1000;

  // Token still valid for 30+ minutes — no refresh needed
  if (expiresAt > Date.now() + thirtyMinutes) return false;

  console.log("[Auth] Token expires soon, refreshing...");
  try {
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[Auth] Refresh failed (${resp.status}):`, errText);
      return false;
    }

    const tokens = await resp.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Write new credentials (refresh token rotates!)
    writeCredentials(tokens.access_token, tokens.refresh_token, tokens.expires_in);
    console.log(`[Auth] Token refreshed (expires in ${Math.round(tokens.expires_in / 60)} min)`);
    return true;
  } catch (err) {
    console.error("[Auth] Refresh error:", err);
    return false;
  }
}

function writeCredentials(accessToken: string, refreshToken: string, expiresIn: number) {
  const dir = join(homedir(), ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const creds = {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      scopes: ["user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
  };
  writeFileSync(CLAUDE_CREDS_PATH, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
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

async function needsSetup(): Promise<boolean> {
  // Check if creds are currently valid
  const claudeCreds = loadClaudeCredentials();
  if (claudeCreds?.accessToken && claudeCreds.expiresAt > Date.now()) return false;
  const sculptorCreds = loadSculptorCredentials();
  if (sculptorCreds?.access_token && sculptorCreds.expires_at_unix_ms > Date.now()) return false;
  if (existsSync(AUTH_ENV_PATH)) return false;

  // Creds exist but expired — try refresh before giving up
  if (claudeCreds?.accessToken) {
    const refreshed = await refreshTokenIfNeeded();
    if (refreshed) return false;
  }

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
          } catch (err) {
            console.warn("[Claude stdout] Failed to parse JSON line:", (err as Error).message, line.slice(0, 200));
          }
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
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:8000";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Authorization",
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
        needsSetup: await needsSetup(),
        authMethod: getAuthMethod(),
      }, { headers: corsHeaders() });
    }

    // Setup endpoint: store auth token (requires Clerk auth)
    if (url.pathname === "/api/setup" && req.method === "POST") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
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

    // OAuth start: generate PKCE auth URL directly (no subprocess)
    if (url.pathname === "/api/oauth/start" && req.method === "GET") {
      const state = randomBytes(32).toString("hex");
      const verifier = generateCodeVerifier();
      const challenge = generateCodeChallenge(verifier);

      const authUrl = `${OAUTH_AUTHORIZE_URL}?` + new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        code_challenge: challenge,
        code_challenge_method: "S256",
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPES,
        state,
        response_type: "code",
      }).toString();

      pendingPKCE.set(state, { verifier, createdAt: Date.now() });

      console.log(`[OAuth] PKCE flow started (state=${state.slice(0, 8)}...)`);
      return Response.json({ authUrl, state }, { headers: corsHeaders() });
    }

    // OAuth exchange: POST authorization code to token endpoint directly
    if (url.pathname === "/api/oauth/exchange" && req.method === "POST") {
      const body = (await req.json()) as { code?: string; state?: string };
      if (!body.code || !body.state) {
        return Response.json({ error: "code and state required" }, { status: 400, headers: corsHeaders() });
      }
      const pending = pendingPKCE.get(body.state);
      if (!pending) {
        return Response.json({ error: "Invalid or expired state parameter" }, { status: 400, headers: corsHeaders() });
      }
      pendingPKCE.delete(body.state);

      try {
        // Strip #state suffix if the frontend passed the full callback fragment
        const code = body.code.split("#")[0];

        const exchangeBody = {
            grant_type: "authorization_code",
            code,
            redirect_uri: OAUTH_REDIRECT_URI,
            client_id: OAUTH_CLIENT_ID,
            code_verifier: pending.verifier,
            state: body.state,
          };
        console.log("[OAuth] Exchanging authorization code for tokens...");
        console.log("[OAuth] Request body:", JSON.stringify({ ...exchangeBody, code: code.slice(0, 10) + '...', code_verifier: exchangeBody.code_verifier.slice(0, 10) + '...' }));
        const resp = await fetch(OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(exchangeBody),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          console.error(`[OAuth] Token exchange failed (${resp.status}):`, errText);
          return Response.json(
            { error: `Token exchange failed (${resp.status}): ${errText}` },
            { status: 502, headers: corsHeaders() },
          );
        }

        const tokens = await resp.json() as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
        };

        writeCredentials(tokens.access_token, tokens.refresh_token, tokens.expires_in);
        console.log(`[OAuth] Credentials saved (expires in ${Math.round(tokens.expires_in / 60)} min)`);
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
      if (await needsSetup()) {
        return Response.json({ error: "Setup required — sign in with Anthropic first" }, { status: 400, headers: corsHeaders() });
      }

      // Proactively refresh token before spawning Claude
      await refreshTokenIfNeeded();

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

    // ── Artifact endpoints ──────────────────────────────────────────────────

    // List artifacts (authenticated)
    if (url.pathname === "/api/artifacts" && req.method === "GET") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      const memoryDir = join(WORKING_DIR, "memory");
      try {
        const entries = readdirSync(memoryDir)
          .filter(f => f.endsWith(".html"))
          .map(name => {
            const st = statSync(join(memoryDir, name));
            return { name, modified: st.mtimeMs };
          })
          .sort((a, b) => b.modified - a.modified);
        return Response.json({ files: entries }, { headers: corsHeaders() });
      } catch (err) {
        return Response.json({ files: [] }, { headers: corsHeaders() });
      }
    }

    // Serve individual artifact (unauthenticated — iframes can't send headers)
    if (url.pathname.startsWith("/api/artifacts/") && req.method === "GET") {
      const filename = decodeURIComponent(url.pathname.slice("/api/artifacts/".length));
      // Validate filename: no slashes, no path traversal
      if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..") || !filename.endsWith(".html")) {
        return new Response("Bad Request", { status: 400, headers: corsHeaders() });
      }
      const filePath = join(WORKING_DIR, "memory", filename);
      try {
        const content = readFileSync(filePath, "utf-8");
        return new Response(content, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
        });
      } catch {
        return new Response("Not Found", { status: 404, headers: corsHeaders() });
      }
    }

    // ── Static file serving ──────────────────────────────────────────────
    // Serve files from WORKING_DIR (replaces nginx static serving)
    const requestedPath = decodeURIComponent(url.pathname);
    const safePath = resolve(WORKING_DIR, requestedPath.slice(1)); // strip leading /
    if (safePath.startsWith(resolve(WORKING_DIR))) {
      const file = Bun.file(safePath);
      if (await file.exists()) {
        const headers: Record<string, string> = {};
        // Service worker must not be cached
        if (requestedPath === "/sw.js") {
          headers["Cache-Control"] = "no-cache";
        }
        return new Response(file, { headers });
      }
    }

    // SPA fallback — serve index.html for client-side routes
    const indexFile = Bun.file(join(WORKING_DIR, "index.html"));
    if (await indexFile.exists()) {
      return new Response(indexFile);
    }

    return new Response("Not Found", { status: 404 });
  },
});

// ── Startup ────────────────────────────────────────────────────────────────

(async () => {
  // Try refreshing token at startup if it's expiring soon
  await refreshTokenIfNeeded();

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
})();
