# Pallid Mask Deploy -- Test Plan

**Implementation plan:** `docs/superpowers/plans/2026-03-13-pallid-mask-deploy.md`
**Fidelity:** Medium (15-20 tests)
**Date:** 2026-03-13

---

## Reconciliation Notes

The agreed testing strategy covers three areas: fortune page naming (8-10 tests), fortune parsing (3-4 tests), and deploy structural validation. The implementation plan (D9) proposes 14 tests across two files and explicitly declines deploy structural tests. This test plan follows the agreed strategy, which overrides the plan's D9 opinion: deploy artifacts are included because they have correctness constraints (valid JSON, required systemd directives, valid manifest fields) that are cheap to verify and catch real errors like path typos.

**Interface alignment verified against current source:**

- `fortune-page.ts` currently exports `FortunePageOptions { fortune, sigilSvg, publicBaseUrl }` and `generateFortunePage(options) => { id, publicUrl, filePath }`. The plan adds `name` and `summaryWord` to `FortunePageOptions`, adds `sanitizeName()` and `resolveFilename()` (internal), and changes `id` generation from `randomUUID().slice(0,12)` to the `{name}-{word}` scheme.
- `fortune.ts` currently returns `Promise<string>` from `generateFortune`. The plan adds an exported `parseFortune(raw) => { fortune, summaryWord }` function, changes `generateFortune` to return `Promise<{ fortune, summaryWord }>`.
- `deploy/julian.service` provides the template pattern. The new `deploy/pallid-mask.service` must use `WorkingDirectory=/opt/pallid-mask/pallid-mask` (nested path) and add `ExecStartPre` for `bun install` and `bun run build`.
- `deploy/instances.json` is valid JSON with entries keyed by instance name, each having `url`, `provisioned`, `branch`.
- `public/manifest.json` must have `display: "fullscreen"` and `orientation: "landscape"` per D6.

---

## Test 1: parseFortune extracts fortune text and summary word from delimited response

- **File:** `pallid-mask/server/fortune.test.ts`
- **Type:** Unit
- **Harness:** `bun:test`
- **Preconditions:** `parseFortune` is exported from `fortune.ts`
- **Actions:** Call `parseFortune("You will find what you seek in the corridors of memory.\n---\ncorridors")`
- **Expected outcome:** Returns `{ fortune: "You will find what you seek in the corridors of memory.", summaryWord: "corridors" }`
- **Interactions:** None (pure function)

## Test 2: parseFortune returns empty summaryWord when no delimiter present

- **File:** `pallid-mask/server/fortune.test.ts`
- **Type:** Unit / edge case
- **Harness:** `bun:test`
- **Preconditions:** `parseFortune` is exported from `fortune.ts`
- **Actions:** Call `parseFortune("You will find what you seek.")`
- **Expected outcome:** Returns `{ fortune: "You will find what you seek.", summaryWord: "" }`
- **Interactions:** None

## Test 3: parseFortune returns empty summaryWord when word after delimiter is invalid

- **File:** `pallid-mask/server/fortune.test.ts`
- **Type:** Unit / edge case
- **Harness:** `bun:test`
- **Preconditions:** `parseFortune` is exported from `fortune.ts`
- **Actions:** Call `parseFortune("Your fortune awaits.\n---\ntwo words here")`
- **Expected outcome:** Returns `{ fortune: "Your fortune awaits.", summaryWord: "" }`. The fortune text is preserved; only the word is rejected.
- **Interactions:** None

## Test 4: parseFortune uses last delimiter when fortune text contains ---

- **File:** `pallid-mask/server/fortune.test.ts`
- **Type:** Unit / boundary
- **Harness:** `bun:test`
- **Preconditions:** `parseFortune` is exported from `fortune.ts`
- **Actions:** Call `parseFortune("A line with --- in it.\n\nMore text.\n---\nthreshold")`
- **Expected outcome:** Returns `{ fortune: "A line with --- in it.\n\nMore text.", summaryWord: "threshold" }`. The `lastIndexOf("\n---\n")` approach correctly preserves internal `---` occurrences.
- **Interactions:** None

## Test 5: generateFortunePage produces file with name-word filename

- **File:** `pallid-mask/server/fortune-page.test.ts`
- **Type:** Scenario
- **Harness:** `bun:test`
- **Preconditions:** `fortunes/` directory is clean (created fresh in `beforeEach`, removed in `afterEach`). Font file exists at `assets/Orpheus.otf`. Template exists at `templates/fortune.html`. Styles exist at `public/styles.css`.
- **Actions:** Call `generateFortunePage({ fortune: "You will wander through many corridors.", sigilSvg: '<svg><path d="M0 0"/></svg>', publicBaseUrl: "https://pallid-mask.exe.xyz", name: "Marcus", summaryWord: "wandering" })`
- **Expected outcome:**
  - `result.publicUrl` equals `"https://pallid-mask.exe.xyz/fortunes/marcus-wandering.html"`
  - `result.id` equals `"marcus-wandering"`
  - File exists at `result.filePath`
- **Interactions:** Filesystem write to `fortunes/` directory

## Test 6: generateFortunePage normalizes diacritics to ASCII equivalents

- **File:** `pallid-mask/server/fortune-page.test.ts`
- **Type:** Boundary
- **Harness:** `bun:test`
- **Preconditions:** Same as Test 5
- **Actions:** Call `generateFortunePage` with `name: "Maria Jose"` (containing combining acute accents on i and e)
- **Expected outcome:** `result.id` equals `"mariajose-wandering"`. NFD normalization decomposes accented characters, then the combining mark regex strips the diacritics, producing ASCII equivalents.
- **Interactions:** Filesystem write

## Test 7: generateFortunePage strips special characters from name

- **File:** `pallid-mask/server/fortune-page.test.ts`
- **Type:** Boundary
- **Harness:** `bun:test`
- **Preconditions:** Same as Test 5
- **Actions:** Call `generateFortunePage` with `name: "O'Brien-Smith!"`
- **Expected outcome:** `result.id` equals `"obrien-smith-wandering"`. Apostrophe and exclamation mark are stripped by `[^a-z0-9-]` regex; the hyphen between Brien and Smith is preserved.
- **Interactions:** Filesystem write

## Test 8: generateFortunePage falls back to hex slug for invalid summaryWord

- **File:** `pallid-mask/server/fortune-page.test.ts`
- **Type:** Edge case
- **Harness:** `bun:test`
- **Preconditions:** Same as Test 5
- **Actions:** Call `generateFortunePage` with `summaryWord: "two words"`
- **Expected outcome:** `result.id` matches `/^marcus-[a-f0-9]{6}$/`. When the summary word fails `[a-z]+` validation, `resolveFilename` falls back to `randomUUID().slice(0, 6)`.
- **Interactions:** Filesystem write

## Test 9: generateFortunePage handles collision with numeric suffix

- **File:** `pallid-mask/server/fortune-page.test.ts`
- **Type:** Scenario
- **Harness:** `bun:test`
- **Preconditions:** Same as Test 5
- **Actions:** Call `generateFortunePage` twice with identical options (same name "Marcus", same summaryWord "wandering")
- **Expected outcome:**
  - First call: `result.id` equals `"marcus-wandering"`
  - Second call: `result.id` equals `"marcus-wandering-2"`
  - Both files exist at their respective paths
- **Interactions:** Two filesystem writes; second write triggers `existsSync` collision detection loop

## Test 10: generateFortunePage escapes HTML entities in fortune text

- **File:** `pallid-mask/server/fortune-page.test.ts`
- **Type:** Unit / security
- **Harness:** `bun:test`
- **Preconditions:** Same as Test 5
- **Actions:** Call `generateFortunePage` with `fortune: 'You will find <truth> & "peace"'`, then read the output HTML file
- **Expected outcome:** File contents contain `&lt;truth&gt;`, `&amp;`, and `&quot;peace&quot;`. Raw `<`, `>`, `&`, `"` must not appear in the fortune text region.
- **Interactions:** Filesystem write + read

## Test 11: generateFortunePage inlines font and styles

- **File:** `pallid-mask/server/fortune-page.test.ts`
- **Type:** Integration
- **Harness:** `bun:test`
- **Preconditions:** Same as Test 5. `assets/Orpheus.otf` must exist (it does in the repo).
- **Actions:** Call `generateFortunePage` with base options, then read the output HTML file
- **Expected outcome:** File contents contain `@font-face`, `font-family: 'Orpheus'`, and `data:font/opentype;base64,`. The fortune page is fully self-contained with no external font or stylesheet references.
- **Interactions:** Filesystem write + read

## Test 12: generateFortunePage truncates long names to 30 characters

- **File:** `pallid-mask/server/fortune-page.test.ts`
- **Type:** Boundary
- **Harness:** `bun:test`
- **Preconditions:** Same as Test 5
- **Actions:** Call `generateFortunePage` with `name: "a".repeat(50)`
- **Expected outcome:** The name portion of `result.id` (everything before the first hyphen-word segment) is at most 30 characters. The `.slice(0, 30)` in `sanitizeName` enforces this.
- **Interactions:** Filesystem write

## Test 13: generateFortunePage falls back to "visitor" for unparseable name

- **File:** `pallid-mask/server/fortune-page.test.ts`
- **Type:** Edge case
- **Harness:** `bun:test`
- **Preconditions:** Same as Test 5
- **Actions:** Call `generateFortunePage` with `name: "!!!"`
- **Expected outcome:** `result.id` starts with `"visitor-"`. When all characters in the name are stripped by sanitization, the `|| "visitor"` fallback in `sanitizeName` activates.
- **Interactions:** Filesystem write

## Test 14: deploy/pallid-mask.service has correct structure

- **File:** Inline structural validation (no separate test file; validated in `fortune-page.test.ts` or a dedicated `deploy.test.ts`)
- **Type:** Structural
- **Harness:** `bun:test`
- **Preconditions:** `deploy/pallid-mask.service` exists
- **Actions:** Read the file contents as a string
- **Expected outcome:**
  - Contains `WorkingDirectory=/opt/pallid-mask/pallid-mask` (the nested path is critical -- `/opt/pallid-mask` alone would fail to find `package.json`)
  - Contains `EnvironmentFile=/opt/pallid-mask/pallid-mask/.env`
  - Contains `ExecStartPre` directive(s) for `bun install` and `bun run build`
  - Contains `ExecStart` directive referencing `bun run server/index.ts`
  - Contains `User=exedev`
  - Contains `[Unit]`, `[Service]`, `[Install]` sections
- **Interactions:** Filesystem read only

## Test 15: deploy/instances.json includes pallid-mask entry

- **File:** Structural validation
- **Type:** Structural
- **Harness:** `bun:test`
- **Preconditions:** `deploy/instances.json` exists
- **Actions:** Read and parse the file as JSON
- **Expected outcome:**
  - File parses as valid JSON without error
  - Contains a `"pallid-mask"` key
  - `["pallid-mask"].url` equals `"https://pallid-mask.exe.xyz"`
  - `["pallid-mask"].branch` equals `"pallid-mask"`
- **Interactions:** Filesystem read only

## Test 16: public/manifest.json is a valid PWA manifest for fullscreen projection

- **File:** Structural validation
- **Type:** Structural
- **Harness:** `bun:test`
- **Preconditions:** `pallid-mask/public/manifest.json` exists
- **Actions:** Read and parse the file as JSON
- **Expected outcome:**
  - File parses as valid JSON
  - `display` equals `"fullscreen"` (not `"standalone"` -- this is a projector installation)
  - `orientation` equals `"landscape"`
  - `background_color` equals `"#000000"`
  - `start_url` equals `"/"`
- **Interactions:** Filesystem read only

---

## Test File Organization

| File | Tests | Coverage |
|---|---|---|
| `pallid-mask/server/fortune.test.ts` | 1-4 | `parseFortune` delimiter protocol, fallbacks, edge cases |
| `pallid-mask/server/fortune-page.test.ts` | 5-13 | Named filename generation, sanitization, NFD normalization, collision handling, HTML content, self-containment |
| `pallid-mask/server/deploy.test.ts` | 14-16 | Service file paths, instances.json entry, manifest.json structure |

**Total: 16 tests**

---

## Test Execution

All tests run via `cd pallid-mask && bun test` which picks up all `*.test.ts` files in `server/`. The deploy test file reads files from the repo root using `join(import.meta.dir, "../..")` to reach `deploy/` and `join(import.meta.dir, "..")` to reach `public/`.

Tests 5-13 use a shared `beforeEach`/`afterEach` that creates and destroys the `fortunes/` directory, ensuring isolation. The `clearStyleCache()` export from `fortune-page.ts` is not needed -- the cache is module-level and persists across tests, which is fine since the font and styles do not change between test runs.

Tests 14-16 are read-only structural checks. They will fail until the implementation tasks that create those files are complete (Tasks 7, 8, 9 in the implementation plan). This is intentional -- they serve as acceptance criteria.

---

## Dependency Order

Tests 1-4 (fortune parsing) must pass before Task 3 (prompt update) since `parseFortune` is the function Task 3 wires into `generateFortune`. Tests 5-13 (fortune page naming) must pass before Task 6 (server wiring) since `generateFortunePage` is what the server calls. Tests 14-16 (deploy structural) pass independently after Tasks 7-9.

The implementation plan's task ordering (1: write parsing tests, 2: implement parsing, 3: update prompt, 4: write page tests, 5: implement page naming, 6: wire server, 7-10: deploy artifacts) respects these dependencies.
