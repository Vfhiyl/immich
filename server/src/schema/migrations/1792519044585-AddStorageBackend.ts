import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_file" ADD "backendId" character varying;`.execute(db);
  await sql`ALTER TABLE "asset_file" ADD "key" character varying;`.execute(db);
  await sql`ALTER TABLE "asset_file" ADD "size" bigint;`.execute(db);
  await sql`ALTER TABLE "asset_file" ADD "checksum" bytea;`.execute(db);
  await sql`CREATE TABLE "storage_backend" (
  "id" character varying NOT NULL,
  "driver" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "storage_backend_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`INSERT INTO "storage_backend" ("id", "driver") VALUES ('media', 'local'), ('host', 'local');`.execute(db);
  await sql`ALTER TABLE "asset_file" ADD CONSTRAINT "asset_file_backendId_fkey" FOREIGN KEY ("backendId") REFERENCES "storage_backend" ("id") ON UPDATE CASCADE ON DELETE RESTRICT;`.execute(db);
  await sql`CREATE UNIQUE INDEX "asset_file_backendId_key_idx" ON "asset_file" ("backendId", "key") WHERE ("backendId" <> 'host');`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_asset_file_backendId_key_idx', '{"type":"index","name":"asset_file_backendId_key_idx","sql":"CREATE UNIQUE INDEX \\"asset_file_backendId_key_idx\\" ON \\"asset_file\\" (\\"backendId\\", \\"key\\") WHERE (\\"backendId\\" <> ''host'');"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "asset_file_backendId_key_idx";`.execute(db);
  await sql`ALTER TABLE "asset_file" DROP CONSTRAINT "asset_file_backendId_fkey";`.execute(db);
  await sql`ALTER TABLE "asset_file" DROP COLUMN "backendId";`.execute(db);
  await sql`ALTER TABLE "asset_file" DROP COLUMN "key";`.execute(db);
  await sql`ALTER TABLE "asset_file" DROP COLUMN "size";`.execute(db);
  await sql`ALTER TABLE "asset_file" DROP COLUMN "checksum";`.execute(db);
  await sql`DROP TABLE "storage_backend";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_asset_file_backendId_key_idx';`.execute(db);
}
