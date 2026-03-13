import { describe, test, expect } from "bun:test";
import { parseFortune } from "./fortune";

describe("parseFortune", () => {
  test("extracts fortune text and summary word from delimited response", () => {
    const raw = "You will find what you seek in the corridors of memory.\n---\ncorridors";
    const result = parseFortune(raw);
    expect(result.fortune).toBe("You will find what you seek in the corridors of memory.");
    expect(result.summaryWord).toBe("corridors");
  });

  test("returns empty summaryWord when no delimiter present", () => {
    const raw = "You will find what you seek.";
    const result = parseFortune(raw);
    expect(result.fortune).toBe("You will find what you seek.");
    expect(result.summaryWord).toBe("");
  });

  test("returns empty summaryWord when word after delimiter is invalid", () => {
    const raw = "Your fortune awaits.\n---\ntwo words here";
    const result = parseFortune(raw);
    expect(result.fortune).toBe("Your fortune awaits.");
    expect(result.summaryWord).toBe("");
  });

  test("preserves multi-paragraph fortune text", () => {
    const raw = "First paragraph.\n\nSecond paragraph.\n---\nbecoming";
    const result = parseFortune(raw);
    expect(result.fortune).toBe("First paragraph.\n\nSecond paragraph.");
    expect(result.summaryWord).toBe("becoming");
  });

  test("uses last delimiter when fortune text contains ---", () => {
    const raw = "A line with --- in it.\n\nMore text.\n---\nthreshold";
    const result = parseFortune(raw);
    expect(result.fortune).toBe("A line with --- in it.\n\nMore text.");
    expect(result.summaryWord).toBe("threshold");
  });
});
