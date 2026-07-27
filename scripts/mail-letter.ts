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
let res: Response;
try {
  res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject: subject ?? letter.title, text, html }),
  });
} catch (err) {
  fail(`send failed: ${err}`);
}
if (!res.ok) fail(`AgentMail ${res.status}: ${await res.text()}`);
let body: { message_id?: string };
const raw = await res.text();
try {
  body = JSON.parse(raw) as { message_id?: string };
} catch (err) {
  fail(`send failed: could not parse AgentMail response: ${err}`);
}
if (body.message_id) console.log(`sent: ${body.message_id}`);
else console.log(`sent: ${raw}`);
