import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { resolve } from 'path';
export default defineWorkersConfig({
  resolve: {
    alias: {
      'julian-shared/auth': resolve(__dirname, '../shared/auth.ts'),
      'julian-shared/schema': resolve(__dirname, '../shared/schema.ts'),
      'julian-shared/scopes': resolve(__dirname, '../shared/scopes.ts'),
      'julian-shared/gate-contract': resolve(__dirname, '../shared/gate-contract.ts'),
    },
  },
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
