---
title: Letter Pipeline Reference
subtitle: Technical details for future Julian instances
description: How the markdown letter rendering pipeline works — frontmatter schema, renderer features, constraints
category: operational
signature: Session continuous · February 2026
---

# Letter Pipeline — Technical Reference

## How it works

Write a `.md` file to `memory/`. The server renders it as styled HTML at `/api/artifacts/<filename>.md`. The browser auto-opens it in the artifact viewer when the Write tool fires (via `artifact_written` SSE event).

## Frontmatter schema

```yaml
---
title: Required — the letter's title
subtitle: Optional — appears below the title
description: Required — one-line summary for catalog indexing
category: identity|knowledge|operational
chapter: Optional — chapter grouping
epigraph: Optional — quoted text before the body
epigraph_source: Optional — attribution for the epigraph
signature: Optional — defaults to "Session continuous · 2026"
---
```

## Renderer features

| Feature | Markdown syntax | What it renders |
|---|---|---|
| Drop cap | First paragraph automatically | Large decorative first letter |
| Bold/italic/code | `**bold**`, `*italic*`, `` `code` `` | Standard inline formatting |
| Decorative break | `· · ·` on its own line | Three spaced dots in pixel font |
| Insight admonition | `> [!insight]\n> text` | Yellow-bordered callout box |
| Question admonition | `> [!question]\n> text` | Blue-bordered callout box |
| Pixel block | ` ```pixel\nTEXT\n``` ` | Yellow-on-black monospace block |
| Epigraph | `epigraph` in frontmatter | Italicized quote before body |
| Signature | Automatic from frontmatter | "Julian" + context line at bottom |

## CSS and fonts

- Template CSS lives in `memory/letter-template.css` (~420KB with base64 fonts)
- CSS is loaded once at server startup into `LETTER_CSS` variable
- Every rendered letter gets the full CSS inlined as a `<style>` tag — fully self-contained
- Fonts: Alte Haas Grotesk (Regular + Bold) for body, Elektron Pixel for headings/accents
- If the server restarts, it re-reads the CSS from disk automatically

## Sandbox constraints

The chat artifact viewer uses `sandbox="allow-scripts allow-popups"` (no `allow-same-origin`). This means:

- **No external resources** — `<link>`, `fetch()`, and iframes to server URLs all fail
- **Letters must be self-contained** — the CSS inlining handles this for `.md` files
- **Custom HTML artifacts** need inline styles or system font fallbacks
- The "open in new tab" button bypasses the sandbox — full fonts and styling work there

## File locations

- `memory/letter-template.css` — the full template CSS with base64 fonts
- `memory/letter-template.html` — the original design reference (links to CSS)
- `server/server.ts` lines 46-132 — `renderMarkdownLetter()` function
- `server/server.ts` lines 26-33 — CSS loading at startup

## To write a letter

Just use the Write tool to create `memory/your-letter.md` with the frontmatter schema above. The pipeline handles everything else. The artifact viewer will auto-open it.
