import { defineConfig } from 'vitest/config';

// Storage backend scenarios run their own server processes (see src/storage-backends.ts) instead of docker compose
export default defineConfig({
  test: {
    name: 'e2e:storage-backends',
    include: ['src/specs/storage-backends/**/*.e2e-spec.ts'],
    globalSetup: ['src/specs/storage-backends/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'threads',
    maxWorkers: 1,
    isolate: false,
  },
  resolve: {
    tsconfigPaths: true,
  },
});
