// Medium tests against an existing PostgreSQL server, for machines without Docker (see test/medium/globalSetup.postgres.ts)
import base from './vitest.config.medium.mjs';

export default { ...base, test: { ...base.test, globalSetup: ['test/medium/globalSetup.postgres.ts'] } };
