import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import { store, startPersistence, writeMessage, FRAGMENT_SIZE } from './store';

describe('client store', () => {
  test('fragment size is set for Cloudflare WS limits', () => {
    expect(FRAGMENT_SIZE).toBe(262144);
  });
  test('writeMessage is idempotent by row id', () => {
    writeMessage('evt-1', { sessionId: 's', role: 'user', speakerName: 'Marcus', text: 'hi', ts: 1 });
    writeMessage('evt-1', { sessionId: 's', role: 'user', speakerName: 'Marcus', text: 'hi', ts: 1 });
    expect(store.getRowIds('messages')).toEqual(['evt-1']);
  });
  test('persistence lifecycle: load before autosave, then round-trip', async () => {
    const persister = await startPersistence();
    writeMessage('evt-2', { sessionId: 's', role: 'assistant', speakerName: 'Julian', text: 'hello', ts: 2 });
    await persister.save();
    expect(store.getCell('messages', 'evt-2', 'text')).toBe('hello');
    await persister.destroy();
  });
});
