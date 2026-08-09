// The knock: RFC 8628 device flow. `POST /device` opens a knock, `POST /token`
// polls it and later rotates the pair. This face is deliberately
// unauthenticated — a door with no lease yet must still be able to knock —
// so it never reads an Authorization header, and never checks one.
import type { Env } from '../env';
import type { DevicePollResult, GovernorDO, KnockCreated, KnockRefused, MintResult } from '../governor';
import { GOVERNOR_DOWN, json } from '../lease-auth';

// RFC 8628 §3.4: the literal grant-type URN a device-flow poll must send.
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_GRANT_TYPE = 'refresh_token';

// RFC 8628 §3.5: every poll-in-progress state is a 400 with one of these codes.
const POLL_ERROR_CODE: Record<Exclude<DevicePollResult['status'], 'ready'>, string> = {
  pending: 'authorization_pending',
  slow_down: 'slow_down',
  expired: 'expired_token',
  refused: 'access_denied',
};

/** Form-encoded only (RFC 8628 §3.1, RFC 6749 §6): a JSON body is a caller error. */
async function parseForm(req: Request): Promise<FormData | null> {
  try {
    return await req.formData();
  } catch {
    return null;
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function missingField(name: string): Response {
  return json({ error: 'invalid_request', error_description: `missing ${name}` }, 400);
}

async function handleKnock(req: Request, env: Env, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const form = await parseForm(req);
  if (!form) return json({ error: 'invalid_request' }, 400);

  const clientId = field(form, 'client_id');
  const host = field(form, 'host');
  const purpose = field(form, 'purpose');
  if (!clientId) return missingField('client_id');
  if (!host) return missingField('host');
  if (!purpose) return missingField('purpose');

  let knock: KnockCreated | KnockRefused;
  try {
    knock = await gov.knockCreate(clientId, host, purpose);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if ('error' in knock) return json({ error: knock.error }, 429);

  return json({
    device_code: knock.deviceCode,
    user_code: knock.userCode,
    verification_uri: `${env.PUBLIC_URL}/approve`,
    expires_in: knock.expiresIn,
    interval: knock.interval,
  });
}

async function handleDeviceGrant(form: FormData, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const clientId = field(form, 'client_id');
  if (!clientId) return missingField('client_id');
  const deviceCode = field(form, 'device_code');
  if (!deviceCode) return missingField('device_code');

  let poll: DevicePollResult;
  try {
    poll = await gov.devicePoll(deviceCode, clientId);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if (poll.status === 'ready') {
    return json({
      access_token: poll.accessToken,
      token_type: 'Bearer',
      expires_in: poll.expiresIn,
      refresh_token: poll.refreshToken,
      scope: poll.scope,
    });
  }
  return json({ error: POLL_ERROR_CODE[poll.status] }, 400);
}

async function handleRefreshGrant(form: FormData, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const refreshToken = field(form, 'refresh_token');
  if (!refreshToken) return missingField('refresh_token');

  let result: MintResult;
  try {
    result = await gov.mintFromRefresh(refreshToken);
  } catch {
    return json({ error: GOVERNOR_DOWN }, 503);
  }
  if (result.status === 'ok') {
    return json({
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
      scope: result.scope,
    });
  }
  if (result.status === 'killed') {
    return json({ error: 'invalid_grant', error_description: 'lease killed: rotation replay' }, 400);
  }
  return json({ error: 'invalid_grant' }, 400);
}

async function handleToken(req: Request, gov: DurableObjectStub<GovernorDO>): Promise<Response> {
  const form = await parseForm(req);
  if (!form) return json({ error: 'invalid_request' }, 400);

  const grantType = field(form, 'grant_type');
  if (grantType === DEVICE_GRANT_TYPE) return handleDeviceGrant(form, gov);
  if (grantType === REFRESH_GRANT_TYPE) return handleRefreshGrant(form, gov);
  return json({ error: 'unsupported_grant_type' }, 400);
}

export async function handleDevice(
  req: Request, env: Env, gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === '/device' && req.method === 'POST') return handleKnock(req, env, gov);
  if (path === '/token' && req.method === 'POST') return handleToken(req, gov);
  return new Response('Not found', { status: 404 });
}
