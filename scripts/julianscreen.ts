#!/usr/bin/env bun
// julianscreen — ELF self-documenting binary convention (§4) over the :3848 display server.
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const args = process.argv.slice(2);

async function readDoc(rel: string): Promise<string> {
  try {
    return await Bun.file(join(ROOT, rel)).text();
  } catch {
    console.error(`warning: could not read ${rel}`);
    return '';
  }
}

if (args[0] === '--agent-doc') {
  const main = await readDoc('docs/julianscreen.md');
  const aesthetic = await readDoc('docs/julianscreen-aesthetic.md');
  if (!main) {
    console.error('cannot document myself: docs/julianscreen.md is missing or unreadable');
    process.exit(2);
  }
  console.log(`# JulianScreen\n\n${main}\n\n## Aesthetic guide\n\n${aesthetic}`);
  process.exit(0);
}

if (args[0] === '--actions') {
  // Derived from the display server's own parser, so the advertised
  // vocabulary can never drift from what :3848 actually speaks.
  const proto = await readDoc('julianscreen/server/protocol.js');
  const tokens = [...new Set([...proto.matchAll(/^\s*case '([A-Z_]+)':/gm)].map((m) => m[1]))];
  if (tokens.length === 0) {
    console.error('cannot derive actions: julianscreen/server/protocol.js is missing or unreadable');
    process.exit(2);
  }
  console.log(tokens.join('\n'));
  process.exit(0);
}

if (args.length === 0) {
  console.error('usage: julianscreen --agent-doc | --actions | <COMMAND...>   (e.g. julianscreen FACE happy)');
  process.exit(1);
}

const res = await fetch('http://localhost:3848/cmd', { method: 'POST', body: args.join(' ') }).catch((e: Error) => e);
if (res instanceof Error) { console.error(`display server unreachable: ${res.message}`); process.exit(2); }
console.log(await res.text());
process.exit(res.ok ? 0 : 2);
