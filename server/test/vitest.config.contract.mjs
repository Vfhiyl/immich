// Blob store contract tests against real S3 services (see test/contract/globalSetup.ts)
import base from './vitest.config.medium.mjs';

export default {
  ...base,
  test: {
    ...base.test,
    name: 'server:contract',
    include: ['test/contract/**/*.spec.ts'],
    globalSetup: ['test/contract/globalSetup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
};
