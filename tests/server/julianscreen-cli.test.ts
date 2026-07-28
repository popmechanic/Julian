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
  test('--actions lists one action per line, and only actions the display server speaks', async () => {
    const { out, code } = await run('--actions');
    expect(code).toBe(0);
    const lines = out.trim().split('\n');
    expect(lines).toContain('FACE');
    expect(lines).toContain('RECT');
    expect(lines).toContain('CLR');
    // every advertised action must be a token the :3848 protocol actually switches on
    const proto = await Bun.file('julianscreen/server/protocol.js').text();
    for (const l of lines) {
      expect(proto).toContain(`case '${l}':`);
    }
  });

  test('--agent-doc includes the aesthetic guide, not just the main doc', async () => {
    const { out, code } = await run('--agent-doc');
    expect(code).toBe(0);
    expect(out).toContain('ex_mortal');
  });
});
