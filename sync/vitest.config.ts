import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          serviceBindings: {
            // Boot-time stub for the GATE binding; individual tests inject
            // their own fakes into env. 500 keeps any accidental use fail-closed.
            GATE: () => new Response('gate stub: not wired in tests', { status: 500 }),
          },
        },
      },
    },
  },
});
