// The knock: RFC 8628 device flow. `POST /device` opens a knock, `POST /token`
// polls it and later rotates the pair. Stub until the device-flow task lands;
// the router seam and its contract are already fixed here.
import type { Env } from '../env';
import type { GovernorDO } from '../governor';
import { json } from '../lease-auth';

export function handleDevice(
  _req: Request, _env: Env, _gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  return Promise.resolve(json({ error: 'not implemented' }, 501));
}
