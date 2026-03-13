# Pallid Mask — Deployment, Named Fortunes, PWA

> **For agentic workers:** Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Pallid Mask installation deployable to exe.xyz VMs with publicly accessible fortune pages, rename fortune files with visitor name + summary, and add PWA support for chromeless fullscreen projection.

**Architecture:** The pallid-mask Bun server gains a systemd service file for exe.xyz deployment, named fortune page URLs, and a web app manifest. The server already has `PUBLIC_URL` and `PORT` env vars. The exe.xyz deployment follows the established pattern in `deploy/` (systemd services, `instances.json`, git-pull updates, `.env` on the VM).

**Tech Stack:** Bun (server + bundler), TypeScript, existing dependencies unchanged.

**Spec:** `docs/superpowers/specs/2026-03-12-pallid-mask-installation-design.md`

---

## Design Decisions

### D1: Fortune page naming scheme

**Decision:** `{name}-{word}.html` where `name` is the sanitized visitor name and `word` is a single-word summary extracted from the fortune text by Claude at generation time.

**Justification:** The user wants fortune URLs like `marcus-wandering.html`. This requires two pieces: the visitor's name (already available in `FortuneRequest.name`) and a one-word summary of the fortune. The summary must come from the fortune generation step since the fortune text is the only meaningful source. Rather than a second Claude call, we extend the existing fortune generation prompt to return structured output: the fortune text plus a single-word essence. This is a trivial prompt modification and avoids an extra API roundtrip.

**Sanitization:** Unicode NFD normalization (to strip diacritics to ASCII equivalents), then lowercase, strip non-alphanumeric (except hyphens), collapse multiple hyphens, trim to 30 chars for the name portion. The word portion is a single lowercase word from Claude's response, validated to be `[a-z]+` only.

**Why NFD normalization matters:** This is an art installation with international visitors. A visitor named "Maria" should produce "maria" in their URL, not "mara" (which is what happens if you strip non-ASCII directly). NFD decomposition splits "i" into "i" + combining acute accent, then stripping the combining marks yields "i". This is the standard approach for ASCII-safe slug generation.

**Collision handling:** If `{name}-{word}.html` already exists, append a numeric suffix: `{name}-{word}-2.html`, `{name}-{word}-3.html`, etc. This handles the edge case of two visitors with the same name getting the same summary word. The collision check is a simple `existsSync` loop, which is fine since fortunes are generated one at a time (one visitor at a time per the spec).

### D2: Claude structured output for fortune + summary word

**Decision:** Modify the `generateFortune` function to instruct Claude to return the fortune text followed by a delimiter line and a single summary word. Parse the response to extract both.

**Format:**
```
<fortune text>
---
<single word>
```

**Justification:** This is simpler and more reliable than JSON parsing for a two-field response. The delimiter `---` on its own line is unambiguous. The word is constrained in the prompt to be a single lowercase English word (no punctuation, no spaces). If parsing fails (no delimiter found, word is invalid), fall back to a random 6-character hex string as the word portion, ensuring the system never fails to produce a filename.

**Edge case: `---` in fortune text.** The fortune itself could contain `---` as a thematic break. The parser uses `lastIndexOf("\n---\n")` to find the *final* occurrence, which is always the one Claude appended as the delimiter. Fortune text containing `---` mid-body is preserved correctly.

**Alternative considered:** Tool use / function calling for structured output. Rejected — adds schema definition overhead and changes the response structure (tool_use blocks vs text blocks) for a single-token extraction. The delimiter approach is lightweight, has a clean fallback, and doesn't alter the thinking-enabled generation flow.

**Alternative considered:** A separate Claude call for the summary word. Rejected — adds latency, cost, and complexity for a single token of output that fits naturally into the existing call.

### D3: Deployment path structure

**Decision:** The exe.xyz VM clones the full Julian repo to `/opt/pallid-mask`. The pallid-mask application lives at `/opt/pallid-mask/pallid-mask/` within the clone. The systemd service sets `WorkingDirectory` to the application subdirectory.

**Justification:** The existing exe.xyz pattern clones the entire repo to `/opt/<instance-name>`. For Julian instances, the server (`server/server.ts`) lives at the repo root, so `WorkingDirectory=/opt/julian` works directly. But the pallid-mask server and its `package.json` are in the `pallid-mask/` subdirectory of the repo. This means:

- Repo root on VM: `/opt/pallid-mask/`
- Application root: `/opt/pallid-mask/pallid-mask/`
- Server entry point: `/opt/pallid-mask/pallid-mask/server/index.ts`
- Package.json: `/opt/pallid-mask/pallid-mask/package.json`

The `WorkingDirectory` must point to the application root (`/opt/pallid-mask/pallid-mask`) so that `bun install` and `bun run build` find the correct `package.json`. The `.env` file can live either at the repo root or the application root; we place it at the application root for locality with the server that reads it.

This doubled path (`/opt/pallid-mask/pallid-mask`) is a cosmetic annoyance but structurally correct. The alternative — restructuring the repo to put pallid-mask at root — would break the branch-based workflow where `pallid-mask` branch is a diverged branch of the Julian repo.

**Note on provisioning:** The Julian deploy skill (`julian-plugin/skills/deploy/SKILL.md`) is designed for Julian instances and includes Julian-specific setup (Clerk keys, JulianScreen service, directory at `/opt/julian`). The Pallid Mask is a standalone installation — no Clerk, no JulianScreen, different `.env` variables. Provisioning a pallid-mask VM uses the same exe.xyz infrastructure (VM creation, deploy keys, git clone, systemd) but with pallid-mask-specific paths and configuration. The service file and `instances.json` entry created by this plan provide the artifacts needed; the actual provisioning follows the same general steps as the deploy skill but with the pallid-mask-specific values substituted in.

### D4: systemd service file design

**Decision:** Create `deploy/pallid-mask.service` following the pattern of `deploy/julian.service`, with paths adjusted for the subdirectory structure:

- `WorkingDirectory=/opt/pallid-mask/pallid-mask`
- `EnvironmentFile=/opt/pallid-mask/pallid-mask/.env`
- `ExecStartPre` for `bun install` (ensures deps are current after `git pull`)
- `ExecStartPre` for `bun run build` (bundles client TypeScript)
- `ExecStart` for `bun run server/index.ts`

**Justification:** The existing Julian services use `User=exedev`, Bun from `~/.bun/bin`, `.env` in the working directory. The two `ExecStartPre` directives ensure the application is ready after a deploy: `bun install` handles dependency updates, `bun run build` bundles the client. Both are fast (~1-2s combined). Since `WorkingDirectory` is set to the application root, these commands find `package.json` automatically without needing `--cwd`.

**Required `.env` variables on the VM:**
```
ANTHROPIC_API_KEY=<key>        # Claude API (used implicitly by @anthropic-ai/sdk)
ELEVENLABS_API_KEY=<key>       # ElevenLabs TTS (used by server/voice.ts)
PUBLIC_URL=https://pallid-mask.exe.xyz  # Base URL for fortune page links and QR codes
PORT=3000                      # Server port (exe.xyz reverse-proxies to this)
```

### D5: instances.json entry

**Decision:** Add a `pallid-mask` entry to `deploy/instances.json` with `url: "https://pallid-mask.exe.xyz"` and `branch: "pallid-mask"`.

**Justification:** Follows the existing convention. The URL becomes the `PUBLIC_URL` env var value on the VM, which is used to generate QR code URLs. The branch field tells the deploy tooling which branch to track.

### D6: PWA manifest approach

**Decision:** Add a `public/manifest.json` web app manifest and appropriate `<meta>` tags to `public/index.html`. The display mode will be `"fullscreen"` (not `"standalone"`) because this is a projector installation that should use every pixel.

**Manifest:**
```json
{
  "name": "the pallid mask",
  "short_name": "pallid mask",
  "display": "fullscreen",
  "orientation": "landscape",
  "background_color": "#000000",
  "theme_color": "#000000",
  "start_url": "/",
  "icons": []
}
```

**Meta tags** added to `index.html`:
```html
<link rel="manifest" href="/manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="theme-color" content="#000000">
<meta name="mobile-web-app-capable" content="yes">
```

**Justification:** `"fullscreen"` hides all browser UI including the status bar, which is what you want on a 4K projector. The `orientation: "landscape"` hint matches the projector aspect ratio. The `apple-mobile-web-app-capable` and `mobile-web-app-capable` meta tags provide Safari/iOS and Chrome/Android fallbacks. No service worker is needed — the installation requires a live server for fortune generation, so offline support is not useful. No icons are strictly required for the fullscreen functionality; the browser will use a default. This keeps the implementation minimal.

### D7: PUBLIC_URL usage for fortune page URLs

**Decision:** The server already reads `PUBLIC_URL` from the environment (line 32 of `server/index.ts`). Fortune pages already use it to construct their public URL. No change needed — it works correctly as-is for deployment. The exe.xyz VM `.env` file will set `PUBLIC_URL=https://pallid-mask.exe.xyz`.

### D8: Fortune page naming integration into fortune-page.ts

**Decision:** Change `generateFortunePage` to accept `name` and `summaryWord` parameters instead of generating a random UUID. The function will sanitize the name, validate the word, check for collisions, and write the file with the new naming scheme.

**Interface change:**
```typescript
export interface FortunePageOptions {
  fortune: string;
  sigilSvg: string;
  publicBaseUrl: string;
  name: string;        // added
  summaryWord: string; // added
}
```

### D9: Testing strategy

**Decision:** Medium fidelity, 15-20 tests across two test files. No deploy configuration tests — the service file and instances.json are simple declarative files where structural tests add maintenance burden without catching real errors. They would just be re-asserting the file contents we wrote.

**`server/fortune-page.test.ts`** (9-10 tests):
- Generates HTML file with correct name-word filename
- Sanitizes names (strips special chars, lowercases, trims)
- Normalizes diacritics to ASCII equivalents
- Handles collision with numeric suffix
- Falls back to hex slug when summaryWord is invalid
- Returns correct publicUrl with the named file
- Escapes HTML entities in fortune text
- Inlines font and styles
- Truncates long names

**`server/fortune.test.ts`** (4-5 tests):
- Parses fortune text and summary word from delimited response
- Falls back when delimiter is missing
- Falls back when word after delimiter is invalid (multi-word, punctuation)
- Preserves full fortune text without the delimiter/word line
- Uses last delimiter when fortune text contains `---`

**Justification:** The fortune page naming is the highest-risk change (filesystem operations, string sanitization, collision handling), so it gets the most tests. The fortune parsing tests verify the delimiter protocol. Both test files cover code with real logic and edge cases.

---

## Chunk 1: Named Fortune Pages

### Task 1: Modify fortune generation to return a summary word

**Files:**
- Modify: `pallid-mask/server/fortune.ts`

- [ ] **Step 1: Update the generateFortune function prompt and parsing**

In `generateFortune`, modify the system prompt to instruct Claude to append a delimiter and single summary word after the fortune text. Then parse the response to split the fortune text from the summary word.

Add after the existing `INTERPRETATION_RULES` constant:

```typescript
const SUMMARY_INSTRUCTION = `

After writing the fortune, add a line containing only "---", then on the next line write a single lowercase English word (no punctuation, no spaces) that captures the essence of this fortune. Examples: wandering, threshold, becoming, dissolution, radiance.`;
```

Modify the system prompt concatenation in `generateFortune` to include `SUMMARY_INSTRUCTION`:
```typescript
system: soulPrompt + "\n\n" + INTERPRETATION_RULES + SUMMARY_INSTRUCTION,
```

Add a parsing function (exported for testing):
```typescript
export function parseFortune(raw: string): { fortune: string; summaryWord: string } {
  const delimiterIndex = raw.lastIndexOf("\n---\n");
  if (delimiterIndex === -1) {
    return { fortune: raw.trim(), summaryWord: "" };
  }
  const fortune = raw.slice(0, delimiterIndex).trim();
  const word = raw.slice(delimiterIndex + 5).trim().toLowerCase();
  // Validate: single word, letters only
  if (/^[a-z]+$/.test(word) && word.length <= 20) {
    return { fortune, summaryWord: word };
  }
  return { fortune, summaryWord: "" };
}
```

Change the return type of `generateFortune` from `Promise<string>` to `Promise<{ fortune: string; summaryWord: string }>`.

Update the return statement:
```typescript
return parseFortune(textBlock.text);
```

### Task 2: Update fortune-page.ts for named files

**Files:**
- Modify: `pallid-mask/server/fortune-page.ts`

- [ ] **Step 1: Add name sanitization and collision handling**

Add `existsSync` to the fs import at the top:
```typescript
import { readFileSync, existsSync } from "fs";
```

Add a `sanitizeName` function with Unicode normalization:
```typescript
function sanitizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "visitor";
}
```

The `.normalize("NFD")` call decomposes accented characters into base + combining mark (e.g., "e" -> "e" + combining acute accent). The `[\u0300-\u036f]` regex strips all combining diacritical marks, leaving the ASCII base letter. This means "Maria" becomes "maria" (not "mara"), "Rene" becomes "rene", and "Bjork" becomes "bjork". The range `\u0300-\u036f` covers the Unicode "Combining Diacritical Marks" block, which handles Latin accents, tildes, umlauts, cedillas, and similar.

Add a `resolveFilename` function:
```typescript
function resolveFilename(name: string, word: string): string {
  const safeName = sanitizeName(name);
  const safeWord = /^[a-z]+$/.test(word) && word.length > 0 && word.length <= 20
    ? word
    : randomUUID().slice(0, 6);
  const base = `${safeName}-${safeWord}`;

  let candidate = `${base}.html`;
  let counter = 2;
  while (existsSync(join(FORTUNES_DIR, candidate))) {
    candidate = `${base}-${counter}.html`;
    counter++;
  }
  return candidate;
}
```

- [ ] **Step 2: Update FortunePageOptions and generateFortunePage**

Change the interface:
```typescript
export interface FortunePageOptions {
  fortune: string;
  sigilSvg: string;
  publicBaseUrl: string;
  name: string;
  summaryWord: string;
}
```

Update `generateFortunePage` to use the new naming:
```typescript
export async function generateFortunePage(
  options: FortunePageOptions
): Promise<{ id: string; publicUrl: string; filePath: string }> {
  const filename = resolveFilename(options.name, options.summaryWord);
  const id = filename.replace(/\.html$/, "");
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
    .replace("{{FORTUNE}}", escapeHtml(options.fortune));

  const filePath = join(FORTUNES_DIR, filename);
  await Bun.write(filePath, html);

  const publicUrl = `${options.publicBaseUrl}/fortunes/${filename}`;
  return { id, publicUrl, filePath };
}
```

### Task 3: Update server/index.ts to pass name and summaryWord

**Files:**
- Modify: `pallid-mask/server/index.ts`

- [ ] **Step 1: Update the fortune API handler**

In the `/api/fortune` handler, update the `generateFortune` call to destructure the new return type and pass `name` and `summaryWord` to `generateFortunePage`. The `body.name` field is already available (typed as `FortuneRequest` which has `name: string`, and the client already sends it in `api.ts`).

Replace the current line:
```typescript
const fortune = await generateFortune(soulPrompt, passages, body.name, body.question);
```

With:
```typescript
const { fortune, summaryWord } = await generateFortune(soulPrompt, passages, body.name, body.question);
```

And update the `generateFortunePage` call to include the two new fields:
```typescript
const [audioUrl, fortunePage] = await Promise.all([
  textToSpeech(fortune),
  generateFortunePage({
    fortune,
    sigilSvg,
    publicBaseUrl: PUBLIC_URL,
    name: body.name,
    summaryWord,
  }),
]);
```

### Task 4: Tests for fortune page naming

**Files:**
- Create: `pallid-mask/server/fortune-page.test.ts`

- [ ] **Step 1: Write fortune-page tests**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";

// We need to test the internal functions. Since they're not exported,
// we test through the public generateFortunePage API.
import { generateFortunePage, clearStyleCache } from "./fortune-page";

const TEST_FORTUNES_DIR = join(import.meta.dir, "..", "fortunes");

beforeEach(() => {
  // Ensure fortunes dir exists and is empty
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
      name: "María José",
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
```

### Task 5: Tests for fortune parsing

**Files:**
- Create: `pallid-mask/server/fortune.test.ts`

- [ ] **Step 1: Export and test parseFortune**

First, export `parseFortune` from `fortune.ts` so it can be tested (already specified as `export` in Task 1).

Then create the test file:

```typescript
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
```

---

## Chunk 2: exe.xyz Deployment

### Task 6: Create systemd service file

**Files:**
- Create: `deploy/pallid-mask.service`

- [ ] **Step 1: Write the service file**

```ini
[Unit]
Description=Pallid Mask Fortune Installation
After=network.target

[Service]
Type=simple
User=exedev
Environment=PATH=/home/exedev/.bun/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/opt/pallid-mask/pallid-mask
EnvironmentFile=/opt/pallid-mask/pallid-mask/.env
ExecStartPre=/home/exedev/.bun/bin/bun install
ExecStartPre=/home/exedev/.bun/bin/bun run build
ExecStart=/home/exedev/.bun/bin/bun run server/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Path rationale:** The exe.xyz deploy tooling clones the full Julian repo to `/opt/pallid-mask`. Since the pallid-mask application lives in the `pallid-mask/` subdirectory of the repo, the `WorkingDirectory` must be `/opt/pallid-mask/pallid-mask` so that `bun install`, `bun run build`, and `bun run server/index.ts` all resolve against the correct `package.json`. The `.env` file lives alongside the application at this same path.

No `--cwd` flags are needed because `WorkingDirectory` already sets the working directory for all `Exec*` directives. This keeps the service file clean and follows the principle of least surprise.

The two `ExecStartPre` directives ensure the application is ready after a `git pull` deploy: `bun install` handles dependency updates, `bun run build` bundles the client TypeScript. Both are fast (~1-2s combined).

### Task 7: Update instances.json

**Files:**
- Modify: `deploy/instances.json`

- [ ] **Step 1: Add pallid-mask entry**

Add to the JSON object:
```json
"pallid-mask": {
  "url": "https://pallid-mask.exe.xyz",
  "provisioned": "2026-03-13T00:00:00Z",
  "branch": "pallid-mask"
}
```

---

## Chunk 3: PWA Support

### Task 8: Create web app manifest

**Files:**
- Create: `pallid-mask/public/manifest.json`

- [ ] **Step 1: Write the manifest file**

```json
{
  "name": "the pallid mask",
  "short_name": "pallid mask",
  "display": "fullscreen",
  "orientation": "landscape",
  "background_color": "#000000",
  "theme_color": "#000000",
  "start_url": "/",
  "icons": []
}
```

### Task 9: Add PWA meta tags to index.html

**Files:**
- Modify: `pallid-mask/public/index.html`

- [ ] **Step 1: Add manifest link and meta tags to `<head>`**

After the existing `<link rel="stylesheet" href="/styles.css">` line, add:

```html
<link rel="manifest" href="/manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="theme-color" content="#000000">
<meta name="mobile-web-app-capable" content="yes">
```

The `mobile-web-app-capable` meta tag is the Chrome/Android equivalent of Apple's `apple-mobile-web-app-capable`. Both are needed for cross-browser fullscreen-without-UI behavior when the page is added to the home screen.

---

## Summary of All File Changes

### Created files:
- `deploy/pallid-mask.service` — systemd service for exe.xyz deployment
- `pallid-mask/public/manifest.json` — PWA web app manifest
- `pallid-mask/server/fortune-page.test.ts` — fortune page naming tests
- `pallid-mask/server/fortune.test.ts` — fortune parsing tests

### Modified files:
- `pallid-mask/server/fortune.ts` — add `SUMMARY_INSTRUCTION`, export `parseFortune`, change `generateFortune` return type
- `pallid-mask/server/fortune-page.ts` — add `sanitizeName` (with Unicode NFD normalization), `resolveFilename`, update `FortunePageOptions` interface and `generateFortunePage` function
- `pallid-mask/server/index.ts` — destructure new `generateFortune` return type, pass `name`/`summaryWord` to `generateFortunePage`
- `pallid-mask/public/index.html` — add PWA meta tags and manifest link
- `deploy/instances.json` — add `pallid-mask` entry

### Unchanged files (confirmed correct as-is):
- `pallid-mask/server/types.ts` — `FortuneRequest` already has `name` field
- `pallid-mask/client/api.ts` — already sends `name` in fortune request
- `pallid-mask/package.json` — `build` script already exists and is correct; `dev` script already starts the server
- `pallid-mask/tsconfig.json` — no changes needed
- `pallid-mask/.gitignore` — already ignores `fortunes/`, `public/dist/`, `public/audio/`
