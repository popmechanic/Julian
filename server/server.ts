import { spawn } from "bun";
import { join, resolve } from "path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { createHash, randomBytes } from "crypto";

const PORT = parseInt(process.env.PORT || "8000");
const WORKING_DIR = process.env.WORKING_DIR || process.cwd();

// Git version for deploy detection — read once at startup
let GIT_VERSION = "unknown";
try {
  const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: WORKING_DIR });
  GIT_VERSION = result.stdout.toString().trim() || "unknown";
} catch {}
console.log(`[Server] Git version: ${GIT_VERSION}`);
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
    await jwtVerify(auth.slice(7), JWKS, { clockTolerance: 60 });
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
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const TURN_INACTIVITY_MS = 120_000;
const TURN_INACTIVITY_CHECK_MS = 10_000;
const MAX_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const PROCESS_KILL_WAIT_MS = 300;
const MAX_MESSAGE_SIZE = 100_000;
let sessionId: string | null = null;
const AGENT_NAME = process.env.AGENT_NAME || "Julian";

function spawnClaude() {
  sessionId = crypto.randomUUID();
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
    } catch (err) {
      console.debug("[Claude stderr] Read error:", err);
    } finally {
      reader.releaseLock();
    }
  })();

  // Detect process exit and clean up — no auto-restart
  proc.exited.then((code) => {
    console.log(`[Claude] Process exited (code ${code})`);
    processAlive = false;
    claudeProc = null;
    sessionId = null;
    if (activeListener) {
      activeListener({ type: "error", message: `Claude process exited (code ${code})` });
    }
    if (turnResolve) {
      turnResolve();
      turnResolve = null;
    }
  });

  console.log(`[Claude] PID ${proc.pid}, sessionId ${sessionId}`);
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
      }, HEARTBEAT_INTERVAL_MS);

      // Safety timeout: if no events for TURN_INACTIVITY_MS, send error
      const inactivityCheck = setInterval(() => {
        if (Date.now() - lastEventTime > TURN_INACTIVITY_MS) {
          send({ type: "error", data: { message: `No response from Claude for ${TURN_INACTIVITY_MS / 1000} seconds` } });
          clearInterval(heartbeat);
          clearInterval(inactivityCheck);
          activeListener = null;
          if (turnResolve) { turnResolve(); turnResolve = null; }
          controller.close();
          releaseLock();
        }
      }, TURN_INACTIVITY_CHECK_MS);

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

      // Wait for the result event, with a max timeout
      const maxTimeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (turnResolve) {
            send({ type: "error", data: { message: `Turn exceeded ${MAX_TURN_TIMEOUT_MS / 60_000} minute maximum` } });
            turnResolve();
            turnResolve = null;
          }
          resolve();
        }, MAX_TURN_TIMEOUT_MS);
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
    "Access-Control-Expose-Headers": "X-Session-Id",
  };
}

// ── Skill directory walker ────────────────────────────────────────────────
function walkSkillDirs(baseDir: string): Array<{name: string, type: string, children?: any[]}> {
  const results: Array<{name: string, type: string, children?: any[]}> = [];
  if (!existsSync(baseDir)) return results;

  try {
    // Look for plugin directories that contain skills/
    const entries = readdirSync(baseDir);
    for (const entry of entries) {
      const pluginPath = join(baseDir, entry);
      if (!statSync(pluginPath).isDirectory()) continue;

      // Check for skills/ directly
      const skillsDir = join(pluginPath, 'skills');
      if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
        const skills = readdirSync(skillsDir)
          .filter(s => {
            const sp = join(skillsDir, s);
            return statSync(sp).isDirectory();
          })
          .map(s => ({ name: s, type: 'file' as const }));
        if (skills.length > 0) {
          results.push({ name: entry, type: 'folder', children: skills });
        }
      }

      // Also check nested: cache/<marketplace>/<plugin>/<version>/skills/
      // Walk one more level for cache directory structure
      try {
        const subEntries = readdirSync(pluginPath);
        for (const sub of subEntries) {
          const subPath = join(pluginPath, sub);
          if (!statSync(subPath).isDirectory()) continue;
          // Check for versioned plugin dirs
          const versionDirs = readdirSync(subPath).filter(v => {
            return statSync(join(subPath, v)).isDirectory();
          });
          for (const ver of versionDirs) {
            const verSkillsDir = join(subPath, ver, 'skills');
            if (existsSync(verSkillsDir) && statSync(verSkillsDir).isDirectory()) {
              const skills = readdirSync(verSkillsDir)
                .filter(s => statSync(join(verSkillsDir, s)).isDirectory())
                .map(s => ({ name: s, type: 'file' as const }));
              if (skills.length > 0) {
                // Use the plugin name (sub) as the namespace, avoid duplicates
                const existing = results.find(r => r.name === sub);
                if (existing && existing.children) {
                  for (const sk of skills) {
                    if (!existing.children.find((c: any) => c.name === sk.name)) {
                      existing.children.push(sk);
                    }
                  }
                } else {
                  results.push({ name: sub, type: 'folder', children: skills });
                }
              }
            }
          }
        }
      } catch (err) {
        console.debug("[Skills] Error scanning nested plugin dir:", entry, err);
      }
    }
  } catch (err) {
    console.debug("[Skills] Error scanning plugin base dir:", baseDir, err);
  }

  return results;
}

// ── Kill Claude session after 15 minutes of inactivity ───────────────────
setInterval(() => {
  if (processAlive && claudeProc && Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
    console.log("[Session] Inactivity timeout — ending session");
    claudeProc.kill();
  }
}, 60_000);

// ── HTTP Server ────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // max Bun allows — prevents SSE kill during long Claude thinking
  async fetch(req) {
    const url = new URL(req.url);

    // WebSocket upgrade for JulianScreen proxy (unauthenticated — low-risk pixel display)
    if (url.pathname === '/screen/ws') {
      const upgraded = server.upgrade(req, { data: {} });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Health check (no auth — only exposes non-sensitive status)
    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        sessionActive: processAlive && claudeProc !== null,
        sessionId,
        needsSetup: await needsSetup(),
        authMethod: getAuthMethod(),
        version: GIT_VERSION,
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
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
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
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
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

      // Parse previousTranscript and artifactCatalog from POST body (if any)
      let previousTranscript: Array<{ role: string; speakerType: string; speakerName: string; text: string }> = [];
      let artifactCatalog: Array<{ filename: string; category: string; description: string; chapter?: string }> = [];
      try {
        const body = await req.json() as { previousTranscript?: any[], artifactCatalog?: any[] };
        if (Array.isArray(body.previousTranscript)) {
          previousTranscript = body.previousTranscript;
        }
        if (Array.isArray(body.artifactCatalog)) {
          artifactCatalog = body.artifactCatalog;
        }
      } catch {} // No body or invalid JSON — proceed without transcript

      spawnClaude();
      lastActivity = Date.now();

      // Build wakeup message with XML-tagged transcript
      let wakeUpMessage = "You are waking up in a new session. Read catalog.xml now — it contains your entire identity and memories.\n\n";

      // Artifact catalog from Fireproof
      if (artifactCatalog.length > 0) {
        const lines = artifactCatalog
          .map((a: any) => `- ${a.filename} [${a.category}] — ${a.description}`)
          .join("\n");
        wakeUpMessage += `<memory category="catalog" document-count="${artifactCatalog.length}">\n${lines}\n</memory>\n\n`;
      }

      if (previousTranscript.length > 0) {
        const ended = new Date().toISOString();
        const lines = previousTranscript.map(msg =>
          `[${msg.speakerType || "human"} — ${msg.speakerName || "Unknown"}]: ${msg.text}`
        ).join("\n");
        wakeUpMessage += `<previous-session category="transcript" session-id="rehydrated" message-count="${previousTranscript.length}" ended="${ended}">\n${lines}\n</previous-session>\n\n`;
        wakeUpMessage += "Greet Marcus briefly, acknowledging continuity with your previous conversation.";
      } else {
        wakeUpMessage += "Then greet Marcus briefly.";
      }

      return new Response(writeTurn(wakeUpMessage), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Session-Id": sessionId || "",
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
        await new Promise(r => setTimeout(r, PROCESS_KILL_WAIT_MS));
      }
      claudeProc = null;
      processAlive = false;
      sessionId = null;
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
      const { message, targetAgent } = (await req.json()) as { message?: string; targetAgent?: string };
      if (!message || typeof message !== 'string' || message.length > MAX_MESSAGE_SIZE) {
        return Response.json({ error: `Message required (max ${MAX_MESSAGE_SIZE / 1000}KB)` }, { status: 400, headers: corsHeaders() });
      }
      const routedMessage = targetAgent
        ? `[ROUTE TO AGENT: ${targetAgent}] ${message}`
        : message;
      return new Response(writeTurn(routedMessage), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          ...corsHeaders(),
        },
      });
    }

    // Summon agents endpoint: triggers Julian to create agent team
    if (url.pathname === "/api/agents/summon" && req.method === "POST") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      if (!processAlive || !claudeProc) {
        return Response.json({ error: "No active session" }, { status: 409, headers: corsHeaders() });
      }
      lastActivity = Date.now();
      const summonMessage = "[SUMMON AGENTS] The user has clicked the Summon button. Begin the summoning ceremony: create the agent team and spawn 8 agents using the individuation protocol described in your CLAUDE.md.";
      return new Response(writeTurn(summonMessage), {
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
      const soulDir = join(WORKING_DIR, "soul");
      try {
        const memoryEntries = readdirSync(memoryDir)
          .filter(f => f.endsWith(".html"))
          .map(name => {
            const st = statSync(join(memoryDir, name));
            return { name, modified: st.mtimeMs, dir: "memory" };
          });
        let soulEntries: Array<{ name: string; modified: number; dir: string }> = [];
        try {
          soulEntries = readdirSync(soulDir)
            .filter(f => f.endsWith(".html"))
            .map(name => {
              const st = statSync(join(soulDir, name));
              return { name, modified: st.mtimeMs, dir: "soul" };
            });
        } catch {}
        const entries = [...memoryEntries, ...soulEntries]
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
      let filePath = join(WORKING_DIR, "memory", filename);
      if (!existsSync(filePath)) {
        filePath = join(WORKING_DIR, "soul", filename);
      }
      try {
        const content = readFileSync(filePath, "utf-8");
        return new Response(content, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
        });
      } catch {
        return new Response("Not Found", { status: 404, headers: corsHeaders() });
      }
    }

    // ── Skills endpoint ──────────────────────────────────────────────────

    if (url.pathname === "/api/skills" && req.method === "GET") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      try {
        const allEntries: Array<{name: string, type: string, children?: any[]}> = [];

        // 1. Project-level plugins: WORKING_DIR/.claude/plugins/
        const projectPlugins = join(WORKING_DIR, ".claude", "plugins");
        const projectResults = walkSkillDirs(projectPlugins);
        for (const r of projectResults) {
          const existing = allEntries.find(e => e.name === r.name);
          if (existing && existing.children && r.children) {
            for (const c of r.children) {
              if (!existing.children.find((ec: any) => ec.name === c.name)) {
                existing.children.push(c);
              }
            }
          } else {
            allEntries.push(r);
          }
        }

        // 2. User-level plugins: ~/.claude/plugins/
        const userPlugins = join(homedir(), ".claude", "plugins");
        const userResults = walkSkillDirs(userPlugins);
        for (const r of userResults) {
          const existing = allEntries.find(e => e.name === r.name);
          if (existing && existing.children && r.children) {
            for (const c of r.children) {
              if (!existing.children.find((ec: any) => ec.name === c.name)) {
                existing.children.push(c);
              }
            }
          } else {
            allEntries.push(r);
          }
        }

        // 3. Project-level julian-plugin/skills/ (direct skill directory)
        const julianPluginSkills = join(WORKING_DIR, "julian-plugin", "skills");
        if (existsSync(julianPluginSkills) && statSync(julianPluginSkills).isDirectory()) {
          const skills = readdirSync(julianPluginSkills)
            .filter(s => {
              const sp = join(julianPluginSkills, s);
              return statSync(sp).isDirectory();
            })
            .map(s => ({ name: s, type: 'file' as const }));
          if (skills.length > 0) {
            const existing = allEntries.find(e => e.name === "julian-plugin");
            if (existing && existing.children) {
              for (const sk of skills) {
                if (!existing.children.find((c: any) => c.name === sk.name)) {
                  existing.children.push(sk);
                }
              }
            } else {
              allEntries.push({ name: "julian-plugin", type: "folder", children: skills });
            }
          }
        }

        return Response.json({ entries: allEntries }, { headers: corsHeaders() });
      } catch (err) {
        console.debug("[Skills] Error listing skills:", err);
        return Response.json({ entries: [] }, { headers: corsHeaders() });
      }
    }

    // ── Agents endpoint ──────────────────────────────────────────────────

    if (url.pathname === "/api/agents" && req.method === "GET") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      const teamsDir = join(homedir(), ".claude", "teams");
      try {
        if (!existsSync(teamsDir)) {
          return Response.json({ teams: [] }, { headers: corsHeaders() });
        }
        const teamDirs = readdirSync(teamsDir).filter(d => {
          return statSync(join(teamsDir, d)).isDirectory();
        });
        const teams = [];
        for (const dir of teamDirs) {
          const configPath = join(teamsDir, dir, "config.json");
          if (!existsSync(configPath)) continue;
          try {
            const config = JSON.parse(readFileSync(configPath, "utf-8"));
            teams.push({
              name: config.name || dir,
              members: (config.members || []).map((m: any) => ({
                name: m.name || "unknown",
                agentType: m.agent_type || m.agentType || "unknown",
              })),
            });
          } catch (err) {
            console.debug("[Agents] Error parsing team config:", dir, err);
          }
        }
        return Response.json({ teams }, { headers: corsHeaders() });
      } catch (err) {
        console.debug("[Agents] Error listing teams:", err);
        return Response.json({ teams: [] }, { headers: corsHeaders() });
      }
    }

    // ── Static file serving ──────────────────────────────────────────────

    // Sprite path rewrite for JulianScreen
    if (url.pathname.startsWith('/sprites/')) {
      const spritePath = resolve(WORKING_DIR, 'julianscreen', url.pathname.slice(1));
      const spriteFile = Bun.file(spritePath);
      if (await spriteFile.exists()) {
        return new Response(spriteFile);
      }
    }

    // Serve files from WORKING_DIR (replaces nginx static serving)
    const requestedPath = decodeURIComponent(url.pathname);

    // Block sensitive files/directories from being served
    const BLOCKED_PREFIXES = ['/.env', '/claude-auth.env', '/.git', '/server/', '/deploy/', '/node_modules/', '/CLAUDE.md', '/.claude/', '/docs/', '/julian-plugin/'];
    if (BLOCKED_PREFIXES.some(p => requestedPath === p || requestedPath.startsWith(p))) {
      return new Response("Not Found", { status: 404 });
    }

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
  websocket: {
    open(ws) {
      // Connect to upstream JulianScreen server
      const upstream = new WebSocket('ws://localhost:3848/ws');
      (ws.data as any).upstream = upstream;
      (ws.data as any).ready = false;

      upstream.addEventListener('open', () => {
        (ws.data as any).ready = true;
      });
      upstream.addEventListener('message', (event) => {
        try { ws.send(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer)); } catch {}
      });
      upstream.addEventListener('close', () => {
        try { ws.close(); } catch {}
      });
      upstream.addEventListener('error', () => {
        try { ws.close(); } catch {}
      });
    },
    message(ws, message) {
      const upstream = (ws.data as any).upstream as WebSocket;
      if (upstream && (ws.data as any).ready) {
        upstream.send(message);
      }
    },
    close(ws) {
      const upstream = (ws.data as any).upstream as WebSocket;
      if (upstream) {
        try { upstream.close(); } catch {}
      }
    },
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
