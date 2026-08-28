import { configDefaults, defineConfig } from 'vitest/config';

// package-manifest.test.ts imports from 'bun:test' and runs under `bun test`
// (the suite's second half, chained in package.json's test script); vitest
// must not try to collect it (issue #39).
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'package-manifest.test.ts',
      // bun:test / bun:sqlite — run under `bun test` in the package.json chain
      'fireproof-decode.test.ts',
      'fireproof-map.test.ts',
      'fireproof-write.test.ts',
      'stream-import-fireproof.test.ts',
      'reconnect.test.ts',
    ],
  },
});
