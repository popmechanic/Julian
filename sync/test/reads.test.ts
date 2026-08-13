// sync/test/reads.test.ts — pure stream read verbs, tested without a DO or
// a socket (the pure-function seam). Every case is built against a real
// MergeableStore (createStreamStore) seeded via setRow, matching the
// shared/schema.test.ts and sync/test/export.test.ts seeding pattern.
import { describe, expect, test } from 'vitest';
import { createStreamStore } from 'julian-shared/schema';
import { READ_MAX_ROWS, READ_MAX_BYTES, readRecent, readSession, readSearch } from '../src/reads';

function seed(store: ReturnType<typeof createStreamStore>, id: string, row: {
  sessionId: string; role: string; speakerName: string; text: string; ts: number; kind?: string;
}) {
  store.setRow('messages', id, {
    sessionId: row.sessionId, role: row.role, speakerName: row.speakerName,
    text: row.text, ts: row.ts, kind: row.kind ?? 'chat',
  });
}

describe('readRecent', () => {
  test('sorted ascending by ts, and rows carry text only (never a content array)', () => {
    const store = createStreamStore('t1');
    seed(store, 'm2', { sessionId: 's1', role: 'assistant', speakerName: 'Julian', text: 'second', ts: 20 });
    seed(store, 'm1', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'first', ts: 10 });
    seed(store, 'm3', { sessionId: 's2', role: 'user', speakerName: 'Marcus', text: 'third', ts: 30 });

    const { rows, truncated } = readRecent(store);
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.text)).toEqual(['first', 'second', 'third']);
    expect(rows.map((r) => r.ts)).toEqual([10, 20, 30]);
    for (const r of rows) {
      expect(r).toEqual({
        id: expect.any(String), sessionId: expect.any(String), role: expect.any(String),
        speakerName: expect.any(String), text: expect.any(String), ts: expect.any(Number), kind: expect.any(String),
      });
      expect((r as unknown as { content?: unknown }).content).toBeUndefined();
    }
  });

  test('limit clamps to the last N messages (most recent, still ascending on return)', () => {
    const store = createStreamStore('t2');
    for (let i = 0; i < 10; i++) {
      seed(store, `m${i}`, { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: `msg${i}`, ts: i });
    }
    const { rows, truncated } = readRecent(store, 3);
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.text)).toEqual(['msg7', 'msg8', 'msg9']);
  });

  test('a caller-supplied limit above READ_MAX_ROWS is clamped server-side', () => {
    const store = createStreamStore('t3');
    for (let i = 0; i < 5; i++) {
      seed(store, `m${i}`, { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: `msg${i}`, ts: i });
    }
    const { rows } = readRecent(store, READ_MAX_ROWS + 1000);
    expect(rows).toHaveLength(5);
  });

  test('byte cap: a large row plus others triggers truncation without splitting a row', () => {
    const store = createStreamStore('t4');
    const big = 'x'.repeat(90_000);
    seed(store, 'm1', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: big, ts: 10 });
    seed(store, 'm2', { sessionId: 's1', role: 'assistant', speakerName: 'Julian', text: big, ts: 20 });
    seed(store, 'm3', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: big, ts: 30 });

    const { rows, truncated } = readRecent(store);
    expect(truncated).toBe(true);
    // No row is ever half-serialized — every returned row's own text is intact.
    for (const r of rows) {
      expect(r.text === big || r.text === '').toBe(true);
      expect(r.text.length === 0 || r.text.length === big.length).toBe(true);
    }
    const totalBytes = rows.reduce((n, r) => n + new TextEncoder().encode(JSON.stringify(r)).length, 0);
    expect(totalBytes).toBeLessThanOrEqual(READ_MAX_BYTES);
    // The most recent row (m3, ts 30) is preferred over the oldest when the budget is tight.
    expect(rows.some((r) => r.ts === 30)).toBe(true);
  });

  test('no messages → empty, not truncated', () => {
    const store = createStreamStore('t5');
    expect(readRecent(store)).toEqual({ rows: [], truncated: false });
  });
});

describe('readSession', () => {
  test('filters by sessionId and an inclusive ts range, ascending', () => {
    const store = createStreamStore('t6');
    seed(store, 'm1', { sessionId: 'a', role: 'user', speakerName: 'Marcus', text: 'a1', ts: 10 });
    seed(store, 'm2', { sessionId: 'a', role: 'assistant', speakerName: 'Julian', text: 'a2', ts: 20 });
    seed(store, 'm3', { sessionId: 'a', role: 'user', speakerName: 'Marcus', text: 'a3', ts: 30 });
    seed(store, 'm4', { sessionId: 'b', role: 'user', speakerName: 'Marcus', text: 'b1', ts: 15 });

    const { rows } = readSession(store, 'a');
    expect(rows.map((r) => r.text)).toEqual(['a1', 'a2', 'a3']);

    const ranged = readSession(store, 'a', { from: 15, to: 25 });
    expect(ranged.rows.map((r) => r.text)).toEqual(['a2']);

    const fromOnly = readSession(store, 'a', { from: 20 });
    expect(fromOnly.rows.map((r) => r.text)).toEqual(['a2', 'a3']);

    const toOnly = readSession(store, 'a', { to: 20 });
    expect(toOnly.rows.map((r) => r.text)).toEqual(['a1', 'a2']);
  });

  test('unknown session → empty, not truncated', () => {
    const store = createStreamStore('t7');
    seed(store, 'm1', { sessionId: 'a', role: 'user', speakerName: 'Marcus', text: 'a1', ts: 10 });
    expect(readSession(store, 'nope')).toEqual({ rows: [], truncated: false });
  });
});

describe('readSearch', () => {
  test('case-insensitive substring match on text, newest first', () => {
    const store = createStreamStore('t8');
    seed(store, 'm1', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'the Sky is blue', ts: 10 });
    seed(store, 'm2', { sessionId: 's1', role: 'assistant', speakerName: 'Julian', text: 'grass is green', ts: 20 });
    seed(store, 'm3', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'SKYLINE view', ts: 30 });

    const { rows, truncated } = readSearch(store, 'sky');
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.text)).toEqual(['SKYLINE view', 'the Sky is blue']); // newest first
  });

  test('a regex-metacharacter query matches only its literal text (no caller-supplied regex, ever)', () => {
    const store = createStreamStore('t9');
    seed(store, 'm1', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'a.*b literally here', ts: 10 });
    seed(store, 'm2', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'aXXXXb should not match', ts: 20 });

    const { rows } = readSearch(store, 'a.*b');
    expect(rows.map((r) => r.text)).toEqual(['a.*b literally here']);
  });

  test('limit clamps result count', () => {
    const store = createStreamStore('t10');
    for (let i = 0; i < 5; i++) {
      seed(store, `m${i}`, { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'match me', ts: i });
    }
    const { rows } = readSearch(store, 'match', 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ts)).toEqual([4, 3]); // newest first
  });

  test('no match → empty, not truncated', () => {
    const store = createStreamStore('t11');
    seed(store, 'm1', { sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'hello', ts: 10 });
    expect(readSearch(store, 'nowhere-to-be-found')).toEqual({ rows: [], truncated: false });
  });
});
