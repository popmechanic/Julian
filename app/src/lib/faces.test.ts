import { describe, expect, test } from 'vitest';
import { CLOSED_EYES, EYE_VARIANTS, MOUTH_VARIANTS, hashNameToFaceVariant } from './faces';

describe('faces', () => {
  test('all four eye variants have left and right pixel arrays', () => {
    for (const key of ['standard', 'round', 'narrow', 'wide'] as const) {
      expect(EYE_VARIANTS[key].left.length).toBeGreaterThan(0);
      expect(EYE_VARIANTS[key].right.length).toBeGreaterThan(0);
    }
  });
  test('all four mouth variants have idle, talk1, talk2 frames', () => {
    for (const key of ['gentle', 'straight', 'cheerful', 'asymmetric'] as const) {
      expect(MOUTH_VARIANTS[key].idle.length).toBeGreaterThan(0);
      expect(MOUTH_VARIANTS[key].talk1.length).toBeGreaterThan(0);
      expect(MOUTH_VARIANTS[key].talk2.length).toBeGreaterThan(0);
    }
  });
  test('every pixel is inside the 32x32 grid', () => {
    const all = [
      ...Object.values(EYE_VARIANTS).flatMap((v) => [...v.left, ...v.right]),
      ...Object.values(MOUTH_VARIANTS).flatMap((v) => [...v.idle, ...v.talk1, ...v.talk2]),
    ];
    for (const [x, y] of all) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(32);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(32);
    }
  });
  test('hashNameToFaceVariant is deterministic and total', () => {
    expect(hashNameToFaceVariant('Julian')).toEqual(hashNameToFaceVariant('Julian'));
    const v = hashNameToFaceVariant('');
    expect(EYE_VARIANTS[v.eyes]).toBeDefined();
    expect(MOUTH_VARIANTS[v.mouth]).toBeDefined();
  });
  test('CLOSED_EYES lids are single-row lines inside each eye span', () => {
    // Left eye occupies x 7-12, right eye x 19-23 (standard variant).
    for (const [x, y] of CLOSED_EYES.left) {
      expect(x).toBeGreaterThanOrEqual(7); expect(x).toBeLessThanOrEqual(12);
      expect(y).toBeGreaterThanOrEqual(10); expect(y).toBeLessThanOrEqual(15);
    }
    for (const [x, y] of CLOSED_EYES.right) {
      expect(x).toBeGreaterThanOrEqual(19); expect(x).toBeLessThanOrEqual(23);
      expect(y).toBeGreaterThanOrEqual(9); expect(y).toBeLessThanOrEqual(14);
    }
    // A lid is a closed line: exactly one distinct y per side.
    expect(new Set(CLOSED_EYES.left.map(([, y]) => y)).size).toBe(1);
    expect(new Set(CLOSED_EYES.right.map(([, y]) => y)).size).toBe(1);
  });
});
