import type { StichomancyResult } from "./types";

export function computeSeed(timings: number[]): number {
  return timings.reduce((sum, t) => sum + t, 0);
}

export interface BibleEntry {
  reference: string;
  text: string;
}

export interface YellowEntry {
  text: string;
}

export function selectPassages(
  seed: number,
  yellow: YellowEntry[],
  bible: BibleEntry[]
): StichomancyResult {
  const yellowIndex = seed % yellow.length;
  const bibleIndex = Math.floor(seed / yellow.length) % bible.length;

  return {
    seed,
    yellowPassage: { index: yellowIndex, text: yellow[yellowIndex].text },
    bibleVerse: {
      index: bibleIndex,
      reference: bible[bibleIndex].reference,
      text: bible[bibleIndex].text,
    },
  };
}

export function loadBible(raw: string): BibleEntry[] {
  return raw
    .trim()
    .split("\n")
    .map((line) => {
      const parts = line.split("\t");
      return { reference: parts[1], text: parts[2] };
    });
}

export function loadYellow(raw: string): YellowEntry[] {
  return raw
    .trim()
    .split("\n")
    .map((line) => {
      const parts = line.split("\t");
      return { text: parts[1] };
    });
}
