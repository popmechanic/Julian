import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          serviceBindings: { SYNC: () => new Response('sync stub: not wired in tests', { status: 500 }) },
          ratelimits: { EXCHANGE_RL: { simple: { limit: 1000, period: 60 } } },
        },
      },
    },
  },
});
