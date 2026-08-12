// The Node-side project: the acceptance harness, where the *official* MCP SDK
// plays client against a deployed-shape worker. It cannot live in the workers
// pool — the harness starts a real worker (`unstable_startWorker`) and a real
// `node:http` fixture beside it, so it needs a Node runtime, not a workerd one.
//
// `bun run test` stays the workers-pool suite alone (`--dir test`); this config
// is reached only through `bun run test:mcp`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test-mcp-client/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One worker, one fixture, one port at a time: the harness owns real
    // sockets, so files never overlap.
    fileParallelism: false,
  },
});
