// Medium tests against an existing PostgreSQL server, for machines without Docker (see test/medium/globalSetup.postgres.ts)
import base from './vitest.config.medium.mjs';

export default {
  ...base,
  test: {
    ...base.test,
    globalSetup: ['test/medium/globalSetup.postgres.ts'],
    // every file runs at once against the one server, where making a test database can take a few seconds
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
