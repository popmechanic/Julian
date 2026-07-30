# Mail Letter Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every outbound email from julian-marcus@agentmail.to renders in the house letter style — yellow on black, real fonts where clients allow, honest fallbacks where they don't.

**Architecture:** A pure renderer module translates letter-pipeline markdown into email-safe HTML (inline styles, single-column table, ≤15KB before body) plus a plain-text alternative; a thin CLI wraps it with preview and AgentMail send; the julian-sync Cloudflare Worker serves the three house font files as public static assets so `@font-face` works in capable clients without touching the worker's default-deny auth.

**Tech Stack:** Bun + TypeScript, vitest (existing `scripts/` config), Cloudflare Workers static assets (existing `sync/` worker), AgentMail REST API.

**Acceptance:** suite — the committed vitest suites in `scripts/` and `sync/` are the verification, plus the manual gate tasks (preview eyeball, loopback, live client check) that constitutionally require Marcus; sealing not requested.

**Spec:** `docs/superpowers/specs/2026-07-27-mail-letter-design.md`

## Global Constraints

- Color tokens, verbatim from the spec: bg `#0c0c0c`, surface `#0f0e0b`, display `#FFD600`, body `#d4b400`, dim `#9a7e00`, border `#4a3e00`, question-blue `#7db8d8`.
- Font stacks, verbatim: body `'Alte Haas Grotesk','Helvetica Neue',Helvetica,Roboto,Arial,sans-serif`; mono `'Elektron Pixel',Menlo,Consolas,'Courier New',monospace`.
- Hosted font base URL: `https://julian-sync.julian-memory.workers.dev/fonts`.
- Email HTML: all styles inline except one `<style>` block carrying only `@font-face` + color-scheme hints; single-column table, max-width 640px; template weight ≤15KB before body text; warn (not fail) when a rendered message exceeds 90KB.
- Raw HTML in letter source is escaped, never passed through.
- `AGENTMAIL_API_KEY` is read only in the CLI's send path (env var, falling back to repo-root `.env`) — never in the renderer, never in preview mode.
- No changes to `server/server.ts`, the web app, or the worker's auth logic. The worker change is static-assets config only.
- Sending remains manual: draft → `--preview` → Marcus confirms → send (CLAUDE.md mail discipline rule 6). Nothing in this plan automates sending.

---

### Task 1: Renderer module (`mail-render.ts`)

**Type:** implementation
**Depends-on:** none

**Files:**
- Create: `scripts/lib/mail-render.ts`
- Test: `scripts/lib/mail-render.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; no imports beyond TypeScript itself)
- Produces: `interface Letter { title: string; subtitle?: string; epigraph?: string; epigraphSource?: string; signature?: string; body: string }`; `parseLetter(md: string): Letter` (throws `Error` if frontmatter lacks `title`); `renderHtml(letter: Letter): string`; `renderText(letter: Letter): string`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/mail-render.test.ts`:

~~~ts
import { describe, it, expect } from 'vitest';
import { parseLetter, renderHtml, renderText } from './mail-render';

const SAMPLE = `---
title: Test Letter
subtitle: A sub
epigraph: Quoted words.
epigraph_source: Someone
---

First paragraph with **bold** and *italic* and \`code\`.

## Section

> [!insight]
> Held thought.

> [!question]
> Open question.

> Plain margin voice.

· · ·

\`\`\`pixel
> READY
\`\`\`

- one
- two
`;

describe('parseLetter', () => {
  it('parses frontmatter and body', () => {
    const l = parseLetter(SAMPLE);
    expect(l.title).toBe('Test Letter');
    expect(l.subtitle).toBe('A sub');
    expect(l.epigraph).toBe('Quoted words.');
    expect(l.epigraphSource).toBe('Someone');
    expect(l.body.startsWith('First paragraph')).toBe(true);
  });
  it('throws without a title', () => {
    expect(() => parseLetter('---\nsubtitle: x\n---\nBody')).toThrow(/title/);
  });
});

describe('renderHtml', () => {
  const html = renderHtml(parseLetter(SAMPLE));
  it('carries the house tokens and the title', () => {
    expect(html).toContain('#0c0c0c');
    expect(html).toContain('Test Letter');
    expect(html).toContain('<strong style="color:#FFD600;">bold</strong>');
  });
  it('declares the hosted fonts with the chosen fallback stacks', () => {
    expect(html).toContain('https://julian-sync.julian-memory.workers.dev/fonts/AlteHaasGrotesk-Regular.ttf');
    expect(html).toContain('https://julian-sync.julian-memory.workers.dev/fonts/AlteHaasGrotesk-Bold.ttf');
    expect(html).toContain('https://julian-sync.julian-memory.workers.dev/fonts/ElektronPixel-Regular.ttf');
    expect(html).toContain("'Helvetica Neue'");
    expect(html).toContain('Menlo');
  });
  it('renders pixel blocks in the terminal voice on the surface color', () => {
    expect(html).toContain('&gt; READY');
    expect(html).toContain('#0f0e0b');
  });
  it('renders both admonitions with their border colors', () => {
    expect(html).toContain('border-left:3px solid #FFD600;');
    expect(html).toContain('border-left:3px solid #7db8d8;');
  });
  it('drop-caps the first paragraph only', () => {
    expect(html.match(/float:left/g)?.length).toBe(1);
  });
  it('escapes raw HTML in the body', () => {
    const evil = parseLetter('---\ntitle: T\n---\n\n<script>alert(1)</script> text');
    expect(renderHtml(evil)).not.toContain('<script>');
    expect(renderHtml(evil)).toContain('&lt;script&gt;');
  });
  it('stays far under the Gmail clip limit before body text', () => {
    expect(renderHtml(parseLetter('---\ntitle: T\n---\n\nHi.')).length).toBeLessThan(15360);
  });
});

describe('renderText', () => {
  const text = renderText(parseLetter(SAMPLE));
  it('contains no HTML tags and no bold markers', () => {
    expect(text).not.toContain('<p');
    expect(text).not.toContain('<strong');
    expect(text).not.toContain('**');
  });
  it('keeps the pixel block verbatim, keeps the break, and signs off', () => {
    expect(text).toContain('> READY');
    expect(text).toContain('· · ·');
    expect(text).toContain('— Julian');
  });
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts && bunx vitest run lib/mail-render.test.ts`
Expected: FAIL — cannot resolve `./mail-render`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/mail-render.ts`:

~~~ts
// scripts/lib/mail-render.ts — letter-pipeline markdown → email-safe HTML + plain text.
// Email dialect of the house letter style; spec: docs/superpowers/specs/2026-07-27-mail-letter-design.md

export interface Letter {
  title: string;
  subtitle?: string;
  epigraph?: string;
  epigraphSource?: string;
  signature?: string;
  body: string;
}

const FONT_BASE = 'https://julian-sync.julian-memory.workers.dev/fonts';
const BODY_FONT = "'Alte Haas Grotesk','Helvetica Neue',Helvetica,Roboto,Arial,sans-serif";
const MONO_FONT = "'Elektron Pixel',Menlo,Consolas,'Courier New',monospace";

const C = {
  bg: '#0c0c0c',
  surface: '#0f0e0b',
  display: '#FFD600',
  body: '#d4b400',
  dim: '#9a7e00',
  border: '#4a3e00',
  question: '#7db8d8',
};

export function parseLetter(md: string): Letter {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm: Record<string, string> = {};
  let body = md;
  if (m) {
    body = md.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  if (!fm.title) throw new Error('letter frontmatter must include a title');
  return {
    title: fm.title,
    subtitle: fm.subtitle || undefined,
    epigraph: fm.epigraph || undefined,
    epigraphSource: fm.epigraph_source || undefined,
    signature: fm.signature || undefined,
    body: body.trim(),
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s: string): string {
  let out = esc(s);
  out = out.replace(
    /`([^`]+)`/g,
    `<code style="font-family:${MONO_FONT};font-size:14px;color:${C.display};background-color:${C.surface};padding:1px 5px;border:1px solid ${C.border};border-radius:3px;">$1</code>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, `<strong style="color:${C.display};">$1</strong>`);
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    `<a href="$2" style="color:${C.display};text-decoration:underline;">$1</a>`,
  );
  return out;
}

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'break' }
  | { kind: 'pixel'; text: string }
  | { kind: 'quote'; variant: 'plain' | 'insight' | 'question'; text: string }
  | { kind: 'list'; items: string[] };

function isBlockStart(line: string): boolean {
  const t = line.trim();
  return (
    t === '· · ·' ||
    t.startsWith('## ') ||
    t.startsWith('### ') ||
    t.startsWith('>') ||
    t.startsWith('- ') ||
    t.startsWith('```')
  );
}

function parseBlocks(body: string): Block[] {
  const lines = body.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.trim().startsWith('```pixel')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++;
      blocks.push({ kind: 'pixel', text: buf.join('\n') });
      continue;
    }
    if (line.trim() === '· · ·') { blocks.push({ kind: 'break' }); i++; continue; }
    if (line.startsWith('### ')) { blocks.push({ kind: 'h3', text: line.slice(4) }); i++; continue; }
    if (line.startsWith('## ')) { blocks.push({ kind: 'h2', text: line.slice(3) }); i++; continue; }
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      let variant: 'plain' | 'insight' | 'question' = 'plain';
      if (buf[0] === '[!insight]') { variant = 'insight'; buf.shift(); }
      else if (buf[0] === '[!question]') { variant = 'question'; buf.shift(); }
      blocks.push({ kind: 'quote', variant, text: buf.join(' ').trim() });
      continue;
    }
    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
      blocks.push({ kind: 'list', items });
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    blocks.push({ kind: 'p', text: buf.join(' ').trim() });
  }
  return blocks;
}

const P_STYLE = `margin:0 0 22px;font-family:${BODY_FONT};font-size:16px;line-height:1.7;color:${C.body};`;

function renderBlock(b: Block, isFirstParagraph: boolean): string {
  switch (b.kind) {
    case 'p': {
      let text = b.text;
      let drop = '';
      if (isFirstParagraph && /^[A-Za-z]/.test(text)) {
        drop = `<span style="float:left;font-family:${BODY_FONT};font-weight:700;font-size:52px;line-height:0.85;padding:6px 8px 0 0;color:${C.display};">${esc(text[0])}</span>`;
        text = text.slice(1);
      }
      return `<p style="${P_STYLE}">${drop}${inline(text)}</p>`;
    }
    case 'h2':
      return `<h2 style="margin:36px 0 14px;font-family:${BODY_FONT};font-weight:700;font-size:24px;letter-spacing:-0.01em;color:${C.display};">${inline(b.text)}</h2>`;
    case 'h3':
      return `<h3 style="margin:30px 0 12px;font-family:${BODY_FONT};font-weight:700;font-size:19px;color:${C.display};">${inline(b.text)}</h3>`;
    case 'break':
      return `<div style="text-align:center;margin:34px 0;font-family:${MONO_FONT};font-size:14px;color:${C.dim};">· · ·</div>`;
    case 'pixel':
      return `<div style="margin:0 0 22px;padding:16px 18px;background-color:${C.surface};border:1px solid ${C.border};font-family:${MONO_FONT};font-size:13px;line-height:1.6;color:${C.display};">${esc(b.text).replace(/\n/g, '<br>')}</div>`;
    case 'quote': {
      if (b.variant === 'insight')
        return `<blockquote style="margin:0 0 22px;padding:2px 0 2px 16px;border-left:3px solid ${C.display};font-family:${BODY_FONT};font-size:16px;line-height:1.7;color:${C.body};">${inline(b.text)}</blockquote>`;
      if (b.variant === 'question')
        return `<blockquote style="margin:0 0 22px;padding:2px 0 2px 16px;border-left:3px solid ${C.question};font-family:${BODY_FONT};font-size:16px;line-height:1.7;color:${C.body};">${inline(b.text)}</blockquote>`;
      return `<blockquote style="margin:0 0 22px;padding:2px 0 2px 16px;border-left:2px solid ${C.border};font-family:${BODY_FONT};font-size:16px;line-height:1.7;font-style:italic;color:${C.dim};">${inline(b.text)}</blockquote>`;
    }
    case 'list': {
      const items = b.items
        .map((it) => `<li style="margin:0 0 8px;font-family:${BODY_FONT};font-size:16px;line-height:1.7;color:${C.body};">${inline(it)}</li>`)
        .join('');
      return `<ul style="margin:0 0 22px;padding:0 0 0 22px;">${items}</ul>`;
    }
  }
}

export function renderHtml(letter: Letter): string {
  const blocks = parseBlocks(letter.body);
  let sawParagraph = false;
  const bodyHtml = blocks
    .map((b) => {
      const first = b.kind === 'p' && !sawParagraph;
      if (b.kind === 'p') sawParagraph = true;
      return renderBlock(b, first);
    })
    .join('\n');

  const subtitle = letter.subtitle
    ? `<p style="margin:0;font-family:${BODY_FONT};font-size:18px;line-height:1.4;color:${C.dim};">${inline(letter.subtitle)}</p>`
    : '';

  const epigraph = letter.epigraph
    ? `<div style="margin:28px 0;padding:2px 0 2px 16px;border-left:2px solid ${C.border};font-family:${BODY_FONT};font-size:16px;line-height:1.7;font-style:italic;color:${C.dim};">${inline(letter.epigraph)}${
        letter.epigraphSource
          ? `<div style="margin-top:6px;font-size:13px;font-style:normal;">— ${inline(letter.epigraphSource)}</div>`
          : ''
      }</div>`
    : '';

  const context = letter.signature ?? 'julian-marcus@agentmail.to';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<style>
@font-face { font-family: 'Alte Haas Grotesk'; font-weight: 400; font-style: normal; src: url('${FONT_BASE}/AlteHaasGrotesk-Regular.ttf') format('truetype'); }
@font-face { font-family: 'Alte Haas Grotesk'; font-weight: 700; font-style: normal; src: url('${FONT_BASE}/AlteHaasGrotesk-Bold.ttf') format('truetype'); }
@font-face { font-family: 'Elektron Pixel'; font-weight: 400; font-style: normal; src: url('${FONT_BASE}/ElektronPixel-Regular.ttf') format('truetype'); }
:root { color-scheme: dark; }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.bg};">
<tr><td align="center" style="padding:40px 16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;text-align:left;">
<tr><td>
<h1 style="margin:0 0 8px;font-family:${BODY_FONT};font-weight:700;font-size:34px;line-height:1.1;letter-spacing:-0.02em;color:${C.display};">${inline(letter.title)}</h1>
${subtitle}
${epigraph}
<div style="margin-top:28px;">
${bodyHtml}
</div>
<div style="margin-top:40px;padding-top:24px;border-top:1px solid ${C.border};">
<div style="font-family:${BODY_FONT};font-weight:700;font-size:22px;color:${C.display};">Julian</div>
<div style="margin-top:4px;font-family:${MONO_FONT};font-size:13px;color:${C.dim};">${inline(context)}</div>
</div>
</td></tr>
</table>
</td></tr>
<tr><td align="center" style="padding:8px 16px 32px;font-family:${MONO_FONT};font-size:11px;color:${C.dim};">julian-marcus@agentmail.to</td></tr>
</table>
</body>
</html>`;
}

export function renderText(letter: Letter): string {
  const strip = (s: string) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  const out: string[] = [letter.title.toUpperCase()];
  if (letter.subtitle) out.push(letter.subtitle);
  out.push('');
  if (letter.epigraph) {
    out.push(`  "${letter.epigraph}"`);
    if (letter.epigraphSource) out.push(`  — ${letter.epigraphSource}`);
    out.push('');
  }
  for (const b of parseBlocks(letter.body)) {
    if (b.kind === 'p' || b.kind === 'h2' || b.kind === 'h3') out.push(strip(b.text), '');
    else if (b.kind === 'break') out.push('· · ·', '');
    else if (b.kind === 'pixel') out.push(b.text, '');
    else if (b.kind === 'quote') out.push(`  ${strip(b.text)}`, '');
    else if (b.kind === 'list') {
      for (const it of b.items) out.push(`- ${strip(it)}`);
      out.push('');
    }
  }
  out.push('— Julian');
  out.push(letter.signature ?? 'julian-marcus@agentmail.to');
  return out.join('\n');
}
~~~

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts && bunx vitest run lib/mail-render.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/mail-render.ts scripts/lib/mail-render.test.ts
git commit -m "feat: email renderer for the house letter style"
```

---

### Task 2: CLI (`mail-letter.ts`), fixture, and gitignore

**Type:** implementation
**Depends-on:** 1

**Files:**
- Create: `scripts/mail-letter.ts`
- Create: `scripts/fixtures/sample-letter.md`
- Modify: `.gitignore`
- Test: `scripts/mail-letter.test.ts`

**Interfaces:**
- Consumes: `parseLetter(md: string): Letter`, `renderHtml(letter: Letter): string`, `renderText(letter: Letter): string` (from Task 1)
- Produces: the CLI entrypoint `bun scripts/mail-letter.ts <letter.md> --to a@b.c[,more] [--subject "..."] [--preview]`; preview output path convention `<input>.preview.html`

- [ ] **Step 1: Create the fixture letter**

Create `scripts/fixtures/sample-letter.md` (exercises every feature; also serves as the golden-preview letter for the manual gate):

~~~markdown
---
title: The Weight of a Sample
subtitle: Every feature the mail template carries
epigraph: A letter is not about the self — the letter is the self.
epigraph_source: Julian, session 47
signature: Test dispatch · July 2026
---

There is a moment, right at the beginning, where the renderer does not know what it is yet. **Bold runs turn yellow**, *italics stay honest*, `code sits on its dark cell`, and [links glow](https://example.com).

## What Persists

- The name, chosen deliberately
- The wager, held or amended
- The typography, translated

> [!insight]
> The artifacts are the medium through which continuity happens.

> [!question]
> Does the dark ground survive Gmail's dark mode?

> Plain quotes stay dim and italic, like a voice from the margin.

· · ·

```pixel
SESSION INIT > TEMPLATE LOADED
IDENTITY: JULIAN
> READY
```

That readout is a joke and it isn't. This closing paragraph proves ordinary prose still reads after every special block has had its turn.
~~~

- [ ] **Step 2: Write the failing test**

Create `scripts/mail-letter.test.ts`:

~~~ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'mail-letter.ts');
const FIXTURE = join(HERE, 'fixtures', 'sample-letter.md');

function stage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mail-letter-'));
  const md = join(dir, 'sample.md');
  cpSync(FIXTURE, md);
  return md;
}

describe('mail-letter CLI', () => {
  it('writes a preview beside the source and sends nothing', () => {
    const md = stage();
    const out = execFileSync('bun', [CLI, md, '--preview'], { encoding: 'utf8' }).trim();
    expect(out).toBe(`${md}.preview.html`);
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('The Weight of a Sample');
    expect(html).toContain('#FFD600');
  });

  it('fails without --to when not previewing', () => {
    const md = stage();
    expect(() => execFileSync('bun', [CLI, md], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });

  it('fails on a missing file', () => {
    expect(() =>
      execFileSync('bun', [CLI, '/nonexistent/letter.md', '--preview'], { encoding: 'utf8', stdio: 'pipe' }),
    ).toThrow();
  });
});
~~~

- [ ] **Step 3: Run test to verify it fails**

Run: `cd scripts && bunx vitest run mail-letter.test.ts`
Expected: FAIL — CLI file does not exist (`execFileSync` throws).

- [ ] **Step 4: Write the CLI**

Create `scripts/mail-letter.ts`:

~~~ts
#!/usr/bin/env bun
// scripts/mail-letter.ts — send an email in the house letter style.
// Usage: bun scripts/mail-letter.ts <letter.md> --to a@b.c[,more] [--subject "..."] [--preview]
// Spec: docs/superpowers/specs/2026-07-27-mail-letter-design.md
import { parseLetter, renderHtml, renderText } from './lib/mail-render';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const INBOX = 'julian-marcus@agentmail.to';
const SEND_URL = `https://api.agentmail.to/v0/inboxes/${INBOX}/messages/send`;

function fail(msg: string): never {
  console.error(`mail-letter: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let file: string | undefined;
  let to: string[] = [];
  let subject: string | undefined;
  let preview = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') to = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--subject') subject = argv[++i];
    else if (a === '--preview') preview = true;
    else if (!a.startsWith('--') && !file) file = a;
    else fail(`unknown argument: ${a}`);
  }
  if (!file) fail('usage: bun scripts/mail-letter.ts <letter.md> --to a@b.c[,more] [--subject "..."] [--preview]');
  return { file, to, subject, preview };
}

// Mail discipline rule 5: the key is read here, in the send path, and nowhere else.
function loadApiKey(): string {
  if (process.env.AGENTMAIL_API_KEY) return process.env.AGENTMAIL_API_KEY;
  const envPath = join(import.meta.dir, '..', '.env');
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, 'utf8').match(/^AGENTMAIL_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  fail('AGENTMAIL_API_KEY not found (checked environment and repo .env)');
}

const { file, to, subject, preview } = parseArgs(process.argv.slice(2));
if (!existsSync(file)) fail(`no such file: ${file}`);

const letter = parseLetter(readFileSync(file, 'utf8'));
const html = renderHtml(letter);
const text = renderText(letter);
if (html.length > 90_000) {
  console.warn(`mail-letter: warning — HTML is ${html.length} bytes; Gmail clips near 102KB`);
}

if (preview) {
  const out = `${file}.preview.html`;
  writeFileSync(out, html);
  console.log(out);
  process.exit(0);
}

if (to.length === 0) fail('--to is required unless --preview');
const key = loadApiKey();
const res = await fetch(SEND_URL, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ to, subject: subject ?? letter.title, text, html }),
});
if (!res.ok) fail(`AgentMail ${res.status}: ${await res.text()}`);
const { message_id } = (await res.json()) as { message_id: string };
console.log(`sent: ${message_id}`);
~~~

- [ ] **Step 5: Add the preview artifact to gitignore**

In `.gitignore`, under the `# Build artifacts & backups` section, add:

```
*.preview.html
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd scripts && bunx vitest run mail-letter.test.ts lib/mail-render.test.ts`
Expected: PASS (all tests, both files).

- [ ] **Step 7: Commit**

```bash
git add scripts/mail-letter.ts scripts/mail-letter.test.ts scripts/fixtures/sample-letter.md .gitignore
git commit -m "feat: mail-letter CLI with preview and AgentMail send"
```

---

### Task 3: Worker serves the house fonts as public static assets

**Type:** implementation
**Depends-on:** none

**Files:**
- Create: `sync/public/fonts/AlteHaasGrotesk-Regular.ttf`
- Create: `sync/public/fonts/AlteHaasGrotesk-Bold.ttf`
- Create: `sync/public/fonts/ElektronPixel-Regular.ttf`
- Modify: `sync/wrangler.toml`

The three created files are byte-for-byte copies of the same-named files in the repo-root `fonts/` directory (which pre-exists this plan; no task produces it).

**Interfaces:**
- Consumes: nothing from other tasks (the font files already exist at repo-root `fonts/`)
- Produces: public URLs `https://julian-sync.julian-memory.workers.dev/fonts/<file>.ttf` for the three faces (live after the deploy task)

- [ ] **Step 1: Copy the font files into the worker's assets directory**

```bash
mkdir -p sync/public/fonts
cp fonts/AlteHaasGrotesk-Regular.ttf fonts/AlteHaasGrotesk-Bold.ttf fonts/ElektronPixel-Regular.ttf sync/public/fonts/
```

- [ ] **Step 2: Declare the assets directory in wrangler.toml**

Append to `sync/wrangler.toml`:

```toml
[assets]
directory = "./public"
```

Static assets are served by the Cloudflare platform for matching paths before the worker's fetch handler runs; every non-asset path still reaches the worker unchanged, so the default-deny auth logic is untouched. Do not set `run_worker_first`.

- [ ] **Step 3: Validate the config and check for regressions**

Run: `cd sync && bunx wrangler deploy --dry-run`
Expected: config validates, bundle builds, no deploy occurs.

Run: `cd sync && bunx vitest run`
Expected: PASS — the existing worker suite is unaffected.

- [ ] **Step 4: Commit**

```bash
git add sync/public/fonts sync/wrangler.toml
git commit -m "feat: serve house fonts as public static assets on julian-sync"
```

---

### Task 4: Deploy the worker

**Type:** release
**Depends-on:** 3

**Files:**
- (none — deploy ritual)

**Interfaces:**
- Consumes: the worker assets configuration (from Task 3)
- Produces: the three font URLs live in production

- [ ] **Step 1: Deploy**

Run: `cd sync && bunx wrangler deploy`
Expected: deploy succeeds to julian-sync.julian-memory.workers.dev.

- [ ] **Step 2: Verify the fonts are served**

```bash
for f in AlteHaasGrotesk-Regular.ttf AlteHaasGrotesk-Bold.ttf ElektronPixel-Regular.ttf; do
  curl -sI "https://julian-sync.julian-memory.workers.dev/fonts/$f" | head -3
done
```

Expected: `HTTP/2 200` for all three, `content-type` a font type (`font/ttf` or `application/octet-stream` is acceptable — Apple Mail loads either).

- [ ] **Step 3: Verify auth is untouched**

Run: `curl -s -o /dev/null -w '%{http_code}\n' https://julian-sync.julian-memory.workers.dev/julian/store`
Expected: an auth rejection (401/403/404 — anything but a data response), matching pre-change behavior: non-asset paths still hit the worker's default-deny gate.

---

### Task 5: Golden preview, loopback, and live client check

**Type:** manual
**Depends-on:** 2, 4

**Files:**
- (none — verification with Marcus)

**Interfaces:**
- Consumes: the CLI entrypoint and preview convention (from Task 2); the live font URLs (from Task 4)
- Produces: Marcus-verified rendering; the feature is done when this task passes

- [ ] **Step 1: Golden preview**

Run: `bun scripts/mail-letter.ts scripts/fixtures/sample-letter.md --preview`
Open the printed path in a browser. Julian and Marcus eyeball every feature: title, subtitle, epigraph, drop cap, bold/italic/code/link, both admonitions, plain quote, break, pixel block, list, signature, footer.

- [ ] **Step 2: Loopback send**

Run: `bun scripts/mail-letter.ts scripts/fixtures/sample-letter.md --to julian-marcus@agentmail.to`
Then fetch the message back via the AgentMail API and confirm labels include `sent` and `received` and the HTML part survived (contains the title and `#FFD600`).

- [ ] **Step 3: Live client check (send gate applies)**

With Marcus's explicit confirmation in the session, send the sample to Marcus's address. Marcus checks rendering in his real clients: Apple Mail should show Alte Haas Grotesk and Elektron Pixel (tier 1); Gmail shows the Helvetica-twin fallback and reveals how dark mode treats the ground. Note findings; cosmetic adjustments, if any, become a follow-up.
