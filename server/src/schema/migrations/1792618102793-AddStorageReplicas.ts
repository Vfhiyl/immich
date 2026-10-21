import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION storage_replica_register()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      INSERT INTO storage_replica_copy ("replicaBackendId", "sourceBackendId", "key")
      SELECT source."replicaBackendId", file."backendId", file."key"
      FROM recorded_rows file
      JOIN storage_replica_source source ON source."sourceBackendId" = file."backendId"
      ON CONFLICT DO NOTHING;
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "asset_original_file_after_update"
  AFTER UPDATE ON "asset_original_file"
  REFERENCING NEW TABLE AS "recorded_rows"
  FOR EACH STATEMENT
  EXECUTE FUNCTION storage_replica_register();`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "asset_original_file_after_insert"
  AFTER INSERT ON "asset_original_file"
  REFERENCING NEW TABLE AS "recorded_rows"
  FOR EACH STATEMENT
  EXECUTE FUNCTION storage_replica_register();`.execute(db);
  await sql`CREATE TABLE "storage_replica_source" (
  "replicaBackendId" character varying NOT NULL,
  "sourceBackendId" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "storage_replica_source_replicaBackendId_fkey" FOREIGN KEY ("replicaBackendId") REFERENCES "storage_backend" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "storage_replica_source_sourceBackendId_fkey" FOREIGN KEY ("sourceBackendId") REFERENCES "storage_backend" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "storage_replica_source_pkey" PRIMARY KEY ("replicaBackendId", "sourceBackendId")
);`.execute(db);
  await sql`CREATE INDEX "storage_replica_source_sourceBackendId_idx" ON "storage_replica_source" ("sourceBackendId");`.execute(db);
  await sql`CREATE TABLE "storage_replica_copy" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "replicaBackendId" character varying NOT NULL,
  "sourceBackendId" character varying NOT NULL,
  "key" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "completedAt" timestamp with time zone,
  "size" bigint,
  "attempts" integer NOT NULL DEFAULT 0,
  "nextAttemptAt" timestamp with time zone NOT NULL DEFAULT now(),
  "leaseUntil" timestamp with time zone,
  "lastError" character varying,
  CONSTRAINT "storage_replica_copy_replicaBackendId_fkey" FOREIGN KEY ("replicaBackendId") REFERENCES "storage_backend" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "storage_replica_copy_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "storage_replica_copy_pending_idx" ON "storage_replica_copy" ("nextAttemptAt") WHERE ("completedAt" IS NULL);`.execute(db);
  await sql`CREATE INDEX "storage_replica_copy_replica_key_idx" ON "storage_replica_copy" ("replicaBackendId", "sourceBackendId", "key");`.execute(db);
  await sql`CREATE UNIQUE INDEX "storage_replica_copy_source_key_replica_idx" ON "storage_replica_copy" ("sourceBackendId", "key", "replicaBackendId");`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_storage_replica_register', '{"type":"function","name":"storage_replica_register","sql":"CREATE OR REPLACE FUNCTION storage_replica_register()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      INSERT INTO storage_replica_copy (\\"replicaBackendId\\", \\"sourceBackendId\\", \\"key\\")\\n      SELECT source.\\"replicaBackendId\\", file.\\"backendId\\", file.\\"key\\"\\n      FROM recorded_rows file\\n      JOIN storage_replica_source source ON source.\\"sourceBackendId\\" = file.\\"backendId\\"\\n      ON CONFLICT DO NOTHING;\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_asset_original_file_after_update', '{"type":"trigger","name":"asset_original_file_after_update","sql":"CREATE OR REPLACE TRIGGER \\"asset_original_file_after_update\\"\\n  AFTER UPDATE ON \\"asset_original_file\\"\\n  REFERENCING NEW TABLE AS \\"recorded_rows\\"\\n  FOR EACH STATEMENT\\n  EXECUTE FUNCTION storage_replica_register();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_asset_original_file_after_insert', '{"type":"trigger","name":"asset_original_file_after_insert","sql":"CREATE OR REPLACE TRIGGER \\"asset_original_file_after_insert\\"\\n  AFTER INSERT ON \\"asset_original_file\\"\\n  REFERENCING NEW TABLE AS \\"recorded_rows\\"\\n  FOR EACH STATEMENT\\n  EXECUTE FUNCTION storage_replica_register();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_storage_replica_copy_pending_idx', '{"type":"index","name":"storage_replica_copy_pending_idx","sql":"CREATE INDEX \\"storage_replica_copy_pending_idx\\" ON \\"storage_replica_copy\\" (\\"nextAttemptAt\\") WHERE (\\"completedAt\\" IS NULL);"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER "asset_original_file_after_update" ON "asset_original_file";`.execute(db);
  await sql`DROP TRIGGER "asset_original_file_after_insert" ON "asset_original_file";`.execute(db);
  await sql`DROP FUNCTION storage_replica_register;`.execute(db);
  await sql`DROP TABLE "storage_replica_source";`.execute(db);
  await sql`DROP TABLE "storage_replica_copy";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_storage_replica_register';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_asset_original_file_after_update';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_asset_original_file_after_insert';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_storage_replica_copy_pending_idx';`.execute(db);
}
