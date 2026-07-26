import { describe, expect, test } from 'vitest';
import { store } from './store';
import { applyServerEvent } from './events';

describe('applyServerEvent', () => {
  test('user_message → messages row keyed by event id', () => {
    applyServerEvent({ id: 7, type: 'user_message', sessionId: 'jul-1', text: 'hello', speakerName: 'Marcus' });
    expect(store.getRow('messages', 'evt-7')).toMatchObject({ role: 'user', speakerName: 'Marcus', text: 'hello' });
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
    expect(store.getRowIds('messages').filter((i) => i === 'evt-7')).toHaveLength(1);
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
