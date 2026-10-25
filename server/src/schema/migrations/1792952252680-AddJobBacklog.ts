import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "job_backlog" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "queueName" character varying NOT NULL,
  "name" character varying NOT NULL,
  "data" jsonb NOT NULL,
  "priority" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "job_backlog_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "job_backlog_queueName_priority_id_idx" ON "job_backlog" ("queueName", "priority", "id");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "job_backlog";`.execute(db);
}
