// shared/export-codec.test.ts — issue #48: the export phantom.
//
// TinyBase's mergeable CRDT stamps a deleted cell as [undefined, hlc, hash].
// JSON.stringify collapses undefined → null, and setMergeableContent accepts
// the null as a live-looking value — so a restore resurrects deleted rows and
// a retraction is unverifiable in the exported artifact. The codec makes the
// JSON form lossless: undefined is carried as '￼' (the same convention
// TinyBase's own ws-synchronizer wire protocol uses), and decode restores it.
import { describe, expect, test } from 'vitest';
import { encodeUndefined, decodeUndefined, UNDEFINED_MARKER } from './export-codec';
import { createStreamStore } from './schema';

const seedAndDelete = () => {
  const store = createStreamStore('codec-src');
  store.setRow('messages', 'keep', { sessionId: 's', role: 'user', speakerName: 'M', text: 'kept', ts: 1 });
  store.setRow('messages', 'gone', { sessionId: 's', role: 'user', speakerName: 'M', text: 'doomed', ts: 2 });
  store.delRow('messages', 'gone');
  return store;
};

describe('export codec (issue #48)', () => {
  test('encode survives JSON round-trip: no undefined is collapsed to null', () => {
    const encoded = encodeUndefined(seedAndDelete().getMergeableContent());
    const json = JSON.stringify(encoded);
    expect(json).not.toContain('null');
    expect(json).toContain(JSON.stringify(UNDEFINED_MARKER));
  });

  test('encode → JSON → decode → setMergeableContent does not resurrect a deleted row', () => {
    const wire = JSON.parse(JSON.stringify(encodeUndefined(seedAndDelete().getMergeableContent())));
    const restored = createStreamStore('codec-dst');
    restored.setMergeableContent(decodeUndefined(wire) as never);
    expect(restored.getRowIds('messages')).toEqual(['keep']);
    expect(restored.getCell('messages', 'keep', 'text')).toBe('kept');
  });

  test('decode heals a legacy export: nulls (pre-fix artifacts) become deletions again', () => {
    // Archives sealed before the fix carry null where undefined was. No live
    // cell or value can legitimately be null, so the mapping is unambiguous.
    const legacyWire = JSON.parse(JSON.stringify(seedAndDelete().getMergeableContent()));
    const restored = createStreamStore('codec-legacy');
    restored.setMergeableContent(decodeUndefined(legacyWire) as never);
    expect(restored.getRowIds('messages')).toEqual(['keep']);
  });

  test('a retraction is distinguishable from a never-existed row in the artifact', () => {
    const wire = JSON.parse(JSON.stringify(encodeUndefined(seedAndDelete().getMergeableContent()))) as [
      [Record<string, unknown>, string, number],
      unknown,
    ];
    const tables = wire[0][0];
    const rows = (tables.messages as [Record<string, unknown>, string, number])[0];
    expect(Object.keys(rows).sort()).toEqual(['gone', 'keep']); // the tombstone is present…
    const goneCells = (rows.gone as [Record<string, unknown>, string, number])[0];
    for (const stamp of Object.values(goneCells)) {
      expect((stamp as unknown[])[0]).toBe(UNDEFINED_MARKER); // …and explicit
    }
    expect(rows['never-existed']).toBeUndefined();
  });
});
