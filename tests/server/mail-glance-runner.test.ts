import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStateFrom, saveBeatStateTo, StateCorruptError, writeStateTo } from '../../scripts/mail-glance';
import type { Hold } from '../../scripts/lib/mail-glance-lib';

const dir = () => mkdtempSync(join(tmpdir(), 'mail-state-'));

const sus = (id: string): Hold => ({ id, kind: 'suspicion', heldUtcDay: '' });
const cap = (id: string, heldUtcDay: string): Hold => ({ id, kind: 'cap', heldUtcDay });

describe('runner state shell (#19)', () => {
  test('ENOENT reads as a fresh state', () => {
    const s = loadStateFrom(join(dir(), 'missing.json'));
    expect(s.strangerWatermarkMs).toBe(0);
    expect(s.holds).toEqual([]);
  });

  test('a corrupt file throws StateCorruptError — never reads as empty', () => {
    const p = join(dir(), 'state.json');
    writeFileSync(p, 'not json');
    expect(() => loadStateFrom(p)).toThrow(StateCorruptError);
  });

  test('writeStateTo round-trips atomically and leaves no temp files', () => {
    const d = dir();
    const p = join(d, 'state.json');
    writeStateTo(p, { strangerWatermarkMs: 5, holds: [], updatedAt: '' });
    expect(loadStateFrom(p).strangerWatermarkMs).toBe(5);
    expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('saveBeatStateTo unions holds and takes the later watermark', () => {
    const p = join(dir(), 'state.json');
    writeStateTo(p, { strangerWatermarkMs: 100, holds: [sus('m1')], updatedAt: '' });
    saveBeatStateTo(p, { strangerWatermarkMs: 50, holds: [sus('m2')], updatedAt: '' });
    const s = loadStateFrom(p);
    expect(s.strangerWatermarkMs).toBe(100); // never backward
    // a concurrent --hold survives
    expect(s.holds.slice().sort((a, b) => a.id.localeCompare(b.id))).toEqual([sus('m1'), sus('m2')]);
  });

  test('a legacy held: string[] file on disk loads as suspicion holds', () => {
    const p = join(dir(), 'state.json');
    writeFileSync(p, JSON.stringify({ strangerWatermarkMs: 3, held: ['m1'], updatedAt: '' }));
    expect(loadStateFrom(p).holds).toEqual([sus('m1')]);
  });

  test('saveBeatStateTo keeps suspicion when the two sides disagree on kind (#18)', () => {
    const p = join(dir(), 'state.json');
    writeStateTo(p, { strangerWatermarkMs: 0, holds: [sus('m1')], updatedAt: '' });
    saveBeatStateTo(p, { strangerWatermarkMs: 0, holds: [cap('m1', '2026-08-20')], updatedAt: '' });
    expect(loadStateFrom(p).holds).toEqual([sus('m1')]);
  });

  test('saveBeatStateTo drops expired cap-holds and reports them (#18)', () => {
    const p = join(dir(), 'state.json');
    // The stale cap-hold lives on disk, so the read-before-write union is
    // exactly where it would otherwise be resurrected after the beat pruned it.
    writeStateTo(p, {
      strangerWatermarkMs: 0,
      holds: [cap('yesterday', '2026-08-19'), cap('today', '2026-08-20'), sus('forever')],
      updatedAt: '',
    });
    const { expired } = saveBeatStateTo(p, { strangerWatermarkMs: 0, holds: [], updatedAt: '' }, '2026-08-20');
    expect(expired.map((h) => h.id)).toEqual(['yesterday']);
    const s = loadStateFrom(p);
    expect(s.holds.map((h) => h.id).sort()).toEqual(['forever', 'today']);
  });

  test('saveBeatStateTo reports no expiries when nothing expired', () => {
    const p = join(dir(), 'state.json');
    writeStateTo(p, { strangerWatermarkMs: 0, holds: [sus('m1')], updatedAt: '' });
    const { expired } = saveBeatStateTo(p, { strangerWatermarkMs: 0, holds: [], updatedAt: '' }, '2026-08-20');
    expect(expired).toEqual([]);
    expect(loadStateFrom(p).holds).toEqual([sus('m1')]);
  });

  test('importing the module runs no beat', () => {
    // Reaching this line proves the main-guard: no network call, no exit.
    expect(typeof loadStateFrom).toBe('function');
  });
});
