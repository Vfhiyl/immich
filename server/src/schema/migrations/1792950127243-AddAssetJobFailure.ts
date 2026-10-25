import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_job_failure" (
  "jobName" character varying NOT NULL,
  "assetId" uuid NOT NULL,
  "attempts" integer NOT NULL DEFAULT 1,
  "error" text,
  "serverVersion" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_job_failure_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_job_failure_pkey" PRIMARY KEY ("jobName", "assetId")
);`.execute(db);
  await sql`CREATE INDEX "asset_job_failure_assetId_idx" ON "asset_job_failure" ("assetId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_job_failure";`.execute(db);
}
