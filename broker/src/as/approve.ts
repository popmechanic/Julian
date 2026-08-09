// The approval: `GET /approve` shows Marcus who is knocking, `/auth/callback`
// closes the Pocket ID login that proves it is him. Stub until the approval
// task lands; no auto-approve path exists, here or anywhere.
import type { Env } from '../env';
import type { GovernorDO } from '../governor';
import { json } from '../lease-auth';

export function handleApprove(
  _req: Request, _env: Env, _gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  return Promise.resolve(json({ error: 'not implemented' }, 501));
}
