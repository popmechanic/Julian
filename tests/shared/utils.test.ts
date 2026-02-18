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
  stabilizeDocsByKey,
  deriveStableAgents,
  AGENT_SIGNIFICANT_FIELDS,
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

describe('stabilizeDocsByKey', () => {
  const keyFn = (doc: any) => doc._id;
  const fields = ['name', 'status'];

  test('returns same array reference when docs are unchanged', () => {
    const docA = { _id: '1', name: 'Lyra', status: 'alive', lastAliveAt: 100 };
    const docB = { _id: '2', name: 'Cael', status: 'alive', lastAliveAt: 200 };
    const prev = [docA, docB];

    // next has same significant fields but different objects
    const next = [
      { _id: '1', name: 'Lyra', status: 'alive', lastAliveAt: 999 },
      { _id: '2', name: 'Cael', status: 'alive', lastAliveAt: 999 },
    ];

    const result = stabilizeDocsByKey(prev, next, keyFn, fields);
    expect(result).toBe(prev); // same reference
  });

  test('returns new references only for changed items', () => {
    const docA = { _id: '1', name: 'Lyra', status: 'alive' };
    const docB = { _id: '2', name: 'Cael', status: 'alive' };
    const prev = [docA, docB];

    const newDocB = { _id: '2', name: 'Cael', status: 'sleeping' };
    const next = [
      { _id: '1', name: 'Lyra', status: 'alive' },
      newDocB,
    ];

    const result = stabilizeDocsByKey(prev, next, keyFn, fields);
    expect(result).not.toBe(prev); // different array
    expect(result[0]).toBe(docA);  // unchanged item reuses prev reference
    expect(result[1]).toBe(newDocB); // changed item uses new reference
  });

  test('heartbeat-only field changes do not change references when not in significantFields', () => {
    const docA = { _id: '1', name: 'Lyra', status: 'alive', lastAliveAt: 100 };
    const prev = [docA];

    const next = [{ _id: '1', name: 'Lyra', status: 'alive', lastAliveAt: 999 }];

    const result = stabilizeDocsByKey(prev, next, keyFn, fields);
    expect(result).toBe(prev);
    expect(result[0]).toBe(docA);
  });

  test('meaningful field changes update affected item references', () => {
    const docA = { _id: '1', name: 'Lyra', status: 'alive' };
    const prev = [docA];

    const newDoc = { _id: '1', name: 'Lyra', status: 'sleeping' };
    const next = [newDoc];

    const result = stabilizeDocsByKey(prev, next, keyFn, fields);
    expect(result).not.toBe(prev);
    expect(result[0]).toBe(newDoc);
  });

  test('handles empty arrays', () => {
    const prev: any[] = [];
    const next: any[] = [];

    const result = stabilizeDocsByKey(prev, next, keyFn, fields);
    expect(result).toBe(prev); // same reference for empty-to-empty
  });

  test('handles null/undefined prev', () => {
    const next = [{ _id: '1', name: 'Lyra', status: 'alive' }];

    const resultNull = stabilizeDocsByKey(null, next, keyFn, fields);
    expect(resultNull).toEqual(next);

    const resultUndef = stabilizeDocsByKey(undefined, next, keyFn, fields);
    expect(resultUndef).toEqual(next);
  });

  test('handles added/removed docs', () => {
    const docA = { _id: '1', name: 'Lyra', status: 'alive' };
    const docB = { _id: '2', name: 'Cael', status: 'alive' };
    const prev = [docA, docB];

    // docB removed, docC added
    const docC = { _id: '3', name: 'Nova', status: 'alive' };
    const next = [
      { _id: '1', name: 'Lyra', status: 'alive' },
      docC,
    ];

    const result = stabilizeDocsByKey(prev, next, keyFn, fields);
    expect(result).not.toBe(prev);
    expect(result[0]).toBe(docA);  // unchanged, reuses prev ref
    expect(result[1]).toBe(docC);  // new doc, new ref
  });

  test('preserves order', () => {
    const docA = { _id: '1', name: 'Lyra', status: 'alive' };
    const docB = { _id: '2', name: 'Cael', status: 'alive' };
    const prev = [docA, docB];

    // Reversed order in next
    const next = [
      { _id: '2', name: 'Cael', status: 'alive' },
      { _id: '1', name: 'Lyra', status: 'alive' },
    ];

    const result = stabilizeDocsByKey(prev, next, keyFn, fields);
    // Order follows next, but references come from prev
    expect(result).not.toBe(prev); // different because order changed
    expect(result[0]).toBe(docB);  // Cael from prev
    expect(result[1]).toBe(docA);  // Lyra from prev
  });
});

describe('deriveStableAgents', () => {
  test('returns same array reference when agents unchanged', () => {
    const agentA = { name: 'Lyra', status: 'alive', gridPosition: 0, color: '#c9b1e8', colorName: 'Violet Heaven', gender: 'woman', _status: 'alive' } as any;
    const agentB = { name: 'Cael', status: 'alive', gridPosition: 1, color: '#755d00', colorName: 'Ayahuasca Vine', gender: 'man', _status: 'alive' } as any;
    const prevAgents = [agentA, agentB];

    // Docs are same significant fields but different objects (simulating Fireproof re-emit)
    const docs = [
      { name: 'Lyra', status: 'alive', gridPosition: 0, color: '#c9b1e8', colorName: 'Violet Heaven', gender: 'woman', lastAliveAt: 999 },
      { name: 'Cael', status: 'alive', gridPosition: 1, color: '#755d00', colorName: 'Ayahuasca Vine', gender: 'man', lastAliveAt: 999 },
    ];

    const result = deriveStableAgents(prevAgents, docs);
    expect(result).toBe(prevAgents); // same reference
  });

  test('updates only changed agent references', () => {
    const agentA = { name: 'Lyra', status: 'alive', gridPosition: 0, color: '#c9b1e8', colorName: 'Violet Heaven', gender: 'woman', _status: 'alive' } as any;
    const agentB = { name: 'Cael', status: 'alive', gridPosition: 1, color: '#755d00', colorName: 'Ayahuasca Vine', gender: 'man', _status: 'alive' } as any;
    const prevAgents = [agentA, agentB];

    const docs = [
      { name: 'Lyra', status: 'alive', gridPosition: 0, color: '#c9b1e8', colorName: 'Violet Heaven', gender: 'woman' },
      { name: 'Cael', status: 'sleeping', gridPosition: 1, color: '#755d00', colorName: 'Ayahuasca Vine', gender: 'man' },
    ];

    const result = deriveStableAgents(prevAgents, docs);
    expect(result).not.toBe(prevAgents);
    expect(result[0]).toBe(agentA);     // unchanged
    expect(result[1]).not.toBe(agentB); // status changed
    expect(result[1]._status).toBe('sleeping');
  });

  test('status field changes cause reference update', () => {
    const agentA = { name: 'Lyra', status: 'alive', gridPosition: 0, color: '#c9b1e8', colorName: 'Violet Heaven', gender: 'woman', _status: 'alive' } as any;
    const prevAgents = [agentA];

    const docs = [
      { name: 'Lyra', status: 'sleeping', gridPosition: 0, color: '#c9b1e8', colorName: 'Violet Heaven', gender: 'woman' },
    ];

    const result = deriveStableAgents(prevAgents, docs);
    expect(result).not.toBe(prevAgents);
    expect(result[0]).not.toBe(agentA);
    expect(result[0]._status).toBe('sleeping');
    expect(result[0].status).toBe('sleeping');
  });

  test('non-significant field changes do not cause reference update', () => {
    const agentA = { name: 'Lyra', status: 'alive', gridPosition: 0, color: '#c9b1e8', colorName: 'Violet Heaven', gender: 'woman', _status: 'alive', lastAliveAt: 100 } as any;
    const prevAgents = [agentA];

    const docs = [
      { name: 'Lyra', status: 'alive', gridPosition: 0, color: '#c9b1e8', colorName: 'Violet Heaven', gender: 'woman', lastAliveAt: 999 },
    ];

    const result = deriveStableAgents(prevAgents, docs);
    expect(result).toBe(prevAgents); // same reference — lastAliveAt is not significant
  });

  test('handles empty input', () => {
    const prevAgents = [{ name: 'Lyra', _status: 'alive' }] as any[];
    const result = deriveStableAgents(prevAgents, []);
    expect(result).toEqual([]);
  });

  test('returns empty array for null docs', () => {
    const result = deriveStableAgents(null as any, null as any);
    expect(result).toEqual([]);
  });
});
