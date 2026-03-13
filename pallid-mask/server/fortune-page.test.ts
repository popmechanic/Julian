import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { generateFortunePage } from "./fortune-page";

const TEST_FORTUNES_DIR = join(import.meta.dir, "..", "fortunes");

beforeEach(() => {
  if (existsSync(TEST_FORTUNES_DIR)) {
    rmSync(TEST_FORTUNES_DIR, { recursive: true });
  }
  mkdirSync(TEST_FORTUNES_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_FORTUNES_DIR)) {
    rmSync(TEST_FORTUNES_DIR, { recursive: true });
  }
});

describe("generateFortunePage", () => {
  const baseOpts = {
    fortune: "You will wander through many corridors.",
    sigilSvg: '<svg><path d="M0 0"/></svg>',
    publicBaseUrl: "https://pallid-mask.exe.xyz",
    name: "Marcus",
    summaryWord: "wandering",
  };

  test("generates file with name-word filename", async () => {
    const result = await generateFortunePage(baseOpts);
    expect(result.publicUrl).toBe("https://pallid-mask.exe.xyz/fortunes/marcus-wandering.html");
    expect(result.id).toBe("marcus-wandering");
    expect(existsSync(result.filePath)).toBe(true);
  });

  test("normalizes diacritics to ASCII equivalents", async () => {
    const result = await generateFortunePage({
      ...baseOpts,
      name: "Mar\u00eda Jos\u00e9",
    });
    expect(result.id).toBe("mariajose-wandering");
  });

  test("strips special characters from name", async () => {
    const result = await generateFortunePage({
      ...baseOpts,
      name: "O'Brien-Smith!",
    });
    expect(result.id).toBe("obrien-smith-wandering");
  });

  test("falls back to 'visitor' for empty/unparseable name", async () => {
    const result = await generateFortunePage({
      ...baseOpts,
      name: "!!!",
    });
    expect(result.id).toStartWith("visitor-");
  });

  test("falls back to hex slug for invalid summaryWord", async () => {
    const result = await generateFortunePage({
      ...baseOpts,
      summaryWord: "two words",
    });
    // Should be marcus-{6-char-hex}
    expect(result.id).toMatch(/^marcus-[a-f0-9]{6}$/);
  });

  test("handles collision with numeric suffix", async () => {
    const first = await generateFortunePage(baseOpts);
    const second = await generateFortunePage(baseOpts);
    expect(first.id).toBe("marcus-wandering");
    expect(second.id).toBe("marcus-wandering-2");
  });

  test("escapes HTML entities in fortune text", async () => {
    const result = await generateFortunePage({
      ...baseOpts,
      fortune: 'You will find <truth> & "peace"',
    });
    const html = readFileSync(result.filePath, "utf-8");
    expect(html).toContain("&lt;truth&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;peace&quot;");
  });

  test("inlines font and styles into output HTML", async () => {
    const result = await generateFortunePage(baseOpts);
    const html = readFileSync(result.filePath, "utf-8");
    expect(html).toContain("@font-face");
    expect(html).toContain("font-family: 'Orpheus'");
    expect(html).toContain("data:font/opentype;base64,");
  });

  test("truncates long names to 30 characters", async () => {
    const result = await generateFortunePage({
      ...baseOpts,
      name: "a".repeat(50),
    });
    const namePart = result.id.split("-")[0];
    expect(namePart.length).toBeLessThanOrEqual(30);
  });
});
