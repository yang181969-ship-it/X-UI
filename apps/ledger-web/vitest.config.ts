import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// X-UI v1 web unit tests (npm run test:web:v1): pure modules under src/lib only — no DOM, no React
// rendering (browser behaviour is covered by e2e-v1). Storage, clock and key generator are injected.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
