import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "storage_check_run" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "kind" character varying NOT NULL,
  "status" character varying NOT NULL,
  "startedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "finishedAt" timestamp with time zone,
  "stats" jsonb NOT NULL,
  CONSTRAINT "storage_check_run_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "storage_check_run_startedAt_idx" ON "storage_check_run" ("startedAt");`.execute(db);
  await sql`CREATE TABLE "storage_issue" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "backendId" character varying NOT NULL,
  "key" character varying NOT NULL,
  "kind" character varying NOT NULL,
  "detail" character varying,
  "firstSeenAt" timestamp with time zone NOT NULL DEFAULT now(),
  "lastSeenAt" timestamp with time zone NOT NULL,
  "sightings" integer NOT NULL DEFAULT 1,
  "confirmedAt" timestamp with time zone,
  "resolvedAt" timestamp with time zone,
  "acknowledgedAt" timestamp with time zone,
  CONSTRAINT "storage_issue_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "storage_issue_firstSeenAt_idx" ON "storage_issue" ("firstSeenAt");`.execute(db);
  await sql`CREATE UNIQUE INDEX "storage_issue_open_idx" ON "storage_issue" ("backendId", "key", "kind") WHERE ("resolvedAt" IS NULL);`.execute(db);
  await sql`CREATE TABLE "storage_listing" (
  "backendId" character varying NOT NULL,
  "key" character varying NOT NULL,
  "size" bigint NOT NULL,
  "lastModified" timestamp with time zone NOT NULL,
  CONSTRAINT "storage_listing_pkey" PRIMARY KEY ("backendId", "key")
);`.execute(db);
  await sql`CREATE TABLE "storage_verification" (
  "backendId" character varying NOT NULL,
  "key" character varying NOT NULL,
  "verifiedAt" timestamp with time zone NOT NULL,
  "ok" boolean NOT NULL,
  CONSTRAINT "storage_verification_pkey" PRIMARY KEY ("backendId", "key")
);`.execute(db);
  await sql`CREATE INDEX "storage_verification_verifiedAt_idx" ON "storage_verification" ("verifiedAt");`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_storage_issue_open_idx', '{"type":"index","name":"storage_issue_open_idx","sql":"CREATE UNIQUE INDEX \\"storage_issue_open_idx\\" ON \\"storage_issue\\" (\\"backendId\\", \\"key\\", \\"kind\\") WHERE (\\"resolvedAt\\" IS NULL);"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "storage_check_run";`.execute(db);
  await sql`DROP TABLE "storage_issue";`.execute(db);
  await sql`DROP TABLE "storage_listing";`.execute(db);
  await sql`DROP TABLE "storage_verification";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_storage_issue_open_idx';`.execute(db);
}
