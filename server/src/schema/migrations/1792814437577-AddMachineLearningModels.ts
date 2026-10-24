import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "ml_model" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "task" character varying NOT NULL,
  "name" character varying NOT NULL,
  "fingerprint" character varying,
  "format" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "lastSeenAt" timestamp with time zone NOT NULL DEFAULT now(),
  "retiredAt" timestamp with time zone,
  CONSTRAINT "ml_model_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE UNIQUE INDEX "ml_model_task_name_uq" ON "ml_model" ("task", "name") WHERE ("fingerprint" IS NULL);`.execute(db);
  await sql`CREATE UNIQUE INDEX "ml_model_task_name_fingerprint_uq" ON "ml_model" ("task", "name", "fingerprint") WHERE ("fingerprint" IS NOT NULL);`.execute(db);
  await sql`CREATE TABLE "asset_ml_result" (
  "assetId" uuid NOT NULL,
  "task" character varying NOT NULL,
  "modelId" uuid NOT NULL,
  CONSTRAINT "asset_ml_result_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_ml_result_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ml_model" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_ml_result_pkey" PRIMARY KEY ("assetId", "task")
);`.execute(db);
  await sql`CREATE INDEX "asset_ml_result_modelId_idx" ON "asset_ml_result" ("modelId");`.execute(db);
  await sql`CREATE TABLE "smart_search_rebuild" (
  "assetId" uuid NOT NULL,
  "modelId" uuid NOT NULL,
  "embedding" vector NOT NULL,
  CONSTRAINT "smart_search_rebuild_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "smart_search_rebuild_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ml_model" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "smart_search_rebuild_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`ALTER TABLE "smart_search_rebuild" ALTER COLUMN "embedding" SET STORAGE EXTERNAL;`.execute(db);
  await sql`CREATE INDEX "smart_search_rebuild_modelId_idx" ON "smart_search_rebuild" ("modelId");`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_ml_model_task_name_uq', '{"type":"index","name":"ml_model_task_name_uq","sql":"CREATE UNIQUE INDEX \\"ml_model_task_name_uq\\" ON \\"ml_model\\" (\\"task\\", \\"name\\") WHERE (\\"fingerprint\\" IS NULL);"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_ml_model_task_name_fingerprint_uq', '{"type":"index","name":"ml_model_task_name_fingerprint_uq","sql":"CREATE UNIQUE INDEX \\"ml_model_task_name_fingerprint_uq\\" ON \\"ml_model\\" (\\"task\\", \\"name\\", \\"fingerprint\\") WHERE (\\"fingerprint\\" IS NOT NULL);"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_ml_result";`.execute(db);
  await sql`DROP TABLE "smart_search_rebuild";`.execute(db);
  await sql`DROP TABLE "ml_model";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_ml_model_task_name_uq';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_ml_model_task_name_fingerprint_uq';`.execute(db);
}
