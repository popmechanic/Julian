import { describe, expect, test } from 'vitest';
import {
  SCOPES, SCOPE_VERBS, EXPORT_SCOPES, SOCKET_SCOPES,
  KNOCK_SCOPES, AUTHCODE_SCOPES, EXCHANGE_SCOPES,
} from './scopes';
import { storePathFor } from './schema';

describe('the vocabulary is the spec §5 table, exactly', () => {
  test('four scopes, in privilege order', () => {
    expect(SCOPES).toEqual(['reading-room', 'stream-read', 'stream', 'full-house']);
  });
  test('reading-room buys package only', () => {
    expect(SCOPE_VERBS['reading-room']).toEqual(['package.list', 'package.read']);
  });
  test('stream-read and stream buy package + stream reads; only full-house buys mail', () => {
    for (const s of ['stream-read', 'stream'] as const) {
      expect(SCOPE_VERBS[s]).toContain('stream.recent');
      expect(SCOPE_VERBS[s]).not.toContain('mail.send');
    }
    expect(SCOPE_VERBS['full-house']).toContain('mail.send');
  });
  test('sync sets: export ⊇ socket; socket = {stream, full-house}', () => {
    expect([...SOCKET_SCOPES].sort()).toEqual(['full-house', 'stream']);
    expect([...EXPORT_SCOPES].sort()).toEqual(['full-house', 'stream', 'stream-read']);
  });
});

describe('mint allowlists never widen (SEC MED-2)', () => {
  test('knock cannot mint stream', () => expect(KNOCK_SCOPES).not.toContain('stream'));
  test('authcode caps at stream-read', () =>
    expect([...AUTHCODE_SCOPES].sort()).toEqual(['reading-room', 'stream-read']));
  test('exchange mints stream and nothing else', () => expect(EXCHANGE_SCOPES).toEqual(['stream']));
});

describe('storePathFor', () => {
  test('derives the principal store', () => expect(storePathFor('julian')).toBe('julian/chat'));
  test('refuses the reserved segment and junk', () => {
    expect(storePathFor('internal')).toBeNull();
    expect(storePathFor('')).toBeNull();
    expect(storePathFor('Not/Valid')).toBeNull();
  });
});
