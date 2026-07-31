import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../scripts/mail-broker';

describe('mail-broker parseArgs', () => {
  test('send with recipients, subject, text', () => {
    expect(parseArgs(['send', '--to', 'a@b.c,d@e.f', '--subject', 'Hello', '--text', 'Hi there']))
      .toEqual({ cmd: 'send', to: ['a@b.c', 'd@e.f'], subject: 'Hello', text: 'Hi there', html: undefined, id: undefined });
  });
  test('send requires --to and --subject and a body', () => {
    expect(parseArgs(['send', '--subject', 's', '--text', 'x'])).toEqual({ error: 'send requires --to' });
    expect(parseArgs(['send', '--to', 'a@b.c', '--text', 'x'])).toEqual({ error: 'send requires --subject' });
    expect(parseArgs(['send', '--to', 'a@b.c', '--subject', 's'])).toEqual({ error: 'send requires --text or --html' });
  });
  test('list, health, agent-doc', () => {
    expect(parseArgs(['list'])).toEqual({ cmd: 'list', to: undefined, subject: undefined, text: undefined, html: undefined, id: undefined });
    expect(parseArgs(['health'])).toEqual({ cmd: 'health', to: undefined, subject: undefined, text: undefined, html: undefined, id: undefined });
    expect(parseArgs(['--agent-doc'])).toEqual({ cmd: 'agent-doc', to: undefined, subject: undefined, text: undefined, html: undefined, id: undefined });
  });
  test('read requires an id', () => {
    expect(parseArgs(['read', 'msg_1'])).toEqual({ cmd: 'read', to: undefined, subject: undefined, text: undefined, html: undefined, id: 'msg_1' });
    expect(parseArgs(['read'])).toEqual({ error: 'read requires a message id' });
  });
  test('unknown command → error', () => {
    expect(parseArgs(['assign'])).toEqual({ error: 'unknown command: assign' });
    expect(parseArgs([])).toEqual({ error: 'no command given' });
  });
});
