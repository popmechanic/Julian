import { describe, expect, test } from 'vitest';
import { POLICY, policyFor } from '../src/policy';

describe('policy table', () => {
  test('mail.send is capped at 20/day', () => {
    expect(policyFor('mail', 'send')).toEqual({ capPerDay: 20 });
  });
  test('list, read, health are uncapped but present (logged verbs)', () => {
    expect(policyFor('mail', 'list')).toEqual({ capPerDay: null });
    expect(policyFor('mail', 'read')).toEqual({ capPerDay: null });
    expect(policyFor('mail', 'health')).toEqual({ capPerDay: null });
  });
  test('unknown verb → undefined (router will 404)', () => {
    expect(policyFor('mail', 'delete')).toBeUndefined();
    expect(policyFor('voice', 'speak')).toBeUndefined();
  });
  test('every policy key is service.verb shaped', () => {
    for (const k of Object.keys(POLICY)) expect(k).toMatch(/^[a-z]+\.[a-z]+$/);
  });
  test('POLICY is frozen — runtime mutation cannot defeat a cap', () => {
    expect(Object.isFrozen(POLICY)).toBe(true);
    expect(Object.isFrozen(POLICY['mail.send'])).toBe(true);
    expect(() => { (POLICY as any)['mail.send'] = { capPerDay: null }; }).toThrow();
    expect(POLICY['mail.send'].capPerDay).toBe(20);
  });
});

test('package verbs have policy rows (uncapped)', () => {
  expect(policyFor('package', 'list')).toEqual({ capPerDay: null });
  expect(policyFor('package', 'read')).toEqual({ capPerDay: null });
});
