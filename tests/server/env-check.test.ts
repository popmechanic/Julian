// tests/server/env-check.test.ts — deploy/env-check.sh prints values, not "checked" (#55).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../deploy/env-check.sh");
const envFile = (body: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "julian-env-")), ".env");
  writeFileSync(p, body);
  return p;
};
async function run(path: string) {
  const proc = Bun.spawn(["bash", SCRIPT, path], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

const GOOD = [
  "VITE_OIDC_ISSUER=https://souls.exe.xyz",
  "VITE_OIDC_CLIENT_ID=abc-123",
  "VITE_SYNC_URL=https://sync.julian.soul.store",
  "VITE_GATE_URL=https://gate.julian.soul.store",
  "BROKER_URL=https://gate.julian.soul.store",
  "ALLOWED_ORIGIN=https://julian-new.exe.xyz",
].join("\n") + "\n";

describe("deploy/env-check.sh", () => {
  test("a correct .env prints every known-host value with OK and exits 0", async () => {
    const r = await run(envFile(GOOD));
    expect(r.code).toBe(0);
    expect(r.out).toContain("VITE_SYNC_URL=https://sync.julian.soul.store OK");
    expect(r.out).toContain("VITE_GATE_URL=https://gate.julian.soul.store OK");
    expect(r.out).toContain("BROKER_URL=https://gate.julian.soul.store OK");
    expect(r.out).toContain("VITE_OIDC_ISSUER=https://souls.exe.xyz OK");
    expect(r.out).toContain("VITE_OIDC_CLIENT_ID=abc-123 present");
    expect(r.out).not.toContain("checked"); // the old presence-only verdict is gone
  });
  test("an old-house URL prints WRONG with the expected host and exits 1 (the R10 case)", async () => {
    const r = await run(envFile(GOOD.replace("VITE_SYNC_URL=https://sync.julian.soul.store", "VITE_SYNC_URL=https://julian-sync.julian-memory.workers.dev")));
    expect(r.code).toBe(1);
    expect(r.out).toContain("VITE_SYNC_URL=https://julian-sync.julian-memory.workers.dev WRONG (expected host sync.julian.soul.store)");
  });
  test("a missing variable prints MISSING and exits 1", async () => {
    const r = await run(envFile(GOOD.replace(/^VITE_GATE_URL=.*\n/m, "")));
    expect(r.code).toBe(1);
    expect(r.out).toContain("VITE_GATE_URL MISSING");
  });
  test("wss:// on the sync URL is accepted — the Mac's .env uses it", async () => {
    const r = await run(envFile(GOOD.replace("VITE_SYNC_URL=https://sync.julian.soul.store", "VITE_SYNC_URL=wss://sync.julian.soul.store")));
    expect(r.code).toBe(0);
    expect(r.out).toContain("VITE_SYNC_URL=wss://sync.julian.soul.store OK");
  });
  test("a duplicated key is reported — the last one wins in a build, so say so", async () => {
    const r = await run(envFile(GOOD + "VITE_GATE_URL=https://julian-broker.julian-memory.workers.dev\n"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("VITE_GATE_URL DUPLICATE (2 lines; the last wins)");
  });
  test("secrets are never printed: only the known-host and id keys appear in the output", async () => {
    const r = await run(envFile(GOOD + "AGENTMAIL_API_KEY=sk-live-SECRET\n"));
    expect(r.out).not.toContain("SECRET");
  });
  test("a missing file is loud and exits 2", async () => {
    const r = await run("/nonexistent/.env");
    expect(r.code).toBe(2);
    expect(r.err + r.out).toMatch(/no such file|not found|cannot read/i);
  });
});
