import { describe, expect, test } from 'bun:test';
import {
  classifyThreads, extractAddress, hasTrustworthyTimestamps, idsUsable, isAutomated, isSafeId,
  knownFromSent, latestArrival, normalizeSentMessages, normalizeThread, parseStateFile, SAFE_ID,
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

  test('whole-thread fallback: a bad timestamp anywhere in the thread abandons timestamp ordering for the whole thread', () => {
    // Last element is MINE (self) with a good timestamp; the other message
    // (theirs) has an empty timestamp. Per-message -Infinity comparison
    // would let my good timestamp win the "latest" race even though it's
    // not last in the array — array-order fallback must apply instead, and
    // since I'm last in the array, the thread is correctly NOT eligible.
    const tSelfLast = thread([
      msg({ from: 'emily@example.com', messageId: 'bad-ts', timestamp: '' }),
      msg({ from: SELF, messageId: 'mine-last', timestamp: '2026-07-31T12:00:00Z' }),
    ], 't-fallback-self-last');
    const rSelfLast = classifyThreads([tSelfLast], known, SELF, new Set());
    expect(rSelfLast.eligible.map((t) => t.threadId)).toEqual([]);
    expect(rSelfLast.strangers.map((t) => t.threadId)).toEqual([]);

    // Last element is THEIRS with an unparseable timestamp; my earlier
    // message has a good timestamp. Per-message comparison would let my
    // good timestamp win and mark this NOT eligible (a missed reply).
    // Array-order fallback must apply: their message is last → eligible.
    const tTheirsLast = thread([
      msg({ from: SELF, messageId: 'mine-first', timestamp: '2026-07-31T11:00:00Z' }),
      msg({ from: 'emily@example.com', messageId: 'bad-ts-2', timestamp: 'not-a-date' }),
    ], 't-fallback-theirs-last');
    const rTheirsLast = classifyThreads([tTheirsLast], known, SELF, new Set());
    expect(rTheirsLast.eligible.map((t) => t.threadId)).toEqual(['t-fallback-theirs-last']);
  });
});

describe('SAFE_ID / isSafeId', () => {
  test('accepts alphanumerics, underscore, dot, colon, hyphen', () => {
    expect(isSafeId('abc123_.:-XYZ')).toBe(true);
    expect(SAFE_ID.test('abc123_.:-XYZ')).toBe(true);
  });

  test('rejects ids with spaces, slashes, quotes, or other punctuation', () => {
    expect(isSafeId('abc 123')).toBe(false);
    expect(isSafeId('abc/123')).toBe(false);
    expect(isSafeId('abc"123')).toBe(false);
    expect(isSafeId('')).toBe(false);
    expect(isSafeId('abc\n123')).toBe(false);
  });

  test('rejects non-string values (SAFE_ID.test would coerce them to a passing string)', () => {
    expect(isSafeId(undefined as unknown as string)).toBe(false);
    expect(isSafeId(null as unknown as string)).toBe(false);
    expect(isSafeId(123 as unknown as string)).toBe(false);
    expect(isSafeId({} as unknown as string)).toBe(false);
  });
});

describe('idsUsable', () => {
  test('real-shaped RFC 5322 message ids (with <>@+=) pass, alongside a safe threadId', () => {
    const t = thread([
      msg({ messageId: '<CADkP+abc123@mail.gmail.com>' }),
      msg({ messageId: '<xyz+789=foo@example.com>', from: 'b@c.d' }),
    ], 't-uuid-1234-safe');
    expect(idsUsable(t)).toBe(true);
  });

  test('a missing, empty, or non-string messageId fails', () => {
    const missing = thread([{ ...msg({}), messageId: undefined as unknown as string }], 't-1');
    expect(idsUsable(missing)).toBe(false);

    const empty = thread([msg({ messageId: '' })], 't-1');
    expect(idsUsable(empty)).toBe(false);

    const nonString = thread([{ ...msg({}), messageId: 123 as unknown as string }], 't-1');
    expect(idsUsable(nonString)).toBe(false);
  });

  test('an unsafe threadId fails even when every messageId is fine', () => {
    const t = thread([msg({ messageId: '<a@b.c>' })], 't 1');
    expect(idsUsable(t)).toBe(false);
  });
});

describe('hasTrustworthyTimestamps', () => {
  test('all messages parseable → true', () => {
    const t = thread([
      msg({ timestamp: '2026-07-31T10:00:00Z' }),
      msg({ timestamp: '2026-07-31T11:00:00Z', messageId: 'm2' }),
    ]);
    expect(hasTrustworthyTimestamps(t)).toBe(true);
  });

  test('one empty timestamp → false', () => {
    const t = thread([
      msg({ timestamp: '2026-07-31T10:00:00Z' }),
      msg({ timestamp: '', messageId: 'm2' }),
    ]);
    expect(hasTrustworthyTimestamps(t)).toBe(false);
  });

  test('one unparseable timestamp → false', () => {
    const t = thread([
      msg({ timestamp: '2026-07-31T10:00:00Z' }),
      msg({ timestamp: 'not-a-date', messageId: 'm2' }),
    ]);
    expect(hasTrustworthyTimestamps(t)).toBe(false);
  });
});

describe('normalizeThread', () => {
  test('happy path: camelCase input passes through unchanged', () => {
    const raw = {
      threadId: 't-1',
      subject: 'Hi',
      messages: [
        {
          messageId: 'm-1', from: 'a@b.c', timestamp: '2026-07-31T12:00:00Z',
          to: ['x@y.z'], subject: 's', labels: ['inbox'], headers: { A: 'b' },
        },
      ],
    };
    const r = normalizeThread(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.thread).toEqual({
        threadId: 't-1',
        subject: 'Hi',
        messages: [{
          messageId: 'm-1', from: 'a@b.c', timestamp: '2026-07-31T12:00:00Z',
          to: ['x@y.z'], subject: 's', labels: ['inbox'], headers: { A: 'b' },
        }],
      });
    }
  });

  test('maps AgentMail snake_case thread_id/message_id', () => {
    const raw = {
      thread_id: 't-2',
      messages: [{ message_id: 'm-2', from: 'a@b.c', timestamp: '2026-07-31T12:00:00Z' }],
    };
    const r = normalizeThread(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.thread.threadId).toBe('t-2');
      expect(r.thread.messages[0].messageId).toBe('m-2');
    }
  });

  test('a message missing "from" → ok:false with a reason, never a cast through to extractAddress', () => {
    const raw = { threadId: 't-3', messages: [{ messageId: 'm-3', timestamp: '2026-07-31T12:00:00Z' }] };
    const r = normalizeThread(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  test('a message missing "message_id"/"messageId" → ok:false with a reason', () => {
    const raw = { threadId: 't-4', messages: [{ from: 'a@b.c', timestamp: '2026-07-31T12:00:00Z' }] };
    const r = normalizeThread(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  test('messages under a wrong key → ok:false, distinguishable from a genuinely empty thread', () => {
    const wrongKey = { threadId: 't-5', msgs: [] };
    const r = normalizeThread(wrongKey);
    expect(r.ok).toBe(false);

    const empty = { threadId: 't-6', messages: [] };
    const rEmpty = normalizeThread(empty);
    expect(rEmpty.ok).toBe(true);
    if (rEmpty.ok) expect(rEmpty.thread.messages).toEqual([]);
  });

  test('absent optional fields stay absent, not undefined-valued keys', () => {
    const raw = { threadId: 't-7', messages: [{ messageId: 'm-7', from: 'a@b.c', timestamp: '2026-07-31T12:00:00Z' }] };
    const r = normalizeThread(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('subject' in r.thread).toBe(false);
      expect('to' in r.thread.messages[0]).toBe(false);
      expect('subject' in r.thread.messages[0]).toBe(false);
      expect('labels' in r.thread.messages[0]).toBe(false);
      expect('headers' in r.thread.messages[0]).toBe(false);
    }
  });

  test('a non-string to[] element rejects the message with a reason (#16)', () => {
    const r = normalizeThread({
      threadId: 't1',
      messages: [{ messageId: 'm1', from: 'a@b.c', timestamp: '2026-08-20T00:00:00Z', to: [{ email: 'x@y.z' }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('to contains a non-string element');
  });

  test('a non-string labels[] element rejects the message with a reason (#16)', () => {
    const r = normalizeThread({
      threadId: 't1',
      messages: [{ messageId: 'm1', from: 'a@b.c', timestamp: '2026-08-20T00:00:00Z', labels: [null] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('labels contains a non-string element');
  });

  test('normalizeSentMessages reports its drop count (#15)', () => {
    const good = { message_id: 'm1', from: 'a@b.c', timestamp: '2026-08-20T00:00:00Z', labels: ['sent'] };
    const bad = { nope: true };
    const r = normalizeSentMessages([good, bad, bad]);
    expect(r.messages.length).toBe(1);
    expect(r.dropped).toBe(2);
  });
});

describe('latestArrival', () => {
  test('all messages parseable → max timestamp, trusted', () => {
    const t = thread([
      msg({ timestamp: '2026-07-31T10:00:00Z' }),
      msg({ timestamp: '2026-07-31T12:00:00Z', messageId: 'm2' }),
    ]);
    const r = latestArrival(t, Date.parse('2026-07-31T20:00:00Z'));
    expect(r).toEqual({ ms: Date.parse('2026-07-31T12:00:00Z'), trusted: true });
  });

  test('one garbled timestamp → untrusted; returns nowMs when the garbled one could be newest', () => {
    const now = Date.parse('2026-07-31T15:00:00Z');
    const t = thread([
      msg({ timestamp: '2026-07-31T10:00:00Z' }),
      msg({ timestamp: 'not-a-date', messageId: 'm2' }),
    ]);
    const r = latestArrival(t, now);
    expect(r).toEqual({ ms: now, trusted: false });
  });

  test('one garbled timestamp, but a good timestamp already exceeds nowMs → returns that later timestamp', () => {
    const now = Date.parse('2026-07-31T09:00:00Z');
    const t = thread([
      msg({ timestamp: '2026-07-31T10:00:00Z' }),
      msg({ timestamp: 'not-a-date', messageId: 'm2' }),
    ]);
    const r = latestArrival(t, now);
    expect(r).toEqual({ ms: Date.parse('2026-07-31T10:00:00Z'), trusted: false });
  });

  test('all timestamps garbled → untrusted, ms is nowMs', () => {
    const now = Date.parse('2026-07-31T15:00:00Z');
    const t = thread([
      msg({ timestamp: '' }),
      msg({ timestamp: 'not-a-date', messageId: 'm2' }),
    ]);
    const r = latestArrival(t, now);
    expect(r).toEqual({ ms: now, trusted: false });
  });
});

describe('parseStateFile', () => {
  test('valid state parses ok', () => {
    const r = parseStateFile(JSON.stringify({ strangerWatermarkMs: 123, held: ['a', 'b'], updatedAt: '2026-07-31T00:00:00Z' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state).toEqual({ strangerWatermarkMs: 123, held: ['a', 'b'], updatedAt: '2026-07-31T00:00:00Z' });
    }
  });

  test('invalid JSON is rejected', () => {
    const r = parseStateFile('{not json');
    expect(r.ok).toBe(false);
  });

  test('held not an array is rejected', () => {
    const r = parseStateFile(JSON.stringify({ strangerWatermarkMs: 0, held: 'nope', updatedAt: '' }));
    expect(r.ok).toBe(false);
  });

  test('held containing a non-string is rejected', () => {
    const r = parseStateFile(JSON.stringify({ strangerWatermarkMs: 0, held: ['a', 1], updatedAt: '' }));
    expect(r.ok).toBe(false);
  });

  test('non-finite strangerWatermarkMs is rejected', () => {
    expect(parseStateFile(JSON.stringify({ strangerWatermarkMs: 'not-a-number', held: [], updatedAt: '' })).ok).toBe(false);
    // 1e1000 is valid JSON syntax but overflows to Infinity once parsed —
    // a genuine non-finite number, unlike NaN/Infinity which JSON can't
    // even encode literally.
    expect(parseStateFile('{"strangerWatermarkMs":1e1000,"held":[],"updatedAt":""}').ok).toBe(false);
  });

  test('missing updatedAt defaults to empty string', () => {
    const r = parseStateFile(JSON.stringify({ strangerWatermarkMs: 0, held: [] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.updatedAt).toBe('');
  });

  test('a JSON array (not an object) is rejected', () => {
    const r = parseStateFile('[]');
    expect(r.ok).toBe(false);
  });
});
