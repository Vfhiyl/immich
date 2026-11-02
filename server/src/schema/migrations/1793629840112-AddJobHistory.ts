import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "job_run_hourly" (
  "hour" timestamp with time zone NOT NULL,
  "jobName" character varying NOT NULL,
  "queueName" character varying NOT NULL,
  "succeeded" integer NOT NULL DEFAULT 0,
  "failed" integer NOT NULL DEFAULT 0,
  "retried" integer NOT NULL DEFAULT 0,
  CONSTRAINT "job_run_hourly_pkey" PRIMARY KEY ("hour", "jobName")
);`.execute(db);
  await sql`CREATE TABLE "job_failure_log" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "jobName" character varying NOT NULL,
  "queueName" character varying NOT NULL,
  "assetId" uuid,
  "category" character varying NOT NULL,
  "reason" text NOT NULL,
  "error" text NOT NULL,
  CONSTRAINT "job_failure_log_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "job_failure_log_jobName_createdAt_idx" ON "job_failure_log" ("jobName", "createdAt");`.execute(db);
  await sql`CREATE INDEX "job_failure_log_createdAt_idx" ON "job_failure_log" ("createdAt");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "job_run_hourly";`.execute(db);
  await sql`DROP TABLE "job_failure_log";`.execute(db);
}
