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
      const tab = line.indexOf("\t");
      if (tab === -1) return { reference: "", text: line };
      const field = line.slice(tab + 1);
      // Format: "01:001:001 In the beginning..." — split reference from text at first space
      const space = field.indexOf(" ");
      if (space === -1) return { reference: field, text: field };
      return { reference: field.slice(0, space), text: field.slice(space + 1) };
    });
}

export function loadYellow(raw: string): YellowEntry[] {
  return raw
    .trim()
    .split("\n")
    .map((line) => {
      const tab = line.indexOf("\t");
      if (tab === -1) return { text: line };
      return { text: line.slice(tab + 1) };
    });
}
