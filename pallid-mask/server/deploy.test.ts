import { describe, test, expect } from "bun:test";
import { join } from "path";
import { readFileSync } from "fs";

const REPO_ROOT = join(import.meta.dir, "../..");
const PALLID_ROOT = join(import.meta.dir, "..");

describe("deploy/pallid-mask.service", () => {
  const service = readFileSync(join(REPO_ROOT, "deploy/pallid-mask.service"), "utf-8");

  test("has correct structure and paths", () => {
    expect(service).toContain("[Unit]");
    expect(service).toContain("[Service]");
    expect(service).toContain("[Install]");
    expect(service).toContain("User=exedev");
    expect(service).toContain("WorkingDirectory=/opt/pallid-mask/pallid-mask");
    expect(service).toContain("EnvironmentFile=/opt/pallid-mask/pallid-mask/.env");
    expect(service).toContain("ExecStartPre=/home/exedev/.bun/bin/bun install");
    expect(service).toContain("ExecStartPre=/home/exedev/.bun/bin/bun run build");
    expect(service).toContain("ExecStart=/home/exedev/.bun/bin/bun run server/index.ts");
  });
});

describe("deploy/instances.json", () => {
  test("includes pallid-mask entry with correct fields", () => {
    const raw = readFileSync(join(REPO_ROOT, "deploy/instances.json"), "utf-8");
    const instances = JSON.parse(raw);
    expect(instances["pallid-mask"]).toBeDefined();
    expect(instances["pallid-mask"].url).toBe("https://www.sigil.computer");
    expect(instances["pallid-mask"].branch).toBe("pallid-mask");
  });
});

describe("public/manifest.json", () => {
  test("is a valid PWA manifest for fullscreen projection", () => {
    const raw = readFileSync(join(PALLID_ROOT, "public/manifest.json"), "utf-8");
    const manifest = JSON.parse(raw);
    expect(manifest.display).toBe("fullscreen");
    expect(manifest.orientation).toBe("landscape");
    expect(manifest.background_color).toBe("#000000");
    expect(manifest.start_url).toBe("/");
  });
});
