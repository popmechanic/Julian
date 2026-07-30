import { test, expect } from "bun:test";
import { resolve } from "path";

const SCRIPT = resolve(import.meta.dir, "../../deploy/pocketid-register-callback.ts");

type MockOpts = { existing?: string[]; persistWrites?: boolean };

function mockPocketId(opts: MockOpts = {}) {
  const state = {
    callbackURLs: opts.existing ?? ["https://julian-new.exe.xyz/auth/callback"],
    puts: [] as any[],
    gets: 0,
    apiKeysSeen: [] as (string | null)[],
  };
  const server = Bun.serve({
    port: 0, // unique free port per test — concurrency-safe
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/oidc/clients/julian-client")) {
        return new Response("not found", { status: 404 });
      }
      state.apiKeysSeen.push(req.headers.get("x-api-key"));
      if (req.method === "GET") {
        state.gets++;
        return Response.json({ id: "julian-client", name: "Julian", callbackURLs: state.callbackURLs });
      }
      if (req.method === "PUT") {
        const body = await req.json();
        state.puts.push(body);
        if (opts.persistWrites !== false) state.callbackURLs = body.callbackURLs;
        return Response.json({ id: "julian-client", name: "Julian", callbackURLs: state.callbackURLs });
      }
      return new Response("bad method", { status: 405 });
    },
  });
  return { server, state, issuer: `http://localhost:${server.port}` };
}

async function runScript(issuer: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn(["bun", SCRIPT, "julian-skilltest"], {
    env: {
      ...process.env,
      POCKETID_ISSUER: issuer,
      POCKETID_CLIENT_ID: "julian-client",
      POCKETID_API_KEY: "test-key",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

test("registers a missing callback and verifies by re-read", async () => {
  const { server, state, issuer } = mockPocketId();
  const r = await runScript(issuer, {});
  server.stop();
  expect(r.exitCode).toBe(0);
  expect(state.puts.length).toBe(1);
  // preserves existing callbacks and appends the new one
  expect(state.puts[0].callbackURLs).toEqual([
    "https://julian-new.exe.xyz/auth/callback",
    "https://julian-skilltest.exe.xyz/auth/callback",
  ]);
  // GET before the write plus GET after the write = verify-by-re-read
  expect(state.gets).toBe(2);
  expect(state.apiKeysSeen.every((k) => k === "test-key")).toBe(true);
});

test("idempotent: already-registered callback exits 0 without writing", async () => {
  const { server, state, issuer } = mockPocketId({
    existing: ["https://julian-skilltest.exe.xyz/auth/callback"],
  });
  const r = await runScript(issuer, {});
  server.stop();
  expect(r.exitCode).toBe(0);
  expect(state.puts.length).toBe(0);
  // one read, no write, no second read
  expect(state.gets).toBe(1);
});

test("no API key: exits 3 with manual instructions", async () => {
  const { server, issuer } = mockPocketId();
  // Bun auto-loads the repo-root .env into spawned `bun` processes for any
  // variable absent from the real environment. An empty real env var beats
  // .env (the script's `|| ""` treats empty as absent), so this reliably
  // exercises the no-key path even if the operator's local .env has
  // POCKETID_API_KEY set.
  const r = await runScript(issuer, { POCKETID_API_KEY: "" });
  server.stop();
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain("https://julian-skilltest.exe.xyz/auth/callback");
  expect(r.stderr).toContain("OIDC Clients");
});

test("silent-save failure: PUT returns 200 but does not persist -> exit 1", async () => {
  const { server, issuer } = mockPocketId({ persistWrites: false });
  const r = await runScript(issuer, {});
  server.stop();
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("did not stick");
});

test("HTTP error on GET: wrong client id -> exit 1", async () => {
  const { server, issuer } = mockPocketId();
  const r = await runScript(issuer, { POCKETID_CLIENT_ID: "wrong-client" });
  server.stop();
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("GET client failed");
});
