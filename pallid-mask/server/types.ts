export interface StichomancyResult {
  seed: number;
  bibleVerse: { index: number; reference: string; text: string };
  yellowPassage: { index: number; text: string };
}

export interface GreetingResponse {
  text: string;
  audioUrl: string;
}

export interface FortuneRequest {
  name: string;
  question: string;
  timings: number[];
}

export interface FortuneResponse {
  fortune: string;
  qrSvg: string;
  publicUrl: string;
  audioUrl: string;
}
