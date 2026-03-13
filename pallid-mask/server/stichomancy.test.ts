import { describe, test, expect } from "bun:test";
import { computeSeed, selectPassages } from "./stichomancy";

describe("computeSeed", () => {
  test("produces a 32-bit unsigned integer", () => {
    const seed = computeSeed([100, 200, 150]);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xFFFFFFFF);
  });

  test("returns a consistent value for the same input", () => {
    const a = computeSeed([100, 200, 150]);
    const b = computeSeed([100, 200, 150]);
    expect(a).toBe(b);
  });

  test("produces different values for different inputs", () => {
    const a = computeSeed([100, 200, 150]);
    const b = computeSeed([100, 201, 150]);
    expect(a).not.toBe(b);
  });

  test("handles empty array", () => {
    const seed = computeSeed([]);
    expect(seed).toBeGreaterThanOrEqual(0);
  });

  test("distributes across full Bible range for realistic inputs", () => {
    // Simulate 500 different typing sessions
    const bibleIndices = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const timings: number[] = [];
      const len = 5 + (i % 20);
      for (let j = 0; j < len; j++) {
        timings.push(80 + ((i * 7 + j * 13) % 250));
      }
      const seed = computeSeed(timings);
      bibleIndices.add(Math.floor(seed / 1662) % 31102);
    }
    // Should cover far more than the old 4 passages
    expect(bibleIndices.size).toBeGreaterThan(400);
  });
});

describe("selectPassages", () => {
  const mockBible = [
    { reference: "Gen 1:1", text: "In the beginning" },
    { reference: "Gen 1:2", text: "And the earth was" },
  ];
  const mockYellow = [
    { text: "Along the shore" },
    { text: "The shadows lengthen" },
  ];

  test("selects passages within bounds", () => {
    const result = selectPassages(123456, mockYellow, mockBible);
    expect(result.yellowPassage.index).toBeGreaterThanOrEqual(0);
    expect(result.yellowPassage.index).toBeLessThan(mockYellow.length);
    expect(result.bibleVerse.index).toBeGreaterThanOrEqual(0);
    expect(result.bibleVerse.index).toBeLessThan(mockBible.length);
  });

  test("includes the seed in the result", () => {
    const result = selectPassages(42, mockYellow, mockBible);
    expect(result.seed).toBe(42);
  });

  test("wraps around correctly with large seed", () => {
    const result = selectPassages(0xFFFFFFFF, mockYellow, mockBible);
    expect(result.yellowPassage.index).toBeGreaterThanOrEqual(0);
    expect(result.yellowPassage.index).toBeLessThan(mockYellow.length);
  });
});
