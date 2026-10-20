import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_original_file" (
  "assetId" uuid NOT NULL,
  "backendId" character varying NOT NULL,
  "key" character varying NOT NULL,
  "size" bigint,
  "checksum" bytea,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_original_file_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_original_file_backendId_fkey" FOREIGN KEY ("backendId") REFERENCES "storage_backend" ("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "asset_original_file_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE UNIQUE INDEX "asset_original_file_backendId_key_idx" ON "asset_original_file" ("backendId", "key") WHERE ("backendId" <> 'host');`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_asset_original_file_backendId_key_idx', '{"type":"index","name":"asset_original_file_backendId_key_idx","sql":"CREATE UNIQUE INDEX \\"asset_original_file_backendId_key_idx\\" ON \\"asset_original_file\\" (\\"backendId\\", \\"key\\") WHERE (\\"backendId\\" <> ''host'');"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_original_file";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_asset_original_file_backendId_key_idx';`.execute(db);
}
