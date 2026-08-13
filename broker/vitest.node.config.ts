// The Node-side project: the acceptance harness, where the *official* MCP SDK
// plays client against a deployed-shape worker. It cannot live in the workers
// pool — the harness starts a real worker (`unstable_startWorker`) and a real
// `node:http` fixture beside it, so it needs a Node runtime, not a workerd one.
//
// `bun run test` stays the workers-pool suite alone (`--dir test`); this config
// is reached only through `bun run test:mcp`.
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      'julian-shared/auth': resolve(__dirname, '../shared/auth.ts'),
      'julian-shared/schema': resolve(__dirname, '../shared/schema.ts'),
      'julian-shared/scopes': resolve(__dirname, '../shared/scopes.ts'),
      'julian-shared/gate-contract': resolve(__dirname, '../shared/gate-contract.ts'),
    },
  },
  test: {
    include: ['test-mcp-client/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One worker, one fixture, one port at a time: the harness owns real
    // sockets, so files never overlap.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
