import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { startSession, endSession } from './api';
import { store } from './store';

vi.mock('./auth', () => ({ getToken: async () => 'tok' }));

describe('session api', () => {
  beforeEach(() => {
    store.delTable('messages');
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as never;
  });
  afterEach(() => vi.restoreAllMocks());

  test('startSession posts the tail as previousTranscript', async () => {
    store.setRow('messages', 'm1', { kind: 'chat', role: 'user', speakerName: 'Marcus', text: 'hello', ts: 1, sessionId: 's' } as never);
    await startSession();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/session/start');
    const body = JSON.parse(init.body);
    expect(body.previousTranscript).toEqual([
      { role: 'user', speakerType: 'human', speakerName: 'Marcus', text: 'hello', ts: 1 },
    ]);
  });

  test('plain endSession sends no body; final end sends {final: true}', async () => {
    await endSession();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body).toBeUndefined();
    await endSession(true);
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body)).toEqual({ final: true });
  });
});
