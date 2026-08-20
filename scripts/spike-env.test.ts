import { describe, expect, test } from 'vitest';
import { spikeChildEnv } from './spike-claude-resume';

describe('spike hygiene (#25)', () => {
  test('the child env pins CLAUDE_CONFIG_DIR to the sandbox', () => {
    const env = spikeChildEnv('/tmp/spike-sandbox', { HOME: '/Users/op', CLAUDE_CONFIG_DIR: '/Users/op/.claude' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/spike-sandbox');
    expect(env.HOME).toBe('/Users/op'); // everything else passes through
  });

  test('the builder never mutates its input', () => {
    const base = { CLAUDE_CONFIG_DIR: '/Users/op/.claude' };
    spikeChildEnv('/tmp/spike-sandbox', base);
    expect(base.CLAUDE_CONFIG_DIR).toBe('/Users/op/.claude');
  });
});
