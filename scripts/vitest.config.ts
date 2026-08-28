import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'fireproof-decode.test.ts',
      'fireproof-map.test.ts',
      'fireproof-write.test.ts',
      'stream-import-fireproof.test.ts',
      'fragmenter-regression.test.ts',
      'reconnect.test.ts',
    ],
  },
});
