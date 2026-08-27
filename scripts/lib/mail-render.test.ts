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
    expect(html).toContain('https://sync.julian.soul.store/fonts/AlteHaasGrotesk-Regular.ttf');
    expect(html).toContain('https://sync.julian.soul.store/fonts/AlteHaasGrotesk-Bold.ttf');
    expect(html).toContain('https://sync.julian.soul.store/fonts/ElektronPixel-Regular.ttf');
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
  it('carries the remaining house color tokens', () => {
    expect(html).toContain('#d4b400');
    expect(html).toContain('#9a7e00');
    expect(html).toContain('#4a3e00');
  });
  it('declares exactly one style block', () => {
    expect(html.match(/<style>/g)?.length).toBe(1);
  });
  it('constrains the single column to the house max-width', () => {
    expect(html).toContain('align="center"');
    expect(html).toContain('margin:0 auto');
    // Gmail strips width ATTRIBUTES but honors width STYLES: the outer table
    // must span via inline style or the whole letter pins left (seen live 2026-07-27).
    expect(html).toContain('style="width:100%;background-color:#0c0c0c;"');
    expect(html).toContain('width:100%;max-width:680px;margin:0 auto');
    // Letterhead face: hosted blinking GIF, centered, with a dignified alt.
    expect(html).toContain('https://sync.julian.soul.store/face.gif');
    expect(html).toContain('alt="· Julian ·"');
    // The footer address line was removed 2026-07-27 (redundant with the signature).
    expect(html.split('sync.julian.soul.store').length - 1).toBe(4); // 3 fonts + 1 face, no other remote refs
  });
  it('renders a non-pixel fence and an indented list item without hanging', () => {
    const md = `---\ntitle: T\n---\n\n\`\`\`bash\necho hi\n\`\`\`\n\n  - indented item\n`;
    const out = renderHtml(parseLetter(md));
    expect(out).toContain('echo hi');
    expect(out).toContain('#0f0e0b');
    expect(out).toContain('indented item');
  });
  it('keeps a literal ** inside a code span, unrewritten by the bold rule', () => {
    const md = '---\ntitle: T\n---\n\nUse `a **b** c` here.';
    const out = renderHtml(parseLetter(md));
    expect(out).toContain('a **b** c');
    expect(out).not.toContain('<strong style="color:#FFD600;">b</strong>');
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

describe('link scheme allowlist', () => {
  const bodyHtml = (md: string) =>
    renderHtml(parseLetter(`---\ntitle: T\n---\n\n${md}\n`));

  it('renders http, https, mailto and relative links as anchors', () => {
    expect(bodyHtml('[a](https://example.com)')).toContain('href="https://example.com"');
    expect(bodyHtml('[a](http://example.com)')).toContain('href="http://example.com"');
    expect(bodyHtml('[a](mailto:x@y.z)')).toContain('href="mailto:x@y.z"');
    expect(bodyHtml('[a](/memory/letter.md)')).toContain('href="/memory/letter.md"');
  });

  it('never turns a script-bearing URL into an anchor, even percent-encoded', () => {
    // A letter may quote hostile inbound mail, and --preview opens the result
    // in a real browser, where percent-escapes are decoded before evaluation.
    for (const href of [
      'javascript:alert(1)',
      'javascript:alert%28document.location%29',
      'JaVaScRiPt:alert%281%29',
      'data:text/html,mischief',
      'vbscript:msgbox(1)',
    ]) {
      const out = bodyHtml(`[click](${href})`);
      expect(out).not.toContain(`href="${href}"`);
      expect(out.toLowerCase()).not.toContain('href="javascript');
      expect(out.toLowerCase()).not.toContain('href="data:');
      expect(out.toLowerCase()).not.toContain('href="vbscript');
    }
  });
});
