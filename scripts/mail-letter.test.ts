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
    try {
      execFileSync('bun', [CLI, md], { encoding: 'utf8', stdio: 'pipe' });
      expect.unreachable('expected the CLI to exit non-zero');
    } catch (err) {
      expect((err as { stderr: string }).stderr).toContain('--to is required unless --preview');
    }
  });

  it('fails on a missing file', () => {
    try {
      execFileSync('bun', [CLI, '/nonexistent/letter.md', '--preview'], { encoding: 'utf8', stdio: 'pipe' });
      expect.unreachable('expected the CLI to exit non-zero');
    } catch (err) {
      expect((err as { stderr: string }).stderr).toContain('no such file:');
    }
  });
});
