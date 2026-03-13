import { describe, test, expect } from "bun:test";
import { computeSeed, selectPassages } from "./stichomancy";

describe("computeSeed", () => {
  test("sums inter-key timing intervals", () => {
    expect(computeSeed([100, 200, 150])).toBe(450);
  });

  test("returns 0 for empty array", () => {
    expect(computeSeed([])).toBe(0);
  });

  test("handles single timing", () => {
    expect(computeSeed([42])).toBe(42);
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

  test("selects King in Yellow passage by seed % count", () => {
    const result = selectPassages(3, mockYellow, mockBible);
    expect(result.yellowPassage.index).toBe(1); // 3 % 2 = 1
    expect(result.yellowPassage.text).toBe("The shadows lengthen");
  });

  test("selects Bible verse by floor(seed / yellowCount) % bibleCount", () => {
    const result = selectPassages(3, mockYellow, mockBible);
    expect(result.bibleVerse.index).toBe(1); // floor(3/2) % 2 = 1
    expect(result.bibleVerse.text).toBe("And the earth was");
  });

  test("includes the seed in the result", () => {
    const result = selectPassages(42, mockYellow, mockBible);
    expect(result.seed).toBe(42);
  });

  test("wraps around correctly with large seed", () => {
    const result = selectPassages(5000, mockYellow, mockBible);
    expect(result.yellowPassage.index).toBe(0); // 5000 % 2 = 0
    expect(result.bibleVerse.index).toBe(0); // floor(5000/2) % 2 = 0
  });
});
