import { describe, expect, test } from 'vitest';
import { parsePath } from '../src/index';

describe('parsePath', () => {
  test('two segments → store/context', () => {
    expect(parsePath('/julian/chat')).toEqual({
      store: 'julian', context: 'chat', isExport: false, isRestore: false });
  });
  test('export suffix', () => {
    expect(parsePath('/julian/chat/export')).toEqual({
      store: 'julian', context: 'chat', isExport: true, isRestore: false });
  });
  test('restore suffix', () => {
    expect(parsePath('/julian/chat/restore')).toEqual({
      store: 'julian', context: 'chat', isExport: false, isRestore: true });
  });
  test('rejects one segment, four segments, bad charset', () => {
    expect(parsePath('/julian')).toBeNull();
    expect(parsePath('/a/b/c/d')).toBeNull();
    expect(parsePath('/Julian/chat')).toBeNull();      // uppercase
    expect(parsePath('/julian/ch@t')).toBeNull();      // symbol
    // Only export and restore are valid third segments — nothing else, and
    // nothing that merely resembles them.
    expect(parsePath('/julian/chat/delete')).toBeNull();
    expect(parsePath('/julian/chat/restores')).toBeNull();
    expect(parsePath('/julian/chat/Restore')).toBeNull();
  });
});
