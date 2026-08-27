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

const FONT_BASE = 'https://sync.julian.soul.store/fonts';
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
  // Placeholder-protect code spans first so the bold/italic/link regexes
  // below never rewrite markdown-looking characters that live inside them.
  const codes: string[] = [];
  // Percent-encoded characters survive the link regex, and browsers decode them
  // before evaluating a javascript: URL — so decode before deciding, and treat
  // an undecodable href as unsafe.
  const isSafeHref = (href: string): boolean => {
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      return false;
    }
    const scheme = decoded.trim().toLowerCase();
    if (/^(https?:|mailto:)/.test(scheme)) return true;
    // Relative and anchor links carry no scheme and cannot execute.
    return !/^[a-z0-9.+-]*:/i.test(scheme) && !scheme.startsWith('//');
  };

  let out = s.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = codes.length;
    codes.push(code);
    return `\x00${idx}\x00`;
  });
  out = esc(out);
  out = out.replace(/\*\*([^*]+)\*\*/g, `<strong style="color:${C.display};">$1</strong>`);
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) =>
    isSafeHref(href)
      ? `<a href="${href}" style="color:${C.display};text-decoration:underline;">${label}</a>`
      // A letter may quote hostile inbound mail, and --preview opens the result
      // in a real browser from file://. Anything not on the allowlist stays text.
      : match,
  );
  out = out.replace(/\x00(\d+)\x00/g, (_match, idxStr: string) => {
    const code = esc(codes[Number(idxStr)] ?? '');
    return `<code style="font-family:${MONO_FONT};font-size:14px;color:${C.display};background-color:${C.surface};padding:1px 5px;border:1px solid ${C.border};border-radius:3px;">${code}</code>`;
  });
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
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i++; continue; }
    if (line.startsWith('```')) {
      // Any fenced block (``` or ```lang, e.g. ```pixel, ```bash) is consumed
      // and rendered with the same monospace terminal-voice treatment.
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      if (i < lines.length) i++; // consume the closing fence if present; tolerate unterminated fences
      blocks.push({ kind: 'pixel', text: buf.join('\n') });
      continue;
    }
    if (line === '· · ·') { blocks.push({ kind: 'break' }); i++; continue; }
    if (line.startsWith('### ')) { blocks.push({ kind: 'h3', text: line.slice(4) }); i++; continue; }
    if (line.startsWith('## ')) { blocks.push({ kind: 'h2', text: line.slice(3) }); i++; continue; }
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      let variant: 'plain' | 'insight' | 'question' = 'plain';
      if (buf[0] === '[!insight]') { variant = 'insight'; buf.shift(); }
      else if (buf[0] === '[!question]') { variant = 'question'; buf.shift(); }
      blocks.push({ kind: 'quote', variant, text: buf.join(' ').trim() });
      continue;
    }
    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('- ')) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    if (buf.length === 0) {
      // Defensive: the paragraph fallback must always advance i, even if some
      // future block-start rule causes it to admit nothing on the first line.
      buf.push(lines[i++]);
    }
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
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${C.bg};">
<tr><td align="center" style="padding:40px 16px 48px;">
<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px;margin:0 auto;text-align:left;">
<tr><td>
<img src="https://sync.julian.soul.store/face.gif" width="250" height="250" alt="· Julian ·" style="display:block;margin:0 auto 28px;width:250px;height:250px;border:0;color:${C.dim};font-family:${MONO_FONT};text-align:center;">
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
</td></tr></table>
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
