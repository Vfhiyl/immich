import { defineConfig, devices } from '@playwright/test';
import { serverPort } from './src/storage-backends.js';

// The pages of storage backends in a browser, against a server the tests start themselves (src/storage-backends.ts)
// with the built web app, instead of docker compose
export default defineConfig({
  testDir: './src/specs/storage-backends-web',
  testMatch: /.*\.e2e-spec\.ts/,
  globalSetup: './src/specs/storage-backends/setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${serverPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
