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
});
