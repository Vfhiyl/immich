import { Kysely, sql } from 'kysely';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';

/**
 * Run medium tests against an existing PostgreSQL server instead of a test container, for machines without Docker.
 * MEDIUM_TEST_POSTGRES_URL points to the server (without a database name); it needs the vector extension.
 */
const globalSetup = async () => {
  const templateName = 'mich';
  const base = process.env.MEDIUM_TEST_POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432';
  process.env.DB_VECTOR_EXTENSION ??= 'pgvector';

  // only the databases that medium tests create (see getKyselyDB) are removed
  const admin = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: `${base}/postgres` }));
  const leftovers = await sql<{ datname: string }>`
    select datname from pg_database where datname ~ '^immich_[a-z0-9]{1,5}$' or datname = ${templateName}
  `.execute(admin);
  for (const { datname } of leftovers.rows) {
    await sql.raw(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).execute(admin);
  }
  await sql.raw(`CREATE DATABASE ${templateName}`).execute(admin);
  await admin.destroy();

  const postgresUrl = `${base}/${templateName}`;
  process.env.IMMICH_TEST_POSTGRES_URL = postgresUrl;

  const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: postgresUrl }));
  await new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository()).runMigrations();
  await db.destroy();
};

export default globalSetup;
