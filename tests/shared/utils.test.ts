import { describe, expect, test } from 'bun:test';
import {
  escapeHtml,
  truncate,
  renderMarkdown,
  formatToolInput,
  EYE_KEYS,
  MOUTH_KEYS,
  hashNameToFaceVariant,
  getAgentStatus,
  bumpDbName,
  classifyHatchingAgent,
  deriveGridButtons,
} from '../../shared/utils.js';

describe('escapeHtml', () => {
  test('escapes < and >', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  test('escapes double quotes', () => {
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
  });

  test('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#039;s');
  });

  test('escapes ampersand', () => {
    expect(escapeHtml('&')).toBe('&amp;');
  });

  test('escapes all 5 entities in one string', () => {
    expect(escapeHtml('<div class="a" data-x=\'b\'>&</div>')).toBe(
      '&lt;div class=&quot;a&quot; data-x=&#039;b&#039;&gt;&amp;&lt;/div&gt;'
    );
  });

  test('returns empty string for null', () => {
    expect(escapeHtml(null as any)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(escapeHtml(undefined as any)).toBe('');
  });

  test('returns empty string for number', () => {
    expect(escapeHtml(42 as any)).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('truncate', () => {
  test('string under limit is unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  test('string at exact limit is unchanged', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  test('string over limit is truncated with ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hello\u2026');
  });

  test('returns empty string for non-string input', () => {
    expect(truncate(123 as any, 10)).toBe('');
  });

  test('returns empty string for null', () => {
    expect(truncate(null as any, 10)).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(truncate('', 10)).toBe('');
  });
});

describe('renderMarkdown', () => {
  test('renders fenced code block', () => {
    const input = '```js\nconst x = 1;\n```';
    const result = renderMarkdown(input);
    expect(result).toContain('<pre');
    expect(result).toContain('<code>');
    expect(result).toContain('const x = 1;');
  });

  test('renders inline code', () => {
    const result = renderMarkdown('use `npm install`');
    expect(result).toContain('<code');
    expect(result).toContain('npm install');
  });

  test('renders bold text', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });

  test('renders italic text', () => {
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
  });

  test('converts newlines to <br>', () => {
    expect(renderMarkdown('line1\nline2')).toContain('line1<br>line2');
  });

  test('escapes script tags (XSS prevention)', () => {
    const result = renderMarkdown("<script>alert('xss')</script>");
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  test('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  test('returns empty string for null', () => {
    expect(renderMarkdown(null as any)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(renderMarkdown(undefined as any)).toBe('');
  });

  test('handles mixed markdown elements', () => {
    const result = renderMarkdown('**bold** and *italic* and `code`');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
    expect(result).toContain('<code');
  });
});

describe('formatToolInput', () => {
  test('Read tool returns file_path', () => {
    expect(formatToolInput('Read', { file_path: '/src/index.ts' })).toBe('/src/index.ts');
  });

  test('Write tool returns file_path', () => {
    expect(formatToolInput('Write', { file_path: '/src/app.ts' })).toBe('/src/app.ts');
  });

  test('Edit tool returns file_path', () => {
    expect(formatToolInput('Edit', { file_path: '/src/utils.ts' })).toBe('/src/utils.ts');
  });

  test('Bash tool returns $ command', () => {
    expect(formatToolInput('Bash', { command: 'ls -la' })).toBe('$ ls -la');
  });

  test('TaskUpdate returns Task #N with status', () => {
    expect(formatToolInput('TaskUpdate', { taskId: '3', status: 'completed' })).toBe(
      'Task #3 \u2192 completed'
    );
  });

  test('TaskUpdate without status omits arrow', () => {
    expect(formatToolInput('TaskUpdate', { taskId: '3' })).toBe('Task #3');
  });

  test('SendMessage returns arrow + recipient', () => {
    expect(formatToolInput('SendMessage', { recipient: 'Marcus' })).toBe('\u2192 Marcus');
  });

  test('null input returns empty string', () => {
    expect(formatToolInput('Bash', null)).toBe('');
  });

  test('string input returns truncated string', () => {
    expect(formatToolInput('Unknown', 'short string')).toBe('short string');
  });

  test('unknown tool with object returns JSON stringified', () => {
    const result = formatToolInput('Unknown', { foo: 'bar' });
    expect(result).toContain('"foo"');
    expect(result).toContain('"bar"');
  });

  test('Glob tool returns pattern', () => {
    expect(formatToolInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  test('WebSearch returns query', () => {
    expect(formatToolInput('WebSearch', { query: 'bun test runner' })).toBe('bun test runner');
  });
});

describe('hashNameToFaceVariant', () => {
  test('same name produces same result (deterministic)', () => {
    const a = hashNameToFaceVariant('Lyra');
    const b = hashNameToFaceVariant('Lyra');
    expect(a).toEqual(b);
  });

  test('different names produce (likely) different results', () => {
    const a = hashNameToFaceVariant('Lyra');
    const b = hashNameToFaceVariant('Cael');
    // At least one field should differ for distinct names
    const same = a.eyes === b.eyes && a.mouth === b.mouth;
    // This is probabilistic but with 4x4 options very unlikely to collide
    expect(same).toBe(false);
  });

  test('result has valid eyes key', () => {
    const result = hashNameToFaceVariant('TestAgent');
    expect(EYE_KEYS).toContain(result.eyes);
  });

  test('result has valid mouth key', () => {
    const result = hashNameToFaceVariant('TestAgent');
    expect(MOUTH_KEYS).toContain(result.mouth);
  });

  test('EYE_KEYS has expected values', () => {
    expect(EYE_KEYS).toEqual(['standard', 'round', 'narrow', 'wide']);
  });

  test('MOUTH_KEYS has expected values', () => {
    expect(MOUTH_KEYS).toEqual(['gentle', 'straight', 'cheerful', 'asymmetric']);
  });
});

describe('getAgentStatus', () => {
  test('returns status when present', () => {
    expect(getAgentStatus({ status: 'alive' })).toBe('alive');
  });

  test('returns sleeping status', () => {
    expect(getAgentStatus({ status: 'sleeping' })).toBe('sleeping');
  });

  test('returns hatching for legacy docs with hatching=true', () => {
    expect(getAgentStatus({ hatching: true })).toBe('hatching');
  });

  test('returns sleeping for empty doc', () => {
    expect(getAgentStatus({})).toBe('sleeping');
  });

  test('returns sleeping for falsy status (empty string)', () => {
    expect(getAgentStatus({ status: '' })).toBe('sleeping');
  });
});

describe('bumpDbName', () => {
  test('bumps v8 to v9', () => {
    expect(bumpDbName('julian-chat-v8')).toBe('julian-chat-v9');
  });

  test('bumps v1 to v2', () => {
    expect(bumpDbName('julian-chat-v1')).toBe('julian-chat-v2');
  });

  test('adds -v2 when no version suffix', () => {
    expect(bumpDbName('mydb')).toBe('mydb-v2');
  });

  test('bumps v99 to v100', () => {
    expect(bumpDbName('name-v99')).toBe('name-v100');
  });
});

// ── classifyHatchingAgent ────────────────────────────────────────────────

describe('classifyHatchingAgent', () => {
  const TEN_MIN = 10 * 60 * 1000;

  test('named hatching agent → sleeping (immediate, regardless of age)', () => {
    expect(classifyHatchingAgent({ name: 'Lyra' }, 0)).toBe('sleeping');
    expect(classifyHatchingAgent({ name: 'Lyra' }, TEN_MIN + 1)).toBe('sleeping');
    expect(classifyHatchingAgent({ name: 'Cael' }, 1000)).toBe('sleeping');
  });

  test('nameless hatching agent, stale (>10 min) → expired', () => {
    expect(classifyHatchingAgent({}, TEN_MIN + 1)).toBe('expired');
    expect(classifyHatchingAgent({}, TEN_MIN + 60000)).toBe('expired');
  });

  test('nameless hatching agent, fresh (<10 min) → null (no transition)', () => {
    expect(classifyHatchingAgent({}, 0)).toBe(null);
    expect(classifyHatchingAgent({}, TEN_MIN - 1)).toBe(null);
    expect(classifyHatchingAgent({}, 5 * 60 * 1000)).toBe(null);
  });

  test('nameless hatching agent, exactly at threshold → null', () => {
    expect(classifyHatchingAgent({}, TEN_MIN)).toBe(null);
  });

  test('custom stale threshold', () => {
    expect(classifyHatchingAgent({}, 5001, 5000)).toBe('expired');
    expect(classifyHatchingAgent({}, 4999, 5000)).toBe(null);
  });

  test('named agent with empty string name → sleeping', () => {
    // empty string is falsy in JS, so this should be treated as nameless
    expect(classifyHatchingAgent({ name: '' }, TEN_MIN + 1)).toBe('expired');
  });
});

// ── deriveGridButtons ────────────────────────────────────────────────────

describe('deriveGridButtons', () => {
  // Helper: minimal status function matching getAgentStatus
  const status = (doc: any) => getAgentStatus(doc);

  test('fresh ledger (no agents) → showSummon only', () => {
    const result = deriveGridButtons([], status);
    expect(result.showSummon).toBe(true);
    expect(result.showWake).toBe(false);
    expect(result.allAwake).toBe(false);
  });

  test('all agents sleeping → showWake, not showSummon', () => {
    const agents = [
      { name: 'Lyra', status: 'sleeping', gridPosition: 0 },
      { name: 'Cael', status: 'sleeping', gridPosition: 1 },
    ];
    const result = deriveGridButtons(agents, status);
    expect(result.showSummon).toBe(false);
    expect(result.showWake).toBe(true);
    expect(result.allAwake).toBe(false);
  });

  test('all agents alive → allAwake, no buttons', () => {
    const agents = [
      { name: 'Lyra', status: 'alive', gridPosition: 0 },
      { name: 'Cael', status: 'alive', gridPosition: 1 },
    ];
    const result = deriveGridButtons(agents, status);
    expect(result.showSummon).toBe(false);
    expect(result.showWake).toBe(false);
    expect(result.allAwake).toBe(true);
  });

  test('mix of alive and sleeping → showWake', () => {
    const agents = [
      { name: 'Lyra', status: 'alive', gridPosition: 0 },
      { name: 'Cael', status: 'sleeping', gridPosition: 1 },
    ];
    const result = deriveGridButtons(agents, status);
    expect(result.showSummon).toBe(false);
    expect(result.showWake).toBe(true);
    expect(result.allAwake).toBe(false);
  });

  test('only expired agents → showSummon (treated as fresh)', () => {
    const agents = [
      { status: 'expired', gridPosition: 0 },
      { status: 'expired', gridPosition: 1 },
    ];
    const result = deriveGridButtons(agents, status);
    expect(result.showSummon).toBe(true);
    expect(result.showWake).toBe(false);
    expect(result.allAwake).toBe(false);
  });

  test('hatching eggs (nameless, mid-summon) → no button', () => {
    const agents = [
      { status: 'hatching', gridPosition: 0 },
      { status: 'hatching', gridPosition: 1 },
    ];
    const result = deriveGridButtons(agents, status);
    expect(result.showSummon).toBe(false);
    expect(result.showWake).toBe(false);
    expect(result.allAwake).toBe(false);
  });

  test('partial spawn: 3 named sleeping + 5 nameless hatching → showWake', () => {
    const agents = [
      { name: 'Lyra', status: 'sleeping', gridPosition: 0 },
      { name: 'Cael', status: 'sleeping', gridPosition: 1 },
      { name: 'Aria', status: 'sleeping', gridPosition: 2 },
      { status: 'hatching', gridPosition: 3 },
      { status: 'hatching', gridPosition: 5 },
      { status: 'hatching', gridPosition: 6 },
      { status: 'hatching', gridPosition: 7 },
      { status: 'hatching', gridPosition: 8 },
    ];
    const result = deriveGridButtons(agents, status);
    expect(result.showSummon).toBe(false);
    expect(result.showWake).toBe(true);
    expect(result.allAwake).toBe(false);
  });

  test('named expired agents do not count as named (no RESUMMON)', () => {
    // Named agents that somehow got expired — should show SUMMON
    const agents = [
      { name: 'Lyra', status: 'expired', gridPosition: 0 },
    ];
    const result = deriveGridButtons(agents, status);
    expect(result.showSummon).toBe(true);
    expect(result.showWake).toBe(false);
  });

  test('dead state scenario: stale hatching + no named → was broken, now showSummon=false (eggs still visible)', () => {
    // This was the dead state: hatching eggs with no button.
    // Now: nameless hatching → no summon (correct, summoning may still be running)
    const agents = [
      { status: 'hatching', gridPosition: 0 },
      { status: 'hatching', gridPosition: 1 },
    ];
    const result = deriveGridButtons(agents, status);
    expect(result.showSummon).toBe(false);
    expect(result.showWake).toBe(false);
    // After expireStaleHatching runs (>10 min), these become expired → showSummon
  });
});
