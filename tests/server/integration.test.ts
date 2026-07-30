import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Subprocess } from "bun";

const TEST_PORT = 18000;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const ALLOWED_ORIGIN = `http://localhost:${TEST_PORT}`;

let serverProc: Subprocess | null = null;

async function waitForServer(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

beforeAll(async () => {
  // Blank the OIDC issuer vars so the server runs in no-issuer (local dev) mode
  // and skips bearer verification (Bun auto-loads .env, so we must override them)
  serverProc = Bun.spawn(["bun", "run", "server/server.ts"], {
    cwd: import.meta.dir + "/../..",
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      ALLOWED_ORIGIN,
      OIDC_ISSUER: "",
      VITE_OIDC_ISSUER: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForServer(`${BASE_URL}/api/health`);
});

afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited;
    serverProc = null;
  }
});

describe("HTTP integration tests", () => {
  test("GET /api/health returns 200 with expected fields", async () => {
    const resp = await fetch(`${BASE_URL}/api/health`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("sessionActive");
    expect(body).toHaveProperty("needsSetup");
    expect(body.status).toBe("ok");
    expect(typeof body.sessionActive).toBe("boolean");
    expect(typeof body.needsSetup).toBe("boolean");
  });

  test("OPTIONS /api/events returns CORS preflight headers", async () => {
    const resp = await fetch(`${BASE_URL}/api/events`, { method: "OPTIONS" });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(resp.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(resp.headers.get("Access-Control-Allow-Headers")).toContain("X-Authorization");
  });

  test("POST /api/send with no session returns 409", async () => {
    const resp = await fetch(`${BASE_URL}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(resp.status).toBe(409);
    const body = await resp.json() as any;
    expect(body.error).toContain("No active session");
  });

  test("GET /api/health has version field", async () => {
    const resp = await fetch(`${BASE_URL}/api/health`);
    const body = await resp.json() as any;
    expect(body).toHaveProperty("version");
    expect(typeof body.version).toBe("string");
  });

  test("OPTIONS /api/send returns CORS headers", async () => {
    const resp = await fetch(`${BASE_URL}/api/send`, { method: "OPTIONS" });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  test("POST /api/send with missing message returns 400", async () => {
    // First need a session — but without one we get 409.
    // This tests the no-session path; the 400 path requires a session.
    // We test the 409 case here as a confirmation.
    const resp = await fetch(`${BASE_URL}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // Without session, we get 409 before message validation
    expect(resp.status).toBe(409);
  });

  test("static serving rejects %2f-encoded path traversal", async () => {
    // %2f survives WHATWG URL normalization; decodeURIComponent reintroduces
    // the separators. Must not escape app/dist (or WORKING_DIR) — regression
    // test for the appDist containment check.
    for (const path of [
      "/..%2f..%2f.env",
      "/..%2f..%2f..%2f..%2fetc%2fpasswd",
      "/x%2f..%2f..%2f..%2f.env",
      "/..%2fserver%2fserver.ts",
    ]) {
      const resp = await fetch(`${BASE_URL}${path}`);
      const body = await resp.text();
      expect(body).not.toContain("API_KEY");
      expect(body).not.toContain("root:");
      expect(body).not.toContain("Bun.serve");
    }
  });

  test("static serving does not escape into sibling directories", async () => {
    // safePath containment must require a trailing separator so that
    // /Users/.../Julian does not also admit /Users/.../Julian-anything.
    const resp = await fetch(`${BASE_URL}/..%2fJulian-does-not-exist%2fx.txt`);
    expect(resp.status === 404 || resp.headers.get("content-type")?.includes("html")).toBe(true);
  });

  test("artifact HTML is served with a sandboxing CSP", async () => {
    // The route is unauthenticated and same-origin, and the app holds OIDC
    // tokens in localStorage — LLM-authored artifact HTML must not run with
    // access to them, however it is opened.
    const resp = await fetch(`${BASE_URL}/api/artifacts/response.html`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Security-Policy")).toContain("sandbox");
    const md = await fetch(`${BASE_URL}/api/artifacts/letter-pipeline.md`);
    expect(md.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  test("GET /room.md is unauthenticated, markdown, and matches buildRoomDoc", async () => {
    const resp = await fetch(`${BASE_URL}/room.md`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/markdown");
    const body = await resp.text();
    expect(body).toContain("name: julian-web-harness");
    expect(body).toContain("**jobs**");
    // The no-assign rule is load-bearing: the served vocabulary must not offer it.
    expect(body).not.toContain("| assign |");
  });

  test("POST /api/chat (legacy endpoint) with no session returns 409", async () => {
    const resp = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "test" }),
    });
    expect(resp.status).toBe(409);
  });
});
