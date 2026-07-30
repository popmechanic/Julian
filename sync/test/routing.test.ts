import { describe, expect, test } from 'vitest';
import { parsePath } from '../src/index';

describe('parsePath', () => {
  test('two segments → store/context', () => {
    expect(parsePath('/julian/chat')).toEqual({ store: 'julian', context: 'chat', isExport: false });
  });
  test('export suffix', () => {
    expect(parsePath('/julian/chat/export')).toEqual({ store: 'julian', context: 'chat', isExport: true });
  });
  test('rejects one segment, four segments, bad charset', () => {
    expect(parsePath('/julian')).toBeNull();
    expect(parsePath('/a/b/c/d')).toBeNull();
    expect(parsePath('/Julian/chat')).toBeNull();      // uppercase
    expect(parsePath('/julian/ch@t')).toBeNull();      // symbol
    expect(parsePath('/julian/chat/delete')).toBeNull(); // only export is a valid third segment
  });
});
