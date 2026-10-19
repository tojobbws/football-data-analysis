import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'workers/*/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
