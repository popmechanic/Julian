import { describe, expect, test } from 'vitest';
import { store } from './store';
import { applyServerEvent } from './events';

describe('applyServerEvent', () => {
  test('user_message → messages row keyed by session and event id', () => {
    applyServerEvent({ id: 7, type: 'user_message', sessionId: 'jul-1', text: 'hello', speakerName: 'Marcus' });
    expect(store.getRow('messages', 'evt-jul-1-7')).toMatchObject({ role: 'user', speakerName: 'Marcus', text: 'hello' });
  });
  test('the same event id in a later session does not overwrite the earlier message', () => {
    // The server's event counter restarts at 0 on every process restart, while
    // the store is durable — the key must not collide across sessions.
    applyServerEvent({ id: 0, type: 'user_message', sessionId: 'sess-a', text: 'first session', speakerName: 'Marcus' });
    applyServerEvent({ id: 0, type: 'user_message', sessionId: 'sess-b', text: 'after restart', speakerName: 'Marcus' });
    expect(store.getCell('messages', 'evt-sess-a-0', 'text')).toBe('first session');
    expect(store.getCell('messages', 'evt-sess-b-0', 'text')).toBe('after restart');
  });
  test('the server timestamp is used, so every door writes the same row', () => {
    applyServerEvent({ id: 42, type: 'user_message', sessionId: 'jul-1', text: 'hi', speakerName: 'Marcus', ts: 1234567 });
    expect(store.getCell('messages', 'evt-jul-1-42', 'ts')).toBe(1234567);
  });
  test('claude_text → assistant row keyed by messageId, text extracted from blocks', () => {
    applyServerEvent({
      id: 8, type: 'claude_text', sessionId: 'jul-1', messageId: 'msg_abc',
      content: [{ type: 'text', text: 'good evening' }],
    });
    expect(store.getRow('messages', 'msg_abc')).toMatchObject({ role: 'assistant', speakerName: 'Julian', text: 'good evening' });
  });
  test('replayed event is idempotent', () => {
    applyServerEvent({ id: 7, type: 'user_message', sessionId: 'jul-1', text: 'hello', speakerName: 'Marcus' });
    expect(store.getRowIds('messages').filter((i) => i === 'evt-jul-1-7')).toHaveLength(1);
  });
  test('artifact ui_action upserts artifacts row', () => {
    applyServerEvent({
      id: 9, type: 'ui_action', target: 'artifacts', action: 'upsert',
      data: { filename: 'the-relay.md', category: 'identity', description: 'x', chapter: 'Three' },
    });
    expect(store.getCell('artifacts', 'the-relay.md', 'category')).toBe('identity');
  });
  test('unknown event types are ignored without throwing', () => {
    expect(() => applyServerEvent({ id: 10, type: 'claude_tool_result' })).not.toThrow();
  });
});
