/**
 * julian-gate-probe — throwaway instrumented AS for the CIMD probe.
 * Protocol: docs/superpowers/specs/2026-08-09-cimd-probe-protocol.md
 *
 * One question: when an MCP client connects to an OAuth-protected server,
 * is the client_id it presents at /authorize an https URL (CIMD) or an id
 * minted at POST /register (DCR)?
 *
 * Every request is logged verbatim (method, path, query, headers minus
 * secrets, body) into a Durable Object so the record survives regardless
 * of whether a tail is attached. No real credentials exist anywhere here;
 * every token this worker mints is a clearly-labelled dummy.
 */

export interface Env {
  PROBE_LOG: DurableObjectNamespace;
  LOGS_KEY: string;
}

const REDACTED_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);
const BODY_CAP = 8192;

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    // Log that the header was present, never its value, for credential-shaped
    // headers. (The dummy bearer we mint is not a secret, but the rule is
    // simpler with no exceptions.)
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? `<redacted:${v.length} chars>` : v;
  });
  return out;
}

export class ProbeLogDO {
  private sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL,
         method TEXT NOT NULL,
         path TEXT NOT NULL,
         query TEXT,
         headers TEXT,
         body TEXT,
         note TEXT
       )`
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/append" && req.method === "POST") {
      const e = (await req.json()) as Record<string, string | null>;
      this.sql.exec(
        "INSERT INTO log (ts, method, path, query, headers, body, note) VALUES (?,?,?,?,?,?,?)",
        e.ts, e.method, e.path, e.query, e.headers, e.body, e.note
      );
      return new Response("ok");
    }
    if (url.pathname === "/dump") {
      const rows = this.sql.exec("SELECT * FROM log ORDER BY id ASC").toArray();
      return Response.json(rows);
    }
    return new Response("not found", { status: 404 });
  }
}

async function logRequest(env: Env, req: Request, bodyText: string | null, note: string): Promise<void> {
  const url = new URL(req.url);
  const entry = {
    ts: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: url.search || null,
    headers: JSON.stringify(headersToObject(req.headers)),
    body: bodyText ? bodyText.slice(0, BODY_CAP) : null,
    note,
  };
  console.log(`[probe] ${entry.method} ${entry.path}${entry.query ?? ""} — ${note}`);
  const stub = env.PROBE_LOG.get(env.PROBE_LOG.idFromName("log"));
  await stub.fetch("https://do/append", { method: "POST", body: JSON.stringify(entry) });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Minimal MCP (streamable HTTP) responses so a client that completes the fake
 *  flow can "connect" cleanly and reveal its post-token behavior. */
function mcpRpc(msg: any): Response {
  if (msg.method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "julian-gate-probe", version: "0.0.1" },
      },
    });
  }
  if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  if (msg.method === "tools/list") {
    return json({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
  }
  if (msg.id !== undefined) {
    return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found (probe)" } });
  }
  return new Response(null, { status: 202 });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = url.origin;

    // Read the body once, up front, for both logging and handling.
    let bodyText: string | null = null;
    if (req.method === "POST" || req.method === "PUT") {
      bodyText = await req.text();
    }

    // ---- log reader (not part of the probe surface; not logged) ----
    if (path === "/logs") {
      if (url.searchParams.get("k") !== env.LOGS_KEY) return new Response("no", { status: 403 });
      const stub = env.PROBE_LOG.get(env.PROBE_LOG.idFromName("log"));
      return stub.fetch("https://do/dump");
    }

    // ---- 1. protected MCP endpoint ----
    if (path === "/mcp") {
      const auth = req.headers.get("authorization") ?? "";
      const hasDummy = auth.toLowerCase().startsWith("bearer ") && auth.includes("probe-dummy");
      await logRequest(env, req, bodyText, hasDummy ? "mcp request WITH dummy bearer (post-token behavior)" : "mcp request without/with-foreign token -> 401 challenge");
      if (!hasDummy) {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      if (req.method === "POST" && bodyText) {
        try {
          return mcpRpc(JSON.parse(bodyText));
        } catch {
          return json({ error: "bad json" }, 400);
        }
      }
      // GET /mcp with token: no SSE stream offered.
      return new Response("method not allowed", { status: 405 });
    }

    // ---- 2. protected resource metadata (log WHICH path the client asks for: M1) ----
    if (path === "/.well-known/oauth-protected-resource/mcp" || path === "/.well-known/oauth-protected-resource") {
      await logRequest(env, req, bodyText, `PRM fetch via ${path === "/.well-known/oauth-protected-resource" ? "BARE path" : "path-suffixed path"}`);
      return json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
      });
    }

    // ---- 3. AS metadata: registration_endpoint DELIBERATELY present so a
    //         DCR-preferring client shows itself ----
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp" || path === "/.well-known/openid-configuration") {
      await logRequest(env, req, bodyText, `AS metadata fetch via ${path}`);
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["reading-room"],
      });
    }

    // ---- 4. DCR endpoint: log and return synthetic success ----
    if (path === "/register" && req.method === "POST") {
      await logRequest(env, req, bodyText, "DCR REGISTRATION — client chose /register");
      let reqMeta: any = {};
      try { reqMeta = bodyText ? JSON.parse(bodyText) : {}; } catch { /* log already has raw */ }
      return json({
        client_id: `probe-dcr-${crypto.randomUUID()}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        redirect_uris: reqMeta.redirect_uris ?? [],
        client_name: reqMeta.client_name ?? "unknown",
      }, 201);
    }

    // ---- 5. authorize: THE MONEY LOG LINE ----
    if (path === "/authorize") {
      const clientId = url.searchParams.get("client_id") ?? "<absent>";
      const isCimd = clientId.startsWith("https://");
      const isOurDcr = clientId.startsWith("probe-dcr-");
      const verdict = isCimd ? "CIMD (client_id is an https URL)" : isOurDcr ? "DCR (client_id minted at /register)" : "OTHER (pre-registered/unknown shape)";
      await logRequest(env, req, bodyText, `AUTHORIZE — ${verdict}`);
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      let continueUrl: string | null = null;
      if (redirectUri) {
        try {
          const cb = new URL(redirectUri);
          cb.searchParams.set("code", "probe-fake-code");
          if (state) cb.searchParams.set("state", state);
          continueUrl = cb.toString();
        } catch { /* unparseable redirect_uri; page just shows the facts */ }
      }
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>julian-gate-probe</title>
         <body style="font-family:monospace;background:#111;color:#ffd75f;padding:2rem">
         <h1>julian-gate-probe</h1>
         <p>Measurement instrument, not a real authorization server. Nothing you approve here grants anything.</p>
         <p>client_id shape observed: <b>${verdict}</b></p>
         ${continueUrl ? `<p><a style="color:#ffd75f" href="${continueUrl.replace(/"/g, "&quot;")}">Continue the flow with a fake code</a> (so the probe can observe token-exchange behavior)</p>` : "<p>No redirect_uri supplied.</p>"}
         </body>`,
        { headers: { "content-type": "text/html" } }
      );
    }

    // ---- 6. token: log grant shape, return dummies ----
    if (path === "/token" && req.method === "POST") {
      await logRequest(env, req, bodyText, "TOKEN exchange — observe grant_type/verifier/auth style");
      return json({
        access_token: `probe-dummy-token-${crypto.randomUUID()}`,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: `probe-dummy-refresh-${crypto.randomUUID()}`,
        scope: "reading-room",
      });
    }

    // ---- everything else: logged 404 so no client behavior goes unseen ----
    await logRequest(env, req, bodyText, "unmatched path");
    return new Response("not found (julian-gate-probe)", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
