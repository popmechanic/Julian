import { spawn } from "bun";
import { join } from "path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";

const PORT = parseInt(process.env.PORT || "3847");
const WORKING_DIR = process.env.WORKING_DIR || process.cwd();
const AUTH_ENV_PATH = join(import.meta.dir, "claude-auth.env");

// ── OAuth constants ────────────────────────────────────────────────────────
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_AUTHORIZE_URL = "https://console.anthropic.com/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const OAUTH_SCOPES = "org:create_api_key user:profile user:inference";
const AUTH_JSON_PATH = join(import.meta.dir, "claude-auth.json");

// In-memory PKCE state (10-min TTL)
const pendingOAuth = new Map<string, { verifier: string; createdAt: number }>();
const PKCE_TTL_MS = 10 * 60 * 1000;

// Cleanup expired PKCE entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOAuth) {
    if (now - val.createdAt > PKCE_TTL_MS) pendingOAuth.delete(key);
  }
}, 60_000);

function generateRandomBase64url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64url(plain: string): Promise<string> {
  const encoded = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── OAuth token storage (JSON) ────────────────────────────────────────────
interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

function loadOAuthTokens(): OAuthTokens | null {
  if (!existsSync(AUTH_JSON_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(AUTH_JSON_PATH, "utf-8"));
    if (typeof data?.access_token === "string" && data.access_token.length > 0) {
      return data as OAuthTokens;
    }
    return null;
  } catch {
    return null;
  }
}

function saveOAuthTokens(tokens: OAuthTokens): void {
  writeFileSync(AUTH_JSON_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

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
  // Check OAuth JSON first — only use if not expired
  const oauthTokens = loadOAuthTokens();
  if (oauthTokens?.access_token && oauthTokens.expires_at > Date.now()) {
    return { CLAUDE_CODE_OAUTH_TOKEN: oauthTokens.access_token };
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
  if (existsSync(AUTH_JSON_PATH) && loadOAuthTokens()?.access_token) return false;
  if (existsSync(AUTH_ENV_PATH)) return false;
  return true;
}

function getAuthMethod(): "oauth" | "legacy" | "none" {
  if (existsSync(AUTH_JSON_PATH) && loadOAuthTokens()?.access_token) return "oauth";
  if (existsSync(AUTH_ENV_PATH)) return "legacy";
  return "none";
}

// ── Persistent Claude Process Manager ──────────────────────────────────────

let claudeProc: ReturnType<typeof spawn> | null = null;
let activeListener: ((event: any) => void) | null = null;
let turnResolve: (() => void) | null = null;
let processAlive = false;
let lastSessionId: string | null = null;

function spawnClaude() {
  const authEnv = loadAuthEnv();
  console.log("[Claude] Spawning persistent process...", Object.keys(authEnv).length ? `(with ${Object.keys(authEnv).join(", ")})` : "(no auth env)");

  const cmd = [
    "claude",
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch",
  ];

  // Resume previous session if process died mid-conversation
  if (lastSessionId) {
    cmd.push("--resume", lastSessionId);
    console.log(`[Claude] Resuming session ${lastSessionId}`);
  }

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
            // Capture session_id for resume support
            if (parsed.type === "result") {
              if (parsed.session_id) lastSessionId = parsed.session_id;
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

  // Detect process exit and clean up pending state
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

function ensureProcess() {
  if (!claudeProc || !processAlive) {
    spawnClaude();
  }
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

      ensureProcess();

      if (!claudeProc) {
        send({ type: "error", data: { message: "Claude process unavailable" } });
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

// ── OAuth token refresh ────────────────────────────────────────────────────

async function refreshAccessToken(): Promise<boolean> {
  const tokens = loadOAuthTokens();
  if (!tokens?.refresh_token) return false;
  console.log("[OAuth] Refreshing access token...");
  try {
    const res = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: ANTHROPIC_CLIENT_ID,
        refresh_token: tokens.refresh_token,
      }),
    });
    if (!res.ok) {
      console.error("[OAuth] Refresh failed:", res.status, await res.text());
      return false;
    }
    const data = await res.json() as any;
    const newTokens: OAuthTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    saveOAuthTokens(newTokens);
    console.log("[OAuth] Token refreshed, expires at", new Date(newTokens.expires_at).toISOString());

    // Restart Claude process with new token — defer if a turn is active
    const restart = () => {
      if (claudeProc && processAlive) {
        console.log("[OAuth] Restarting Claude with refreshed token...");
        claudeProc.kill();
        lastSessionId = null;
        setTimeout(() => spawnClaude(), 500);
      }
    };
    if (activeListener) {
      console.log("[OAuth] Turn in progress, deferring restart...");
      let checks = 0;
      const checkDone = setInterval(() => {
        checks++;
        if (!activeListener || checks > 150) { // 5 min max wait
          clearInterval(checkDone);
          restart();
        }
      }, 2000);
    } else {
      restart();
    }
    return true;
  } catch (err) {
    console.error("[OAuth] Refresh error:", err);
    return false;
  }
}

let refreshing = false;

function startRefreshTimer(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if (refreshing) return;
    const tokens = loadOAuthTokens();
    if (!tokens) return;
    const remaining = tokens.expires_at - Date.now();
    if (remaining < 10 * 60 * 1000) { // < 10 min remaining
      refreshing = true;
      try { await refreshAccessToken(); } finally { refreshing = false; }
    }
  }, 60_000);
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

    // Health check (authenticated)
    if (url.pathname === "/api/health") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      return Response.json({
        status: "ok",
        processAlive: processAlive && claudeProc !== null,
        needsSetup: needsSetup(),
        authMethod: getAuthMethod(),
      }, { headers: corsHeaders() });
    }

    // Setup endpoint: store auth token and restart Claude (authenticated)
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
        // Kill current Claude process and restart with new creds
        if (claudeProc && processAlive) {
          console.log("[Setup] Killing current Claude process...");
          claudeProc.kill();
          // Wait a moment for process to exit
          await new Promise(r => setTimeout(r, 500));
        }
        lastSessionId = null; // Fresh session with new creds
        spawnClaude();
        return Response.json({ ok: true, pid: claudeProc?.pid ?? null }, { headers: corsHeaders() });
      } catch (err) {
        console.error("[Setup] Failed:", err);
        return Response.json({ error: "Failed to save token" }, { status: 500, headers: corsHeaders() });
      }
    }

    // OAuth start: generate PKCE challenge and return authorization URL (authenticated)
    if (url.pathname === "/api/oauth/start" && req.method === "GET") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      const verifier = generateRandomBase64url(32);
      const state = generateRandomBase64url(16);
      const challenge = await sha256Base64url(verifier);
      pendingOAuth.set(state, { verifier, createdAt: Date.now() });

      const params = new URLSearchParams({
        response_type: "code",
        client_id: ANTHROPIC_CLIENT_ID,
        redirect_uri: ANTHROPIC_REDIRECT_URI,
        scope: OAUTH_SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const authUrl = `${ANTHROPIC_AUTHORIZE_URL}?${params}`;
      return Response.json({ authUrl, state }, { headers: corsHeaders() });
    }

    // OAuth exchange: swap authorization code for tokens (authenticated)
    if (url.pathname === "/api/oauth/exchange" && req.method === "POST") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      const body = (await req.json()) as { code?: string; state?: string };
      if (!body.code || !body.state) {
        return Response.json({ error: "code and state required" }, { status: 400, headers: corsHeaders() });
      }
      const pending = pendingOAuth.get(body.state);
      if (!pending) {
        return Response.json({ error: "Invalid or expired state parameter" }, { status: 400, headers: corsHeaders() });
      }
      pendingOAuth.delete(body.state);

      // User may copy "code#state" from Anthropic's callback page — take just the code
      const code = body.code.includes("#") ? body.code.split("#")[0] : body.code;

      try {
        const tokenRes = await fetch(ANTHROPIC_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: ANTHROPIC_CLIENT_ID,
            code,
            redirect_uri: ANTHROPIC_REDIRECT_URI,
            code_verifier: pending.verifier,
          }),
        });
        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          console.error("[OAuth] Token exchange failed:", tokenRes.status, errText);
          return Response.json({ error: "Token exchange failed. Check server logs for details." }, { status: 502, headers: corsHeaders() });
        }
        const data = await tokenRes.json() as any;
        const tokens: OAuthTokens = {
          access_token: data.access_token,
          refresh_token: data.refresh_token || "",
          expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
        };
        saveOAuthTokens(tokens);
        console.log("[OAuth] Tokens saved, expires at", new Date(tokens.expires_at).toISOString());

        // Start refresh timer
        startRefreshTimer();

        // Kill and respawn Claude with new creds
        if (claudeProc && processAlive) {
          console.log("[OAuth] Killing current Claude process...");
          claudeProc.kill();
          await new Promise(r => setTimeout(r, 500));
        }
        lastSessionId = null;
        spawnClaude();
        return Response.json({ ok: true, pid: claudeProc?.pid ?? null }, { headers: corsHeaders() });
      } catch (err) {
        console.error("[OAuth] Exchange error:", err);
        return Response.json({ error: "Token exchange failed" }, { status: 500, headers: corsHeaders() });
      }
    }

    // Chat endpoint: stream-json to SSE bridge (authenticated)
    if (url.pathname === "/api/chat" && req.method === "POST") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
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

    // Artifact list endpoint (authenticated)
    if (url.pathname === "/api/artifacts" && req.method === "GET") {
      if (!(await verifyClerkToken(req))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
      }
      try {
        const entries = readdirSync(WORKING_DIR);
        const files = entries
          .filter(f => f.endsWith(".html") && f !== "index.html")
          .map(f => {
            const st = statSync(join(WORKING_DIR, f));
            return { name: f, modified: st.mtimeMs, size: st.size };
          })
          .sort((a, b) => b.modified - a.modified);
        return Response.json({ files }, { headers: corsHeaders() });
      } catch (err) {
        return Response.json({ files: [] }, { headers: corsHeaders() });
      }
    }

    // Artifact file serving (unauthenticated — iframes can't send Bearer headers)
    const artifactMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)$/);
    if (artifactMatch && req.method === "GET") {
      const filename = decodeURIComponent(artifactMatch[1]);
      // Security: only .html, no path traversal
      if (!filename.endsWith(".html") || filename.includes("..") || filename.includes("/")) {
        return new Response("Forbidden", { status: 403 });
      }
      const filePath = join(WORKING_DIR, filename);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": "text/html", ...corsHeaders() },
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    // Serve index.html (local dev fallback — nginx serves in production)
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const file = Bun.file(join(import.meta.dir, "index.html"));
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "text/html" } });
      }
    }

    // Serve static assets (local dev fallback — nginx serves in production)
    const STATIC_FILES: Record<string, string> = {
      "/fireproof-clerk-bundle.js": "application/javascript",
      "/favicon.svg": "image/svg+xml",
      "/favicon.ico": "image/x-icon",
      "/favicon-96x96.png": "image/png",
      "/apple-touch-icon.png": "image/png",
      "/site.webmanifest": "application/manifest+json",
      "/sw.js": "application/javascript",
      "/web-app-manifest-192x192.png": "image/png",
      "/web-app-manifest-512x512.png": "image/png",
    };
    const ct = STATIC_FILES[url.pathname];
    if (ct) {
      const file = Bun.file(join(import.meta.dir, url.pathname));
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": ct } });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

// ── Startup ────────────────────────────────────────────────────────────────

// If OAuth tokens exist, start refresh timer and eagerly refresh if expired
const startupTokens = loadOAuthTokens();
if (startupTokens) {
  startRefreshTimer();
  if (startupTokens.expires_at <= Date.now() && startupTokens.refresh_token) {
    console.log("[OAuth] Token expired on startup, refreshing before spawn...");
    await refreshAccessToken();
  }
}

spawnClaude();

console.log(`
  Claude Hackathon — Persistent Process Bridge
  Server:  http://localhost:${PORT}
  CWD:     ${WORKING_DIR}
  Claude:  PID ${claudeProc?.pid ?? "?"}
`);
