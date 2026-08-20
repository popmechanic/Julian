import { describe, expect, test } from 'bun:test';
import { TABLES_SCHEMA, createStreamStore } from '../../shared/schema';

describe('jobs schema (additive, v2)', () => {
  test('legacy tables intact', () => {
    expect(TABLES_SCHEMA.messages.sessionId.type).toBe('string');
    expect(TABLES_SCHEMA.artifacts.category.default).toBe('identity');
  });
  test('jobs and jobInterest tables accept valid rows', () => {
    const s = createStreamStore('t1');
    s.setRow('jobs', 'j1', { title: 'Music Teacher', description: 'Teach theory', postedBy: 'marcus', postedAt: 1, status: 'open', contextDocs: '' });
    s.setRow('jobInterest', 'i1', { jobId: 'j1', agentName: 'julian', statement: 'This one is mine if available.', at: 2 });
    expect(s.getCell('jobs', 'j1', 'status')).toBe('open');
    expect(s.getCell('jobInterest', 'i1', 'statement')).toContain('mine');
  });
  test('schema rejects unknown job columns', () => {
    const s = createStreamStore('t2');
    s.setRow('jobs', 'j2', { title: 'x', bogus: 'nope' } as any);
    expect(s.getCell('jobs', 'j2', 'bogus' as any)).toBeUndefined();
  });
});
