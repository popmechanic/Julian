import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStateFrom, saveBeatStateTo, StateCorruptError, writeStateTo } from '../../scripts/mail-glance';

const dir = () => mkdtempSync(join(tmpdir(), 'mail-state-'));

// The `held: string[]` shape below is the CURRENT HeartbeatState shape.
// Task 3 migrates this to `holds: Hold[]` and updates these fixtures — the
// two tasks share this file deliberately (see the plan's Task 1 note).
describe('runner state shell (#19)', () => {
  test('ENOENT reads as a fresh state', () => {
    const s = loadStateFrom(join(dir(), 'missing.json'));
    expect(s.strangerWatermarkMs).toBe(0);
    expect(s.held).toEqual([]);
  });

  test('a corrupt file throws StateCorruptError — never reads as empty', () => {
    const p = join(dir(), 'state.json');
    writeFileSync(p, 'not json');
    expect(() => loadStateFrom(p)).toThrow(StateCorruptError);
  });

  test('writeStateTo round-trips atomically and leaves no temp files', () => {
    const d = dir();
    const p = join(d, 'state.json');
    writeStateTo(p, { strangerWatermarkMs: 5, held: [], updatedAt: '' });
    expect(loadStateFrom(p).strangerWatermarkMs).toBe(5);
    expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('saveBeatStateTo unions held ids and takes the later watermark', () => {
    const p = join(dir(), 'state.json');
    writeStateTo(p, { strangerWatermarkMs: 100, held: ['m1'], updatedAt: '' });
    saveBeatStateTo(p, { strangerWatermarkMs: 50, held: ['m2'], updatedAt: '' });
    const s = loadStateFrom(p);
    expect(s.strangerWatermarkMs).toBe(100); // never backward
    expect(s.held.slice().sort()).toEqual(['m1', 'm2']); // a concurrent --hold survives
  });

  test('importing the module runs no beat', () => {
    // Reaching this line proves the main-guard: no network call, no exit.
    expect(typeof loadStateFrom).toBe('function');
  });
});
