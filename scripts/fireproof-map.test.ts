import { describe, expect, test } from 'bun:test';
import {
  buildReceipt, cellJsonBytes, collapseSplits, filterDocs, hardChecks, mapMessage, normalizeStrings, selectVersions,
} from './lib/fireproof-map';
import type { DecodedDoc, MappedRow } from './lib/fireproof-types';

const L = { ledgerId: 'zLEDGER1234567890A', name: 'clerk-julian-chat-v13-zT', tenantId: 'zT' };
const dd = (doc: Record<string, unknown>, uploaded = 1, blobId = 'b'): DecodedDoc =>
  ({ doc: doc as DecodedDoc['doc'], ledger: L, blobId, uploaded });

describe('filterDocs', () => {
  test('keeps messages, counts everything else by type', () => {
    const r = filterDocs([
      dd({ _id: 'm1', type: 'message', text: 'x' }), dd({ _id: 'a1', type: 'agent-identity' }),
      dd({ _id: 'j1', type: 'job' }), dd({ _id: 'genesis' }),
    ]);
    expect(r.messages.map((d) => d.doc._id)).toEqual(['m1']);
    expect(r.droppedByType).toEqual({ 'agent-identity': 1, job: 1, '(untyped)': 1 });
  });
});

describe('mapMessage', () => {
  test('human message: text field, no content, sessionId carries ledger + session', () => {
    const row = mapMessage(dd({ _id: 'u1', type: 'message', role: 'user', speakerType: 'human', speakerName: 'marcus',
      text: 'hi', blocks: [], createdAt: '2026-02-20T10:00:00.000Z', serverSessionId: 'sess-9' }));
    expect(row).toEqual({ id: 'u1', sessionId: 'fireproof:zLEDGER1234567890A:sess-9', role: 'user', speakerName: 'Marcus',
      text: 'hi', ts: Date.parse('2026-02-20T10:00:00.000Z'), kind: 'chat' });
  });
  test('assistant message: words from text blocks only, content as recorded incl. tool_use, null session', () => {
    const blocks = [{ type: 'text', text: 'one' }, { type: 'tool_use', name: 'Write', input: { file_path: 'x' } }, { type: 'text', text: 'two' }];
    const row = mapMessage(dd({ _id: 'a1', type: 'message', role: 'assistant', speakerType: 'agent', speakerName: 'Lumen',
      text: '', blocks, createdAt: '2026-02-21T00:00:00.000Z', serverSessionId: null }));
    expect(row?.text).toBe('one\ntwo');
    expect(row?.content).toEqual(blocks);
    expect(row?.sessionId).toBe('fireproof:zLEDGER1234567890A:nosession');
    expect(row?.speakerName).toBe('Lumen');
  });
  test('v3 author-only shape maps to a user row named Marcus; numeric createdAt is used as-is', () => {
    const row = mapMessage(dd({ _id: 'v3', type: 'message', author: 'marcus', text: 'early', createdAt: 1771147857410 }));
    expect(row).toMatchObject({ role: 'user', speakerName: 'Marcus', ts: 1771147857410 });
  });
  test('role inferred from speakerType when role is absent; blank names filled from role', () => {
    expect(mapMessage(dd({ _id: 'x', type: 'message', speakerType: 'agent', text: 't', createdAt: '2026-02-20T00:00:00Z' })))
      .toMatchObject({ role: 'assistant', speakerName: 'Julian' });
  });
  test('empty after mapping → null', () => {
    expect(mapMessage(dd({ _id: 'e', type: 'message', role: 'assistant', text: '', blocks: [{ type: 'tool_use', name: 'Read' }], createdAt: '2026-02-20T00:00:00Z' }))).toBeNull();
  });
  test('U+2028/U+2029 are normalized to \\n in text and nested content', () => {
    const row = mapMessage(dd({ _id: 'n', type: 'message', role: 'assistant', text: '', createdAt: '2026-02-20T00:00:00Z',
      blocks: [{ type: 'text', text: 'a\u2028b\u2029c' }, { type: 'tool_use', name: 'W', input: { s: 'x\u2028y' } }] }));
    expect(row?.text).toBe('a\nb\nc');
    expect((row?.content as Array<{ input?: { s: string } }>)[1].input?.s).toBe('x\ny');
    expect(normalizeStrings({ k: ['p\u2029q'] })).toEqual({ k: ['p\nq'] });
  });
});

const row = (id: string, text: string, extra: Partial<MappedRow> = {}): MappedRow =>
  ({ id, sessionId: 'fireproof:zL:s', role: 'assistant', speakerName: 'Julian', text, ts: 1000, kind: 'chat', ...extra });

describe('selectVersions', () => {
  test('last by upload time wins when losers are prefixes; ties break by blobId', () => {
    const r = selectVersions([
      { row: row('m', 'hel'), uploaded: 1, blobId: 'a' },
      { row: row('m', 'hello world'), uploaded: 2, blobId: 'b' },
      { row: row('m', 'hello'), uploaded: 2, blobId: 'a' },
    ]);
    expect(r.winners.map((w) => w.text)).toEqual(['hello world']);
    expect(r.violations).toEqual([]);
  });
  test('a non-prefix loser is a violation and the longest text wins', () => {
    const r = selectVersions([
      { row: row('m', 'a completely different long text'), uploaded: 1, blobId: 'a' },
      { row: row('m', 'short'), uploaded: 2, blobId: 'b' },
    ]);
    expect(r.winners[0].text).toBe('a completely different long text');
    expect(r.violations).toEqual([{ id: 'm', note: expect.stringMatching(/not a prefix/) }]);
  });
});

describe('collapseSplits', () => {
  test('drops an assistant row whose text is a strict prefix of a sibling with the same session and ts', () => {
    const r = collapseSplits([row('p', 'part'), row('f', 'partial and full'), row('u', 'other', { ts: 2000 })]);
    expect(r.rows.map((x) => x.id)).toEqual(['f', 'u']);
    expect(r.dropped).toEqual([{ id: 'p', keptId: 'f' }]);
  });
  test('identical text keeps the later row', () => {
    const r = collapseSplits([row('a', 'same'), row('b', 'same')]);
    expect(r.rows.map((x) => x.id)).toEqual(['b']);
  });
});

describe('hardChecks', () => {
  const good = row('ok', 'fine', { ts: Date.UTC(2026, 1, 20) });
  test('passes a clean batch', () => {
    expect(hardChecks([good], { existing: new Map() })).toEqual({ ok: true });
  });
  test('refuses out-of-range ts unless allow-listed', () => {
    const late = row('late', 'x', { ts: Date.UTC(2026, 2, 5) });
    expect(hardChecks([late], { existing: new Map() })).toMatchObject({ ok: false, errors: [expect.stringMatching(/ts out of range.*late/)] });
    expect(hardChecks([late], { existing: new Map(), allowIds: new Set(['late']) })).toEqual({ ok: true });
  });
  test('refuses U+FFFD prefix, U+FFFC, lone surrogates, and residual line separators', () => {
    for (const bad of ['�hi', '￼', 'x\uD800y', 'a\u2028b']) {
      expect(hardChecks([row('b', bad, { ts: good.ts })], { existing: new Map() }).ok).toBe(false);
    }
  });
  test('refuses an oversize cell using the DO byte formula', () => {
    const big = row('big', 'é'.repeat(40_000), { ts: good.ts }); // 2 bytes each → > 65,536
    expect(cellJsonBytes(big.text)).toBeGreaterThan(65_536);
    expect(hardChecks([big], { existing: new Map() }).ok).toBe(false);
  });
  test('refuses an id that exists on the server with a foreign sessionId; allows a fireproof: one', () => {
    expect(hardChecks([good], { existing: new Map([['ok', 'live-session']]) }).ok).toBe(false);
    expect(hardChecks([good], { existing: new Map([['ok', 'fireproof:zL:s']]) })).toEqual({ ok: true });
  });
  test('the whole batch round-trips through a schema store', () => {
    const r = hardChecks([good, row('two', 'more', { ts: good.ts + 1, content: [{ type: 'text', text: 'more' }] })], { existing: new Map() });
    expect(r).toEqual({ ok: true });
  });
});

describe('buildReceipt', () => {
  test('sits at max ts + 1 with the fixed identity', () => {
    const r = buildReceipt([row('a', 'x', { ts: 5 }), row('b', 'y', { ts: 9 })], new Date('2026-08-25T23:30:00Z'), 'Annexed.');
    expect(r).toEqual({ id: 'fireproof-import-2026-08-25', sessionId: 'fireproof:import', role: 'system', speakerName: 'the record', text: 'Annexed.', ts: 10, kind: 'system' });
  });
});
