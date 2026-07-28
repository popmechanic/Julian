import { describe, expect, test } from 'bun:test';

async function run(...args: string[]): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(['bun', 'scripts/julianscreen.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  return { out, code: await p.exited };
}

describe('julianscreen CLI (ELF self-documenting binary)', () => {
  test('--agent-doc emits markdown documentation', async () => {
    const { out, code } = await run('--agent-doc');
    expect(code).toBe(0);
    expect(out).toContain('JulianScreen');
    expect(out).toContain('FACE');
  });
  test('--actions lists one action per line', async () => {
    const { out, code } = await run('--actions');
    expect(code).toBe(0);
    const lines = out.trim().split('\n');
    expect(lines).toContain('face');
    expect(lines).toContain('draw');
    expect(lines).toContain('clear');
  });
});
