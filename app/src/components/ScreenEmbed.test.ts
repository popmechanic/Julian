import { describe, expect, test } from 'vitest';
import { parseScreenCommands } from './ScreenEmbed.svelte';

// Mirrors the legacy JulianScreenEmbed ws.onmessage handling exactly
// (see chat.jsx's JulianScreenEmbed): JSON array or single command object,
// READY heartbeats filtered out, malformed payloads swallowed silently.
describe('parseScreenCommands', () => {
  test('filters READY out of an array of commands', () => {
    expect(
      parseScreenCommands(
        JSON.stringify([{ type: 'READY' }, { type: 'S', state: 'happy' }]),
      ),
    ).toEqual([{ type: 'S', state: 'happy' }]);
  });

  test('returns an empty array when an array is all READY', () => {
    expect(parseScreenCommands(JSON.stringify([{ type: 'READY' }]))).toEqual([]);
  });

  test('wraps a single non-READY command object', () => {
    expect(parseScreenCommands(JSON.stringify({ type: 'T', text: 'hi' }))).toEqual([
      { type: 'T', text: 'hi' },
    ]);
  });

  test('drops a single READY command object', () => {
    expect(parseScreenCommands(JSON.stringify({ type: 'READY' }))).toEqual([]);
  });

  test('drops a single object with no type', () => {
    expect(parseScreenCommands(JSON.stringify({ foo: 'bar' }))).toEqual([]);
  });

  test('swallows invalid JSON', () => {
    expect(parseScreenCommands('not json')).toEqual([]);
  });

  test('swallows null', () => {
    expect(parseScreenCommands('null')).toEqual([]);
  });
});
