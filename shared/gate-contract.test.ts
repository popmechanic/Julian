import { describe, expect, test } from 'vitest';
import {
  INTROSPECT_PATH, CONSUME_TICKET_PATH, REFUSALS_PATH, ALLOWED_PATH, INTERNAL_READ_PREFIX,
  SYNC_AUTH_HEADER, INTROSPECT_SECRET_HEADER, SYNC_READ_SECRET_HEADER,
  type IntrospectionWire, type SyncAuthPayload, type ConsumeTicketWire,
  type InternalReadRequest, type InternalReadResponse, type StreamRow,
} from './gate-contract';

// This file exists so both workers' suites can import and re-assert the same
// shapes — the fixture rule of spec §8. Every constant is pinned literally;
// every interface gets one literal object that must typecheck against it.

describe('path and header constants', () => {
  test('paths', () => {
    expect(INTROSPECT_PATH).toBe('/introspect');
    expect(CONSUME_TICKET_PATH).toBe('/consume-ticket');
    expect(REFUSALS_PATH).toBe('/refusals');
    expect(ALLOWED_PATH).toBe('/allowed');
    expect(INTERNAL_READ_PREFIX).toBe('/internal/read/');
  });
  test('headers', () => {
    expect(SYNC_AUTH_HEADER).toBe('X-Sync-Auth');
    expect(INTROSPECT_SECRET_HEADER).toBe('X-Introspect-Secret');
    expect(SYNC_READ_SECRET_HEADER).toBe('X-Sync-Read-Secret');
  });
});

describe('wire shapes typecheck against one literal fixture apiece', () => {
  test('IntrospectionWire — active with every optional field present', () => {
    const wire: IntrospectionWire = {
      active: true,
      lease_id: 'L1',
      door_name: 'door:x',
      scope: 'full-house',
      principal: 'julian',
      subject: 'lease:L1',
      flow: 'device',
      token_id: 't1',
      exp: 1234567890,
    };
    expect(wire.active).toBe(true);
  });

  test('IntrospectionWire — inactive is just {active: false}', () => {
    const wire: IntrospectionWire = { active: false };
    expect(wire.active).toBe(false);
  });

  test('SyncAuthPayload', () => {
    const payload: SyncAuthPayload = {
      leaseId: 'L1',
      tokenId: 't1',
      subject: 'lease:L1',
      scope: 'stream',
      flow: 'exchange',
      principal: 'julian',
      exp: 1234567890,
    };
    expect(payload.leaseId).toBe('L1');
  });

  test('ConsumeTicketWire — ok', () => {
    const wire: ConsumeTicketWire = {
      ok: true,
      lease_id: 'L1',
      token_id: 't1',
      subject: 'lease:L1',
      scope: 'stream',
      flow: 'exchange',
      principal: 'julian',
    };
    expect(wire.ok).toBe(true);
  });

  test('ConsumeTicketWire — refused', () => {
    const wire: ConsumeTicketWire = { ok: false, error: 'expired' };
    expect(wire.ok).toBe(false);
  });

  test('InternalReadRequest', () => {
    const req: InternalReadRequest = {
      principal: 'julian',
      limit: 50,
      sessionId: 's1',
      from: 1,
      to: 2,
      query: 'hello',
    };
    expect(req.principal).toBe('julian');
  });

  test('StreamRow', () => {
    const row: StreamRow = {
      id: 'evt-1',
      sessionId: 's1',
      role: 'user',
      speakerName: 'Marcus',
      text: 'hello',
      ts: 1,
      kind: 'chat',
    };
    expect(row.text).toBe('hello');
  });

  test('InternalReadResponse — ok', () => {
    const row: StreamRow = {
      id: 'evt-1', sessionId: 's1', role: 'user', speakerName: 'Marcus', text: 'hi', ts: 1, kind: 'chat',
    };
    const res: InternalReadResponse = { ok: true, rows: [row], truncated: false };
    expect(res.ok).toBe(true);
  });

  test('InternalReadResponse — not ok', () => {
    const res: InternalReadResponse = { ok: false };
    expect(res.ok).toBe(false);
  });
});
