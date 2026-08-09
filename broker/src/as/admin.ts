// The register's face: `POST /introspect` for julian-sync, and `/leases*` for
// listing, revoking and the break-glass export. Stub until the admin task
// lands.
import type { Env } from '../env';
import type { GovernorDO } from '../governor';
import { json } from '../lease-auth';

export function handleAdmin(
  _req: Request, _env: Env, _gov: DurableObjectStub<GovernorDO>,
): Promise<Response> {
  return Promise.resolve(json({ error: 'not implemented' }, 501));
}
