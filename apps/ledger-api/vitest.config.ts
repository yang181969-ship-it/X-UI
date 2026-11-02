import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// X-UI v1 tests only (npm run test:v1). The legacy suite keeps its own root vitest.config.ts.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // removeDbDir (test/helpers.ts) forces a GC so libsql releases closed database files.
    execArgv: ['--expose-gc'],
  },
});
