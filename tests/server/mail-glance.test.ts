import { describe, expect, test } from 'bun:test';
import {
  classifyThreads, extractAddress, isAutomated, knownFromSent,
  type MailMessage, type MailThread,
} from '../../scripts/lib/mail-glance-lib';

const SELF = 'julian-marcus@agentmail.to';

function msg(over: Partial<MailMessage>): MailMessage {
  return { messageId: 'm1', from: 'a@b.c', timestamp: '2026-07-31T12:00:00Z', ...over };
}
function thread(msgs: MailMessage[], threadId = 't1'): MailThread {
  return { threadId, messages: msgs };
}

describe('extractAddress', () => {
  test('bare, angle-bracketed, mixed case, padded', () => {
    expect(extractAddress('emily@example.com')).toBe('emily@example.com');
    expect(extractAddress('Emily Person <Emily@Example.com>')).toBe('emily@example.com');
    expect(extractAddress('  a@b.c  ')).toBe('a@b.c');
  });
});

describe('knownFromSent', () => {
  test('collects every recipient of sent mail, normalized', () => {
    const known = knownFromSent([
      msg({ to: ['Emily <emily@example.com>', 'mike@kmikeym.com'] }),
      msg({ to: ['OFFICE@SKYLIGHTSNW.COM'] }),
      msg({}), // no recipients — ignored
    ]);
    expect(known.has('emily@example.com')).toBe(true);
    expect(known.has('mike@kmikeym.com')).toBe(true);
    expect(known.has('office@skylightsnw.com')).toBe(true);
    expect(known.size).toBe(3);
  });
});

describe('isAutomated', () => {
  test('Auto-Submitted (except no), Precedence bulk/list, no-reply local parts', () => {
    expect(isAutomated(msg({ headers: { 'Auto-Submitted': 'auto-replied' } }))).toBe(true);
    expect(isAutomated(msg({ headers: { 'auto-submitted': 'no' } }))).toBe(false);
    expect(isAutomated(msg({ headers: { Precedence: 'bulk' } }))).toBe(true);
    expect(isAutomated(msg({ headers: { precedence: 'list' } }))).toBe(true);
    expect(isAutomated(msg({ from: 'no-reply@corp.com' }))).toBe(true);
    expect(isAutomated(msg({ from: 'NoReply@corp.com' }))).toBe(true);
    expect(isAutomated(msg({ from: 'emily@example.com' }))).toBe(false);
  });
});

describe('classifyThreads', () => {
  const known = new Set(['emily@example.com']);

  test('known sender, latest inbound → eligible', () => {
    const t = thread([msg({ from: SELF }), msg({ from: 'Emily <emily@example.com>', messageId: 'm2' })]);
    const r = classifyThreads([t], known, SELF, new Set());
    expect(r.eligible.length).toBe(1);
    expect(r.strangers.length).toBe(0);
  });

  test('I spoke last → not eligible (double-reply structurally impossible)', () => {
    const t = thread([msg({ from: 'emily@example.com' }), msg({ from: SELF, messageId: 'm2' })]);
    expect(classifyThreads([t], known, SELF, new Set()).eligible.length).toBe(0);
  });

  test('unknown sender, latest inbound → strangers, never eligible', () => {
    const t = thread([msg({ from: 'stranger@wild.net' })]);
    const r = classifyThreads([t], known, SELF, new Set());
    expect(r.eligible.length).toBe(0);
    expect(r.strangers.length).toBe(1);
  });

  test('automated latest message → neither bucket', () => {
    const t = thread([msg({ from: 'emily@example.com', headers: { Precedence: 'bulk' } })]);
    const r = classifyThreads([t], known, SELF, new Set());
    expect(r.eligible.length + r.strangers.length).toBe(0);
  });

  test('held messageId → skipped (a declining session parked it)', () => {
    const t = thread([msg({ from: 'emily@example.com', messageId: 'held-1' })]);
    const r = classifyThreads([t], known, SELF, new Set(['held-1']));
    expect(r.eligible.length).toBe(0);
  });

  test('empty thread → ignored; self-address case-insensitive', () => {
    expect(classifyThreads([thread([])], known, SELF, new Set()).eligible.length).toBe(0);
    const t = thread([msg({ from: 'Julian-Marcus@AgentMail.to' })]);
    expect(classifyThreads([t], known, SELF, new Set()).eligible.length).toBe(0);
    expect(classifyThreads([t], known, SELF, new Set()).strangers.length).toBe(0);
  });

  test('multi-thread call buckets by identity, not just count', () => {
    const tKnown = thread([msg({ from: SELF, messageId: 'k1' }), msg({ from: 'emily@example.com', messageId: 'k2' })], 't-known');
    const tStranger = thread([msg({ from: 'stranger@wild.net', messageId: 's1' })], 't-stranger');
    const tAutomated = thread([msg({ from: 'emily@example.com', messageId: 'a1', headers: { Precedence: 'bulk' } })], 't-automated');
    const tHeld = thread([msg({ from: 'emily@example.com', messageId: 'held-1' })], 't-held');
    const tSelfLatest = thread([msg({ from: 'emily@example.com', messageId: 'sl1' }), msg({ from: SELF, messageId: 'sl2' })], 't-self-latest');

    const r = classifyThreads(
      [tKnown, tStranger, tAutomated, tHeld, tSelfLatest],
      known, SELF, new Set(['held-1']),
    );
    expect(r.eligible.map((t) => t.threadId)).toEqual(['t-known']);
    expect(r.strangers.map((t) => t.threadId)).toEqual(['t-stranger']);
  });

  test('latest is chosen by timestamp, not array order (messages newest-first)', () => {
    // Reply (self) is listed FIRST in the array but has the LATER timestamp;
    // the inbound message from emily is listed second but is actually older.
    // Positional selection would wrongly pick the inbound message as latest
    // and mark this thread eligible for a second reply.
    const t = thread([
      msg({ from: SELF, messageId: 'newer', timestamp: '2026-07-31T13:00:00Z' }),
      msg({ from: 'emily@example.com', messageId: 'older', timestamp: '2026-07-31T12:00:00Z' }),
    ], 't-newest-first');
    const r = classifyThreads([t], known, SELF, new Set());
    expect(r.eligible.map((t) => t.threadId)).toEqual([]);
    expect(r.strangers.map((t) => t.threadId)).toEqual([]);

    // Flip it: emily's message is now the later timestamp despite appearing
    // first in the array — must still classify as eligible.
    const t2 = thread([
      msg({ from: 'emily@example.com', messageId: 'newer2', timestamp: '2026-07-31T13:00:00Z' }),
      msg({ from: SELF, messageId: 'older2', timestamp: '2026-07-31T12:00:00Z' }),
    ], 't-newest-first-2');
    const r2 = classifyThreads([t2], known, SELF, new Set());
    expect(r2.eligible.map((t) => t.threadId)).toEqual(['t-newest-first-2']);
  });
});
