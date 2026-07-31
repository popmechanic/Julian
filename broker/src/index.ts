// Minimal worker entry so vitest-pool-workers can resolve the GOVERNOR
// durable object binding while this package is built incrementally.
// The real router (auth gate, verb dispatch) lands in a later task and
// replaces this file wholesale.
export { GovernorDO } from './governor';

export default {
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
};
