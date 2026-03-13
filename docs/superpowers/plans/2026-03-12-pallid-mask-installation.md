# Pallid Mask Installation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete Pallid Mask fortune-telling installation — server, client, and ceremony flow — as a standalone Bun application.

**Architecture:** Standalone Bun server with client/server split. Client is a TypeScript state machine (ceremony.ts) orchestrating visual modules extracted from the existing mockup.html prototype. Server handles stichomancy, Claude API fortune generation, ElevenLabs TTS, QR codes, and self-contained fortune pages. All client modules are bundled by Bun into public/dist/.

**Tech Stack:** Bun (server + bundler), TypeScript, @anthropic-ai/sdk (Claude API), @elevenlabs/elevenlabs-js (TTS), qrcode (QR generation)

**Spec:** `docs/superpowers/specs/2026-03-12-pallid-mask-installation-design.md`

**Existing prototype:** `pallid-mask/mockup.html` (308KB monolithic file with all CSS, HTML, JS inlined)

---

## Chunk 1: Project Scaffolding + Data Layer

### Task 1: Project Scaffolding

**Files:**
- Create: `pallid-mask/package.json`
- Create: `pallid-mask/tsconfig.json`
- Create: `pallid-mask/server/types.ts`
- Create: `pallid-mask/client/types.ts`
- Modify: `pallid-mask/.gitignore` (create if missing)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "pallid-mask",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "bun run server/index.ts",
    "build": "bun build client/main.ts --outdir public/dist --target browser",
    "test": "bun test"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "@elevenlabs/elevenlabs-js": "latest",
    "qrcode": "^1.5.4"
  },
  "devDependencies": {
    "@types/qrcode": "^1.5.5",
    "bun-types": "latest"
  }
}
```

Write to `pallid-mask/package.json`.

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./public/dist",
    "rootDir": ".",
    "types": ["bun-types"],
    "lib": ["ESNext", "DOM", "DOM.Iterable"]
  },
  "include": ["client/**/*.ts", "server/**/*.ts"],
  "exclude": ["node_modules", "public/dist"]
}
```

Write to `pallid-mask/tsconfig.json`.

- [ ] **Step 3: Create shared types**

Write `pallid-mask/server/types.ts`:

```typescript
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
  question: string;
  timings: number[];
}

export interface FortuneResponse {
  fortune: string;
  qrSvg: string;
  publicUrl: string;
  audioUrl: string;
}
```

Write `pallid-mask/client/types.ts`:

```typescript
export type CeremonyState =
  | "WELCOME"
  | "SUMMON"
  | "INPUT"
  | "DIVINE"
  | "FORTUNE"
  | "REVEAL"
  | "QR_OFFER"
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
```

- [ ] **Step 4: Create .gitignore**

Write `pallid-mask/.gitignore`:

```
node_modules/
public/dist/
public/audio/
fortunes/
```

- [ ] **Step 5: Install dependencies**

Run: `cd pallid-mask && bun install`
Expected: Packages install successfully, `bun.lockb` created.

- [ ] **Step 6: Create directory structure**

Run:
```bash
cd pallid-mask && mkdir -p client server public/dist public/audio data templates fortunes
```

- [ ] **Step 7: Commit**

```bash
git add pallid-mask/package.json pallid-mask/tsconfig.json pallid-mask/server/types.ts pallid-mask/client/types.ts pallid-mask/.gitignore pallid-mask/bun.lockb
git commit -m "Scaffold Pallid Mask project: package.json, tsconfig, types, directory structure"
```

---

### Task 2: Extract and Move Data Files

**Files:**
- Create: `pallid-mask/data/sigils.json` (converted from `pallid-mask/sigils-all.js`)
- Move: `pallid-mask/king-james-bible.txt` → `pallid-mask/data/king-james-bible.txt`
- Move: `pallid-mask/king-in-yellow.txt` → `pallid-mask/data/king-in-yellow.txt`

- [ ] **Step 1: Convert sigils-all.js to sigils.json**

Read `pallid-mask/sigils-all.js`. It contains a JS array assignment like `const ALL_SIGILS = [...]`. Extract the array and write it as pure JSON to `pallid-mask/data/sigils.json`. The format is:

```json
[
  { "vb": "0 0 592.94 139.34", "d": "M81.94,56.47v5.91c0,3.43..." },
  ...
]
```

Use a Bun script to do the conversion:

```bash
cd pallid-mask && bun -e "
const src = await Bun.file('sigils-all.js').text();
const match = src.match(/\[[\s\S]*\]/);
if (!match) throw new Error('No array found');
const arr = JSON.parse(match[0].replace(/'/g, '\"'));
await Bun.write('data/sigils.json', JSON.stringify(arr));
console.log('Wrote', arr.length, 'sigils');
"
```

Expected: `Wrote 200 sigils`

- [ ] **Step 2: Verify sigils.json**

```bash
cd pallid-mask && bun -e "const s = JSON.parse(await Bun.file('data/sigils.json').text()); console.log(s.length, 'sigils, first vb:', s[0].vb)"
```

Expected: `200 sigils, first vb: 0 0 592.94 139.34` (or whatever the actual first viewBox is)

- [ ] **Step 3: Move text databases**

```bash
cd pallid-mask && mv king-james-bible.txt data/ && mv king-in-yellow.txt data/
```

- [ ] **Step 4: Verify text databases**

```bash
cd pallid-mask && wc -l data/king-james-bible.txt data/king-in-yellow.txt
```

Expected: ~31102 lines for Bible, ~1662 lines for King in Yellow.

- [ ] **Step 5: Commit**

```bash
git add pallid-mask/data/
git commit -m "Extract data files: sigils.json from JS, move text databases to data/"
```

---

### Task 3: Stichomancy Module (TDD)

**Files:**
- Create: `pallid-mask/server/stichomancy.ts`
- Create: `pallid-mask/server/stichomancy.test.ts`

- [ ] **Step 1: Write the failing test**

Write `pallid-mask/server/stichomancy.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pallid-mask && bun test server/stichomancy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Write `pallid-mask/server/stichomancy.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pallid-mask && bun test server/stichomancy.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add pallid-mask/server/stichomancy.ts pallid-mask/server/stichomancy.test.ts
git commit -m "Add stichomancy module with seed computation and passage selection"
```

---

## Chunk 2: Server Modules

### Task 4: Fortune Module (Claude API)

**Files:**
- Create: `pallid-mask/server/fortune.ts`

- [ ] **Step 1: Write the fortune module**

Write `pallid-mask/server/fortune.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { StichomancyResult } from "./types";

const client = new Anthropic();

const INTERPRETATION_RULES = `
When interpreting the two passages drawn for the visitor:

1. If any recognizable biblical references appear (names like Moses, Abraham, Jerusalem, specific parables, etc.), find rough approximations that abstract them away from their source. References to God are acceptable.
2. If any recognizable references to The King in Yellow appear (Carcosa, Hastur, the Yellow Sign, Camilla, Cassilda, the Pallid Mask itself, etc.), abstract them similarly.
3. Shift all pronouns to a "you" orientation in active or future tense, depending on context.
4. If a natural seam exists to join the two passages together, do so lightly without altering the text too much. Some disjunction is acceptable — do not force coherence.

Keep your interpretation concise — a few sentences. Do not explain what you are doing. Simply present the fortune as if speaking it.
`;

export async function generateFortune(
  soulPrompt: string,
  passages: StichomancyResult,
  question: string
): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: soulPrompt + "\n\n" + INTERPRETATION_RULES,
    messages: [
      {
        role: "user",
        content: `The visitor has asked: "${question}"

Two passages have been drawn by stichomancy:

From the first text:
"${passages.bibleVerse.text}"

From the second text:
"${passages.yellowPassage.text}"

Interpret these passages as a fortune for the visitor. Speak as the Pallid Mask.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}

export async function generateGreeting(soulPrompt: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 512,
    thinking: { type: "adaptive" },
    system: soulPrompt,
    messages: [
      {
        role: "user",
        content:
          "A visitor has just entered the room and pressed a key to begin. Greet them as the Pallid Mask. Frame the ritual — tell them they will be asked to formulate a question about their past, present, or future. Keep it to 2-4 sentences. Speak slowly, with weight. Do not use contractions.",
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}
```

- [ ] **Step 2: Commit**

```bash
git add pallid-mask/server/fortune.ts
git commit -m "Add fortune module: Claude API integration for greeting and fortune interpretation"
```

---

### Task 5: Voice Module (ElevenLabs TTS)

**Files:**
- Create: `pallid-mask/server/voice.ts`

- [ ] **Step 1: Write the voice module**

Write `pallid-mask/server/voice.ts`:

```typescript
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { randomUUID } from "crypto";
import { join } from "path";

const VOICE_ID = "50I72bKDereNurpy2q0d";
const MODEL_ID = "eleven_multilingual_v2";

const client = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

const AUDIO_DIR = join(import.meta.dir, "..", "public", "audio");

export async function textToSpeech(text: string): Promise<string> {
  const audio = await client.textToSpeech.convert(VOICE_ID, {
    text,
    modelId: MODEL_ID,
  });

  const id = randomUUID().slice(0, 8);
  const filename = `${id}.mp3`;
  const filepath = join(AUDIO_DIR, filename);

  // Collect stream chunks into buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of audio) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  await Bun.write(filepath, buffer);
  return `/audio/${filename}`;
}

export async function cleanupAudio(): Promise<void> {
  const { readdir, unlink } = await import("fs/promises");
  try {
    const files = await readdir(AUDIO_DIR);
    for (const file of files) {
      if (file.endsWith(".mp3")) {
        await unlink(join(AUDIO_DIR, file));
      }
    }
  } catch {
    // Directory may not exist yet — that's fine
  }
}
```

- [ ] **Step 2: Ensure audio directory exists at startup**

This will be handled in `server/index.ts` (Task 8). The server creates `public/audio/` on startup if it doesn't exist.

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/server/voice.ts
git commit -m "Add voice module: ElevenLabs TTS wrapper with audio file management"
```

---

### Task 6: QR Code Module

**Files:**
- Create: `pallid-mask/server/qr.ts`

- [ ] **Step 1: Write the QR module**

Write `pallid-mask/server/qr.ts`:

```typescript
import QRCode from "qrcode";

export async function generateQRSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: "svg",
    margin: 2,
    color: {
      dark: "#c4a0d4", // approximate oklch(77% 0.076 332) in hex
      light: "#00000000", // transparent background
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add pallid-mask/server/qr.ts
git commit -m "Add QR code module: SVG generation with Pallid Mask color"
```

---

### Task 7: Fortune Page Generator

**Files:**
- Create: `pallid-mask/templates/fortune.html`
- Create: `pallid-mask/server/fortune-page.ts`

- [ ] **Step 1: Create the fortune page template**

Write `pallid-mask/templates/fortune.html`. This is a minimal HTML shell with placeholder slots. The server will inline CSS at generation time.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>the pallid mask</title>
<style>
{{FONT_FACE}}
{{STYLES}}

body {
  background: #000;
  display: flex;
  justify-content: center;
  min-height: 100vh;
  padding: 10vh 24px;
}
.fortune-page {
  max-width: 520px;
  width: 100%;
  text-align: center;
}
.fortune-sigil {
  width: 60px;
  height: 60px;
  margin: 0 auto 32px;
  opacity: 0.4;
}
.fortune-sigil svg {
  width: 100%;
  height: 100%;
  fill: var(--c3);
}
.fortune-meta {
  font-size: 0.7rem;
  color: var(--c3);
  letter-spacing: 0.16em;
  margin-bottom: 40px;
}
.fortune-divider {
  width: 40px;
  height: 1px;
  background: var(--c3);
  margin: 0 auto 40px;
  opacity: 0.5;
}
.fortune-footer {
  margin-top: 48px;
  padding-top: 32px;
  border-top: 1px solid var(--c2);
  font-size: 0.6rem;
  color: var(--c3);
  letter-spacing: 0.12em;
}

@media (max-width: 480px) {
  body { padding: 6vh 16px; }
  .entity-interpret { font-size: 0.9rem; }
}
</style>
</head>
<body>
<div class="fortune-page">
  <div class="fortune-sigil">{{SIGIL}}</div>
  <div class="fortune-meta">{{DATE}}</div>
  <div class="fortune-divider"></div>
  <div class="entity-interpret">{{FORTUNE}}</div>
  <div class="fortune-footer">the pallid mask · sou'wester arts week</div>
</div>
</body>
</html>
```

- [ ] **Step 2: Write the fortune page generator**

Write `pallid-mask/server/fortune-page.ts`:

```typescript
import { readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const TEMPLATE_PATH = join(import.meta.dir, "..", "templates", "fortune.html");
const STYLES_PATH = join(import.meta.dir, "..", "public", "styles.css");
const FONT_PATH = join(import.meta.dir, "..", "assets", "Orpheus.otf");
const FORTUNES_DIR = join(import.meta.dir, "..", "fortunes");

let cachedFontFace: string | null = null;
let cachedStyles: string | null = null;

function getFontFace(): string {
  if (!cachedFontFace) {
    const fontBuffer = readFileSync(FONT_PATH);
    const fontBase64 = fontBuffer.toString("base64");
    cachedFontFace = `@font-face {
  font-family: 'Orpheus';
  src: url(data:font/opentype;base64,${fontBase64}) format('opentype');
  font-weight: normal;
  font-style: normal;
}`;
  }
  return cachedFontFace;
}

function getStyles(): string {
  if (!cachedStyles) {
    const css = readFileSync(STYLES_PATH, "utf-8");
    // Extract only the :root vars and .entity-interpret class
    const rootMatch = css.match(/:root\s*\{[^}]+\}/);
    const interpretMatch = css.match(/\.entity-interpret\s*\{[^}]+\}/);
    const parts: string[] = [];
    if (rootMatch) parts.push(rootMatch[0]);
    if (interpretMatch) parts.push(interpretMatch[0]);
    // Add base body/font styles
    parts.push(`*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }`);
    parts.push(`html, body { font-family: 'Orpheus', Georgia, serif; }`);
    cachedStyles = parts.join("\n");
  }
  return cachedStyles;
}

export function clearStyleCache(): void {
  cachedFontFace = null;
  cachedStyles = null;
}

export interface FortunePageOptions {
  fortune: string;
  sigilSvg: string;
  publicBaseUrl: string;
}

export async function generateFortunePage(
  options: FortunePageOptions
): Promise<{ id: string; publicUrl: string; filePath: string }> {
  const id = randomUUID().slice(0, 12);
  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const date = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).toLowerCase();

  const html = template
    .replace("{{FONT_FACE}}", getFontFace())
    .replace("{{STYLES}}", getStyles())
    .replace("{{SIGIL}}", options.sigilSvg)
    .replace("{{DATE}}", date)
    .replace("{{FORTUNE}}", options.fortune);

  const filePath = join(FORTUNES_DIR, `${id}.html`);
  await Bun.write(filePath, html);

  const publicUrl = `${options.publicBaseUrl}/fortunes/${id}.html`;
  return { id, publicUrl, filePath };
}
```

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/templates/fortune.html pallid-mask/server/fortune-page.ts
git commit -m "Add fortune page generator: self-contained HTML with inlined CSS and base64 font"
```

---

### Task 8: Server Entry Point

**Files:**
- Create: `pallid-mask/server/index.ts`

- [ ] **Step 1: Write the server**

Write `pallid-mask/server/index.ts`:

```typescript
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { computeSeed, selectPassages, loadBible, loadYellow } from "./stichomancy";
import { generateFortune, generateGreeting } from "./fortune";
import { textToSpeech, cleanupAudio } from "./voice";
import { generateQRSvg } from "./qr";
import { generateFortunePage } from "./fortune-page";
import type { FortuneRequest, GreetingResponse, FortuneResponse } from "./types";

// Resolve paths relative to this file
const ROOT = join(import.meta.dir, "..");
const PUBLIC_DIR = join(ROOT, "public");
const FORTUNES_DIR = join(ROOT, "fortunes");
const DATA_DIR = join(ROOT, "data");
const AUDIO_DIR = join(PUBLIC_DIR, "audio");

// Ensure runtime directories exist
for (const dir of [FORTUNES_DIR, AUDIO_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Load data into memory
const soulPrompt = readFileSync(join(ROOT, "soul.md"), "utf-8");
const bible = loadBible(readFileSync(join(DATA_DIR, "king-james-bible.txt"), "utf-8"));
const yellow = loadYellow(readFileSync(join(DATA_DIR, "king-in-yellow.txt"), "utf-8"));
const sigils: { vb: string; d: string }[] = JSON.parse(
  readFileSync(join(DATA_DIR, "sigils.json"), "utf-8")
);

console.log(`Loaded ${bible.length} Bible verses, ${yellow.length} King in Yellow passages, ${sigils.length} sigils`);

const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";
const PORT = parseInt(process.env.PORT || "3000", 10);

// Pre-fetched greeting cache
let cachedGreeting: { text: string; audioUrl: string } | null = null;
let greetingInFlight = false;

async function prefetchGreeting(): Promise<void> {
  if (greetingInFlight) return;
  greetingInFlight = true;
  try {
    const text = await generateGreeting(soulPrompt);
    const audioUrl = await textToSpeech(text);
    cachedGreeting = { text, audioUrl };
    console.log("Greeting pre-fetched");
  } catch (err) {
    console.error("Greeting pre-fetch failed:", err);
    // Will retry on next request
    cachedGreeting = null;
  } finally {
    greetingInFlight = false;
  }
}

// Start pre-fetching on boot
prefetchGreeting();

function makeSigilSvg(index: number): string {
  const sigil = sigils[index % sigils.length];
  return `<svg viewBox="${sigil.vb}" xmlns="http://www.w3.org/2000/svg"><path d="${sigil.d}"/></svg>`;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // --- API Routes ---

    if (req.method === "POST" && url.pathname === "/api/greeting") {
      try {
        if (cachedGreeting) {
          const greeting = cachedGreeting;
          // Start pre-fetching the next greeting
          cachedGreeting = null;
          prefetchGreeting();
          return Response.json(greeting satisfies GreetingResponse);
        }
        // No cached greeting — generate on the fly
        const text = await generateGreeting(soulPrompt);
        const audioUrl = await textToSpeech(text);
        prefetchGreeting(); // pre-fetch next
        return Response.json({ text, audioUrl } satisfies GreetingResponse);
      } catch (err) {
        console.error("Greeting error:", err);
        return Response.json({ error: "Greeting generation failed" }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/fortune") {
      try {
        const body = (await req.json()) as FortuneRequest;
        const seed = computeSeed(body.timings);
        const passages = selectPassages(seed, yellow, bible);

        // Generate fortune text via Claude
        const fortune = await generateFortune(soulPrompt, passages, body.question);

        // Generate TTS, QR, and fortune page in parallel
        const sigilIndex = seed % sigils.length;
        const sigilSvg = makeSigilSvg(sigilIndex);

        const [audioUrl, fortunePage] = await Promise.all([
          textToSpeech(fortune),
          generateFortunePage({ fortune, sigilSvg, publicBaseUrl: PUBLIC_URL }),
        ]);

        const qrSvg = await generateQRSvg(fortunePage.publicUrl);

        return Response.json({
          fortune,
          qrSvg,
          publicUrl: fortunePage.publicUrl,
          audioUrl,
        } satisfies FortuneResponse);
      } catch (err) {
        console.error("Fortune error:", err);
        return Response.json({ error: "Fortune generation failed" }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      await cleanupAudio();
      prefetchGreeting();
      return Response.json({ ok: true });
    }

    // --- Static Files ---

    // Fortune pages
    if (url.pathname.startsWith("/fortunes/")) {
      const filePath = join(FORTUNES_DIR, url.pathname.slice("/fortunes/".length));
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "text/html" } });
      }
      return new Response("Not found", { status: 404 });
    }

    // Public static files (index.html, styles.css, dist/, audio/)
    let filePath = join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
    let file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    // Assets (fonts, etc.)
    if (url.pathname.startsWith("/assets/")) {
      filePath = join(ROOT, url.pathname);
      file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Pallid Mask server running on http://localhost:${server.port}`);
```

- [ ] **Step 2: Verify server starts**

Create a minimal `public/index.html` placeholder first:

```html
<!DOCTYPE html>
<html><body><h1>pallid mask</h1></body></html>
```

Run: `cd pallid-mask && source ../.env && bun run server/index.ts`
Expected: Server starts, prints data counts, prints listening message.

Kill the server (Ctrl+C).

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/server/index.ts pallid-mask/public/index.html
git commit -m "Add server entry point: routes, data loading, greeting pre-fetch, static file serving"
```

---

## Chunk 3: Client — Extract from Mockup

### Task 9: Extract CSS into styles.css

**Files:**
- Create: `pallid-mask/public/styles.css`
- Reference: `pallid-mask/mockup.html` lines 7–466

- [ ] **Step 1: Extract CSS from mockup.html**

Read `pallid-mask/mockup.html` lines 7–466 (everything inside the `<style>` tag). Write it to `pallid-mask/public/styles.css`.

This is a direct extraction — the CSS moves out unchanged. The only modification needed: the `@font-face` `src` URL changes from `url('assets/Orpheus.otf')` to `url('/assets/Orpheus.otf')` (absolute path for server).

- [ ] **Step 2: Verify the extraction**

Run: `cd pallid-mask && wc -l public/styles.css`
Expected: ~460 lines.

Verify the font-face URL was updated:
Run: `cd pallid-mask && grep "src:" public/styles.css`
Expected: Contains `url('/assets/Orpheus.otf')`

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/public/styles.css
git commit -m "Extract CSS from mockup.html into public/styles.css"
```

---

### Task 10: Create index.html (Installation Display)

**Files:**
- Modify: `pallid-mask/public/index.html` (replace placeholder)
- Reference: `pallid-mask/mockup.html` lines 468–610 (HTML structure)

- [ ] **Step 1: Write index.html**

Write `pallid-mask/public/index.html` — the installation display page. This contains:
- Link to `styles.css` (no inline styles)
- The HTML structure from mockup.html (sigil-frame div, screen container, bands, mask SVG, text exchange area)
- Script tag loading the bundled client: `<script type="module" src="/dist/main.js"></script>`
- The SVG mask markup (the face, eyes, mouth, cheeks, crinkles) — extracted from mockup.html lines 485–556

Key modifications from mockup.html:
- Remove all inline `<style>` — it's in styles.css now
- Remove all inline `<script>` — it's in the client bundle now
- Add `<link rel="stylesheet" href="/styles.css">`
- Add `<script type="module" src="/dist/main.js"></script>`
- Add `<div id="ceremony-overlay">` — a full-screen text overlay for ceremony states (WELCOME text, DIVINE narration, fortune text, QR display). This sits above the mask layer.
- Keep the mask SVG, sigil containers, and layout structure intact

Read the full HTML structure from mockup.html lines 468–610 and adapt it. The mask SVG markup is critical — copy it exactly (viewBox, paths, IDs, all face/eye/mouth/cheek/crinkle groups).

**Implementation note:** The HTML from mockup.html is ~140 lines of existing, working markup. Copy it directly rather than rewriting. The key elements are: `<div id="sigil-frame">`, `<div class="screen">`, the band containers, and the SVG mask (viewBox="230 75 350 505" with all path groups).

- [ ] **Step 2: Verify the page loads**

Run: `cd pallid-mask && source ../.env && bun run server/index.ts`
Open `http://localhost:3000` — should see the HTML structure (no animations yet, since JS isn't bundled).

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/public/index.html
git commit -m "Create installation display page: HTML structure from mockup with external CSS and JS"
```

---

### Task 11: Mask Module

**Files:**
- Create: `pallid-mask/client/mask.ts`
- Reference: `pallid-mask/mockup.html` — blink IIFE (lines 878–903), smile IIFE (lines 905–933)

- [ ] **Step 1: Write mask.ts**

Extract the blink and smile IIFEs from mockup.html and convert to an ES module. The mask module manages:
- Starting/stopping blink and smile animation loops
- Show/hide/recede transitions (CSS class toggles + opacity/transform)

The SVG markup stays in index.html — mask.ts queries the DOM for existing elements by ID (`#face-left`, `#eye-left`, `#mouth-upper`, etc.) and manipulates them.

Public API:
```typescript
export function show(): void       // fade mask in, start animations
export function hide(): void       // fade mask out, stop animations
export function recede(): void     // mask shrinks/fades (DIVINE state)
export function restore(): void    // mask returns from recede (FORTUNE state)
export function startAnimations(): void
export function stopAnimations(): void
```

**Implementation note:** Read the blink IIFE (mockup.html lines 878–903) and smile IIFE (lines 905–933) as the source of truth. These are ~55 lines of working JS total. Convert them to module form:

- Cache DOM references at module level: `const maskWrap = document.querySelector('.mask-wrap')!`, eye groups, mouth paths, cheek paths, crinkle elements
- Store all `setTimeout` IDs (`blinkTimeout`, `smileTimeout`) so `stopAnimations()` can cancel them
- Blink: add/remove `.blinking` class, listen for `animationend`, schedule next with `randomDelay(5000, 14000)`, 12% double-blink chance
- Smile: add/remove `.smiling` class, cleanup via `setTimeout(SMILE_DUR + 100)`, schedule next with `randomDelay(70000, 130000)`
- `show()`: remove `.mask-hidden` class from `.mask-wrap`
- `hide()`: add `.mask-hidden`, call `stopAnimations()`
- `recede()`: add `.mask-receding` class
- `restore()`: remove `.mask-receding`, ensure animations running

- [ ] **Step 2: Commit**

```bash
git add pallid-mask/client/mask.ts
git commit -m "Add mask module: blink, smile, show/hide/recede extracted from mockup"
```

---

### Task 12: Sigils Module

**Files:**
- Create: `pallid-mask/client/sigils.ts`
- Reference: `pallid-mask/mockup.html` — sigil morph IIFE (lines 748–859), bottom warp IIFE (lines 624–746), sigil frame IIFE (lines 935–1150)

- [ ] **Step 1: Write sigils.ts**

This is the largest extraction — three IIFEs consolidated into one module. Each subsystem becomes a set of internal functions, and the module exposes a clean public API.

The module fetches `sigils.json` at initialization instead of reading from an inlined `ALL_SIGILS` constant.

Public API:
```typescript
export async function init(): Promise<void>  // fetch sigils.json, set up DOM
export function start(): void                 // start all three animation loops
export function stop(): void                  // stop all loops, cancel rAFs
export function loadingMode(): void           // sigils prominent, for DIVINE
export function normalMode(): void            // sigils normal
```

Internal structure:
- `startMorph()` / `stopMorph()` — top banner cycling (30fps rAF loop)
- `startWarp()` / `stopWarp()` — bottom displacement transitions (setTimeout loop)
- `startFrame()` / `stopFrame()` — clockwise border wave (rAF loop)
- `loadingMode()` — increase sigil opacity/glow, speed up frame wave
- `normalMode()` — restore default sigil styling

**Implementation note:** Read each IIFE from mockup.html as the source of truth. These are substantial (~540 lines total) but well-structured. Convert to module form:

**Morph (lines 748–859, ~110 lines):** The 30fps rAF loop that cycles sigil paths. Replace `ALL_SIGILS` with the module-level array. Store the `requestAnimationFrame` ID and the pre-fetch `setTimeout` for cancellation. Key vars: `TARGET_FPS=30`, `MORPH_DUR=1500`, `HOLD_DUR=600`, ease function `1-(1-t)^4.5`.

**Warp (lines 624–746, ~120 lines):** Bottom sigil displacement crossfade. Creates paired SVG filters (`warp-out`, `warp-in`) with `feTurbulence` + `feDisplacementMap`. Store the cycle `setTimeout` for cancellation. Key timing: `OUT_DUR=1600`, `IN_DUR=2800`, `FADE_HALF=450`, cycle interval `randomDelay(9000, 15000)`.

**Frame (lines 935–1150, ~215 lines):** Clockwise wave around viewport. This has the filter pool pattern (12 filters, `avail[]` array, `inUse` Map), the `buildLayout()` function for positioning cells on 4 edges, and the `tick()` rAF loop. Store the rAF ID and the resize debounce timeout. Key constants: `CELL=50`, `POOL=12`, `WAVE_W=10`, `SCALE=42`, `PERIOD=20000`.

For `loadingMode()`: increase sigil opacity (e.g., frame cells to opacity 0.8, glow intensified) and optionally speed up PERIOD. For `normalMode()`: restore defaults.

- [ ] **Step 2: Commit**

```bash
git add pallid-mask/client/sigils.ts
git commit -m "Add sigils module: morph, warp, and frame wave consolidated from mockup IIFEs"
```

---

### Task 13: Display Module

**Files:**
- Create: `pallid-mask/client/display.ts`

- [ ] **Step 1: Write display.ts**

This is a new module (not extracted from mockup — the mockup has static text, not dynamic ceremony text). It manages the `#ceremony-overlay` element and renders text for each ceremony state.

```typescript
const overlay = document.getElementById("ceremony-overlay")!;

function fadeIn(el: HTMLElement): Promise<void> {
  el.style.opacity = "0";
  el.style.display = "flex";
  // Force reflow
  el.offsetHeight;
  el.style.transition = "opacity 0.8s ease";
  el.style.opacity = "1";
  return new Promise((r) => setTimeout(r, 800));
}

function fadeOut(el: HTMLElement): Promise<void> {
  el.style.transition = "opacity 0.6s ease";
  el.style.opacity = "0";
  return new Promise((r) => {
    setTimeout(() => {
      el.style.display = "none";
      r();
    }, 600);
  });
}

export async function showWelcome(): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-speech">have a seat.<br>when you are ready, press any key to begin.</div>
    </div>`;
  await fadeIn(overlay);
}

export async function showPrompt(): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-speech">type your question and press enter.</div>
      <div id="input-display" class="fortune-verse"></div>
    </div>`;
  await fadeIn(overlay);
}

// Returns a Promise that resolves only after all narration steps have displayed
// AND the returned `release` function is called (by the ceremony, when the API responds).
// The last narration step holds on screen until release() is called.
export async function showNarration(
  steps: string[]
): Promise<{ waitForRelease: Promise<void>; release: () => void }> {
  overlay.innerHTML = `<div class="ceremony-text"><div id="narration-line" class="entity-speech"></div></div>`;
  await fadeIn(overlay);

  const lineEl = document.getElementById("narration-line")!;
  const HOLD_MS = 2200;
  const FADE_MS = 600;

  for (let i = 0; i < steps.length; i++) {
    lineEl.style.opacity = "0";
    lineEl.textContent = steps[i];
    lineEl.style.transition = `opacity ${FADE_MS}ms ease`;
    lineEl.offsetHeight;
    lineEl.style.opacity = "1";

    if (i < steps.length - 1) {
      await new Promise((r) => setTimeout(r, HOLD_MS + FADE_MS));
    }
  }

  // Last line is now visible and holds. Return a release mechanism.
  let releaseFn: () => void;
  const waitForRelease = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  return { waitForRelease, release: releaseFn! };
}

export async function showFortune(text: string): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-interpret"></div>
    </div>`;
  // Use textContent to avoid XSS from Claude response
  overlay.querySelector(".entity-interpret")!.textContent = text;
  await fadeIn(overlay);
}

export async function showQROffer(): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-speech">press any key to receive your fortune.</div>
    </div>`;
  await fadeIn(overlay);
}

export async function showQR(svgString: string): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="qr-container">${svgString}</div>
      <div class="entity-speech">scan to take your fortune with you.<br>press any key when you are finished.</div>
    </div>`;
  await fadeIn(overlay);
}

export async function showError(message: string): Promise<void> {
  overlay.innerHTML = `
    <div class="ceremony-text">
      <div class="entity-speech">${message}</div>
    </div>`;
  await fadeIn(overlay);
}

export async function clear(): Promise<void> {
  await fadeOut(overlay);
  overlay.innerHTML = "";
}
```

- [ ] **Step 2: Commit**

```bash
git add pallid-mask/client/display.ts
git commit -m "Add display module: text overlays for all ceremony states with fade transitions"
```

---

### Task 14: Input Module

**Files:**
- Create: `pallid-mask/client/input.ts`

- [ ] **Step 1: Write input.ts**

```typescript
import type { InputResult } from "./types";

export function captureInput(): Promise<InputResult> {
  return new Promise((resolve) => {
    const timings: number[] = [];
    let lastTime = performance.now();
    let question = "";
    const displayEl = document.getElementById("input-display");

    function onKey(e: KeyboardEvent) {
      e.preventDefault();

      if (e.key === "Enter" && question.length > 0) {
        document.removeEventListener("keydown", onKey);
        resolve({ question, timings });
        return;
      }

      if (e.key === "Backspace") {
        question = question.slice(0, -1);
      } else if (e.key.length === 1) {
        const now = performance.now();
        timings.push(Math.round(now - lastTime));
        lastTime = now;
        question += e.key;
      }

      if (displayEl) {
        displayEl.textContent = question;
      }
    }

    document.addEventListener("keydown", onKey);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add pallid-mask/client/input.ts
git commit -m "Add input module: keystroke capture with timing intervals"
```

---

### Task 15: API Client Module

**Files:**
- Create: `pallid-mask/client/api.ts`

- [ ] **Step 1: Write api.ts**

```typescript
import type { GreetingResponse, FortuneResponse } from "./types";

export async function requestGreeting(): Promise<GreetingResponse> {
  const res = await fetch("/api/greeting", { method: "POST" });
  if (!res.ok) throw new Error(`Greeting failed: ${res.status}`);
  return res.json();
}

export async function requestFortune(
  question: string,
  timings: number[]
): Promise<FortuneResponse> {
  const res = await fetch("/api/fortune", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, timings }),
  });
  if (!res.ok) throw new Error(`Fortune failed: ${res.status}`);
  return res.json();
}

export async function requestReset(): Promise<void> {
  await fetch("/api/reset", { method: "POST" });
}
```

- [ ] **Step 2: Commit**

```bash
git add pallid-mask/client/api.ts
git commit -m "Add API client module: greeting, fortune, and reset endpoints"
```

---

### Task 16: Ceremony State Machine

**Files:**
- Create: `pallid-mask/client/ceremony.ts`

- [ ] **Step 1: Write ceremony.ts**

This is the orchestrator — the only module that knows the full flow. It imports all other client modules and drives transitions.

```typescript
import type { CeremonyState, FortuneResponse } from "./types";
import * as mask from "./mask";
import * as sigils from "./sigils";
import * as display from "./display";
import { captureInput } from "./input";
import { requestGreeting, requestFortune, requestReset } from "./api";

const NARRATION_STEPS = [
  "gathering the intervals between your keystrokes...",
  "deriving a seed from the rhythm of your intention...",
  "consulting the first text...",
  "consulting the second text...",
  "two passages have been drawn...",
  "the mask is interpreting...",
];

const QR_TIMEOUT_MS = 45_000;
const REVEAL_HOLD_MS = 6_000;

let state: CeremonyState = "WELCOME";

function playAudio(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Audio playback failed"));
    audio.play().catch(reject);
  });
}

function waitForKey(): Promise<void> {
  return new Promise((resolve) => {
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      document.removeEventListener("keydown", onKey);
      resolve();
    }
    document.addEventListener("keydown", onKey);
  });
}

async function enterState(next: CeremonyState): Promise<void> {
  state = next;
  console.log(`[ceremony] → ${state}`);

  switch (state) {
    case "WELCOME": {
      await display.showWelcome();
      await waitForKey();
      await display.clear();
      return enterState("SUMMON");
    }

    case "SUMMON": {
      mask.show();
      sigils.start();
      try {
        const greeting = await requestGreeting();
        await playAudio(greeting.audioUrl);
      } catch (err) {
        console.error("Greeting failed:", err);
        await handleError();
        return;
      }
      return enterState("INPUT");
    }

    case "INPUT": {
      await display.showPrompt();
      const input = await captureInput();
      await display.clear();
      return enterDivine(input.question, input.timings);
    }

    case "QR_OFFER": {
      await display.showQROffer();
      await waitForKey();
      await display.clear();
      return enterState("QR_DISPLAY");
    }

    default:
      break;
  }
}

async function enterDivine(question: string, timings: number[]): Promise<void> {
  state = "DIVINE";
  console.log(`[ceremony] → DIVINE`);

  mask.recede();
  sigils.loadingMode();

  // Start API call FIRST, then narration — both run in parallel
  let fortuneResult: FortuneResponse | null = null;
  let fortuneError: Error | null = null;

  // Kick off the fortune request immediately (runs concurrently with narration)
  const fortunePromise = requestFortune(question, timings)
    .then((result) => { fortuneResult = result; })
    .catch((err) => { fortuneError = err as Error; });

  // showNarration displays all steps sequentially (~14s), then holds on the last one.
  // While narration runs, the API call is also in flight.
  const narration = await display.showNarration(NARRATION_STEPS);

  // Narration is done. Wait for API if it hasn't resolved yet.
  await fortunePromise;
  // Release the narration hold
  narration.release();

  sigils.normalMode();
  await display.clear();

  if (fortuneError || !fortuneResult) {
    await handleError();
    return;
  }

  // FORTUNE state — mask returns, reads fortune aloud
  state = "FORTUNE";
  console.log(`[ceremony] → FORTUNE`);
  mask.restore();

  try {
    await playAudio(fortuneResult.audioUrl);
  } catch {
    // If audio fails, proceed to text display anyway
  }

  // REVEAL state — mask fades, text appears
  state = "REVEAL";
  console.log(`[ceremony] → REVEAL`);
  mask.hide();
  await display.showFortune(fortuneResult.fortune);
  await new Promise((r) => setTimeout(r, REVEAL_HOLD_MS));
  await display.clear();

  // QR_OFFER
  await enterState("QR_OFFER");

  // QR_DISPLAY
  state = "QR_DISPLAY";
  console.log(`[ceremony] → QR_DISPLAY`);
  await display.showQR(fortuneResult.qrSvg);

  // Wait for keypress OR 45s timeout
  await Promise.race([
    waitForKey(),
    new Promise<void>((r) => setTimeout(r, QR_TIMEOUT_MS)),
  ]);

  await display.clear();
  await reset();
}

async function handleError(): Promise<void> {
  mask.hide();
  sigils.stop();
  await display.clear();
  await display.showError(
    "the mask has lost its voice.<br>press any key to begin again."
  );
  await waitForKey();
  await reset();
}

async function reset(): Promise<void> {
  mask.hide();
  sigils.stop();
  await display.clear();
  await requestReset();
  return enterState("WELCOME");
}

export async function start(): Promise<void> {
  await sigils.init();
  await enterState("WELCOME");
}
```

- [ ] **Step 2: Commit**

```bash
git add pallid-mask/client/ceremony.ts
git commit -m "Add ceremony state machine: 8-state orchestrator with error handling and reset"
```

---

### Task 17: Client Entry Point + Build

**Files:**
- Create: `pallid-mask/client/main.ts`

- [ ] **Step 1: Write main.ts**

```typescript
import { start } from "./ceremony";

document.addEventListener("DOMContentLoaded", () => {
  start().catch((err) => {
    console.error("Ceremony failed to start:", err);
  });
});
```

- [ ] **Step 2: Build the client bundle**

Run: `cd pallid-mask && bun run build`
Expected: Bundle output in `public/dist/main.js`.

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/client/main.ts
git commit -m "Add client entry point and build"
```

---

## Chunk 4: Integration + Polish

### Task 18: Add Ceremony Overlay Styles

**Files:**
- Modify: `pallid-mask/public/styles.css`

- [ ] **Step 1: Add ceremony overlay CSS**

Append to `pallid-mask/public/styles.css`:

```css
/* ─── CEREMONY OVERLAY ─────────────────────────────────── */

#ceremony-overlay {
  position: fixed;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 500; /* above content, below sigil frame (999) and scanlines (1000) */
  pointer-events: none;
}

.ceremony-text {
  text-align: center;
  max-width: 600px;
  padding: 0 40px;
  pointer-events: auto;
}

#input-display {
  margin-top: 20px;
  min-height: 2em;
  border-bottom: 1px solid var(--c3);
  padding-bottom: 4px;
}

.qr-container {
  max-width: 280px;
  margin: 0 auto 24px;
}
.qr-container svg {
  width: 100%;
  height: auto;
}

/* Mask transition states */
.mask-wrap {
  transition: opacity 1.2s ease, transform 1.2s ease;
}
.mask-wrap.mask-hidden {
  opacity: 0;
  pointer-events: none;
}
.mask-wrap.mask-receding {
  opacity: 0.2;
  transform: scale(0.75) translateZ(0);
}
```

- [ ] **Step 2: Add overlay div to index.html**

Add `<div id="ceremony-overlay"></div>` to `pallid-mask/public/index.html`, after the `<div id="sigil-frame">` and before `<div class="screen">`.

- [ ] **Step 3: Commit**

```bash
git add pallid-mask/public/styles.css pallid-mask/public/index.html
git commit -m "Add ceremony overlay styles and mask transition states"
```

---

### Task 19: End-to-End Integration Test

- [ ] **Step 1: Build the client**

Run: `cd pallid-mask && bun run build`
Expected: `public/dist/main.js` created.

- [ ] **Step 2: Start the server**

Run: `cd pallid-mask && source ../.env && bun run dev`
Expected: Server starts, prints data counts, pre-fetches greeting.

- [ ] **Step 3: Open in browser**

Open `http://localhost:3000`.

Verify:
1. WELCOME text appears ("have a seat...")
2. Press a key → mask appears, greeting audio plays
3. After greeting → typing prompt appears
4. Type a question, press Enter → mask recedes, narration text appears
5. After processing → mask returns, fortune audio plays
6. After audio → mask fades, fortune text displays
7. After hold → "press any key to receive your fortune"
8. Press key → QR code appears
9. Press key or wait 45s → resets to WELCOME

- [ ] **Step 4: Test fortune page**

Open the public URL from the QR code (or copy it from server logs).
Verify:
- Fortune text renders with Orpheus font
- Pallid Mask color palette
- Responsive on mobile viewport

- [ ] **Step 5: Final commit**

```bash
git add -A pallid-mask/
git commit -m "Complete Pallid Mask installation: ceremony flow, visual extraction, API integration"
```

---

## Summary

| Task | Module | Type |
|------|--------|------|
| 1 | Project scaffolding | Setup |
| 2 | Data extraction | Setup |
| 3 | stichomancy.ts | Server (TDD) |
| 4 | fortune.ts | Server |
| 5 | voice.ts | Server |
| 6 | qr.ts | Server |
| 7 | fortune-page.ts + template | Server |
| 8 | server/index.ts | Server |
| 9 | styles.css extraction | Client |
| 10 | index.html | Client |
| 11 | mask.ts | Client (extract) |
| 12 | sigils.ts | Client (extract) |
| 13 | display.ts | Client (new) |
| 14 | input.ts | Client (new) |
| 15 | api.ts | Client (new) |
| 16 | ceremony.ts | Client (new) |
| 17 | main.ts + build | Client |
| 18 | Ceremony overlay styles | Polish |
| 19 | Integration test | Verification |
