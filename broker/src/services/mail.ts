// Thin proxy to AgentMail. The key is presented to MAIL_HOST and nowhere
// else (host binding — recorded per credential in deploy/secrets-manifest.md).
export const MAIL_HOST = 'https://api.agentmail.to';

export interface MailEnvSlice { AGENTMAIL_API_KEY: string; AGENTMAIL_INBOX_ID: string }
export interface SendBody { to: string[]; subject: string; text?: string; html?: string }

function upstream(env: MailEnvSlice, path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${MAIL_HOST}/v0/inboxes/${encodeURIComponent(env.AGENTMAIL_INBOX_ID)}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.AGENTMAIL_API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export function validateSendBody(body: unknown): SendBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.to) || b.to.length === 0) return null;
  if (!b.to.every((t) => typeof t === 'string' && t.includes('@'))) return null;
  if (typeof b.subject !== 'string' || b.subject.length === 0) return null;
  if (b.text === undefined && b.html === undefined) return null;
  if (b.text !== undefined && typeof b.text !== 'string') return null;
  if (b.html !== undefined && typeof b.html !== 'string') return null;
  return { to: b.to as string[], subject: b.subject, text: b.text as string | undefined, html: b.html as string | undefined };
}

export function mailSend(env: MailEnvSlice, body: SendBody): Promise<Response> {
  return upstream(env, '/messages/send', { method: 'POST', body: JSON.stringify(body) });
}
export function mailList(env: MailEnvSlice): Promise<Response> {
  return upstream(env, '/messages', { method: 'GET' });
}
export function mailRead(env: MailEnvSlice, id: string): Promise<Response> {
  return upstream(env, `/messages/${encodeURIComponent(id)}`, { method: 'GET' });
}

export async function mailHealth(env: MailEnvSlice): Promise<'valid' | 'invalid' | 'unknown'> {
  try {
    const res = await upstream(env, '/messages?limit=1', { method: 'GET' });
    if (res.ok) return 'valid';
    if (res.status === 401 || res.status === 403) return 'invalid';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
