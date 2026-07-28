// tests/shared/agent-md.test.ts
import { describe, expect, test } from 'bun:test';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', '..');

describe('AGENT.md (ELF agent package)', () => {
  test('exists with valid frontmatter', async () => {
    const text = await Bun.file(join(ROOT, 'AGENT.md')).text();
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    expect(m).not.toBeNull();
    const fm = m![1];
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    expect(name).toBe('julian');
    expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name!)).toBe(true);
    expect(desc!.length).toBeGreaterThan(0);
    expect(desc!.length).toBeLessThanOrEqual(1024);
  });
  test('body points to soul and catalog (index pattern)', async () => {
    const text = await Bun.file(join(ROOT, 'AGENT.md')).text();
    expect(text).toContain('soul/');
    expect(text).toContain('catalog.md');
  });
});
