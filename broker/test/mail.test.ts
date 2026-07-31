import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import { MAIL_HOST, mailHealth, mailList, mailRead, mailSend, validateSendBody } from '../src/services/mail';

const ENV = { AGENTMAIL_API_KEY: 'test-key-abc', AGENTMAIL_INBOX_ID: 'julian-marcus@agentmail.to' };
const INBOX_PATH = '/v0/inboxes/julian-marcus%40agentmail.to';

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('validateSendBody', () => {
  test('accepts a full valid body', () => {
    expect(validateSendBody({ to: ['a@b.c'], subject: 's', text: 'hi' }))
      .toEqual({ to: ['a@b.c'], subject: 's', text: 'hi', html: undefined });
  });
  test('rejects: empty to, non-email to, missing subject, missing text and html, non-object', () => {
    expect(validateSendBody({ to: [], subject: 's', text: 'x' })).toBeNull();
    expect(validateSendBody({ to: ['nope'], subject: 's', text: 'x' })).toBeNull();
    expect(validateSendBody({ to: ['a@b.c'], text: 'x' })).toBeNull();
    expect(validateSendBody({ to: ['a@b.c'], subject: 's' })).toBeNull();
    expect(validateSendBody('hello')).toBeNull();
    expect(validateSendBody(null)).toBeNull();
  });
});

describe('mail proxy — pinned host, bearer key, passthrough', () => {
  test('send POSTs to the pinned host with the bearer key', async () => {
    fetchMock.get(MAIL_HOST)
      .intercept({ method: 'POST', path: `${INBOX_PATH}/messages/send`,
        headers: { authorization: 'Bearer test-key-abc' },
        body: JSON.stringify({ to: ['a@b.c'], subject: 's', text: 'hi' }) })
      .reply(200, JSON.stringify({ message_id: 'msg_1' }), { headers: { 'content-type': 'application/json' } });
    const res = await mailSend(ENV, { to: ['a@b.c'], subject: 's', text: 'hi' });
    expect(res.status).toBe(200);
    const data = await res.json() as { message_id: string };
    expect(data.message_id).toBe('msg_1');
  });

  test('list and read hit the inbox routes', async () => {
    fetchMock.get(MAIL_HOST)
      .intercept({ method: 'GET', path: `${INBOX_PATH}/messages` })
      .reply(200, JSON.stringify({ messages: [] }), { headers: { 'content-type': 'application/json' } });
    expect((await mailList(ENV)).status).toBe(200);

    fetchMock.get(MAIL_HOST)
      .intercept({ method: 'GET', path: `${INBOX_PATH}/messages/msg_9` })
      .reply(200, JSON.stringify({ message_id: 'msg_9' }), { headers: { 'content-type': 'application/json' } });
    expect((await mailRead(ENV, 'msg_9')).status).toBe(200);
  });
});

describe('mailHealth trichotomy', () => {
  test('200 → valid', async () => {
    fetchMock.get(MAIL_HOST).intercept({ method: 'GET', path: `${INBOX_PATH}/messages?limit=1` })
      .reply(200, '{}');
    expect(await mailHealth(ENV)).toBe('valid');
  });
  test('401 → invalid (dead key: rotate)', async () => {
    fetchMock.get(MAIL_HOST).intercept({ method: 'GET', path: `${INBOX_PATH}/messages?limit=1` })
      .reply(401, '{}');
    expect(await mailHealth(ENV)).toBe('invalid');
  });
  test('500 → unknown (transient: retry later)', async () => {
    fetchMock.get(MAIL_HOST).intercept({ method: 'GET', path: `${INBOX_PATH}/messages?limit=1` })
      .reply(500, '{}');
    expect(await mailHealth(ENV)).toBe('unknown');
  });
  test('network error → unknown', async () => {
    fetchMock.get(MAIL_HOST).intercept({ method: 'GET', path: `${INBOX_PATH}/messages?limit=1` })
      .replyWithError(new Error('connect timeout'));
    expect(await mailHealth(ENV)).toBe('unknown');
  });
});
