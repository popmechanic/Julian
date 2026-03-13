export type CeremonyState =
  | "WELCOME"
  | "SUMMON"
  | "NAME"
  | "INPUT"
  | "DIVINE"
  | "FORTUNE"
  | "QR_DISPLAY";

export interface GreetingResponse {
  text: string;
  audioUrl: string;
}

export interface FortuneResponse {
  fortune: string;
  qrSvg: string;
  publicUrl: string;
  audioUrl: string;
}

export interface InputResult {
  question: string;
  timings: number[];
}
