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
