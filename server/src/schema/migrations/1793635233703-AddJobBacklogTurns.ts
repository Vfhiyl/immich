import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "job_backlog" ADD "ownerId" uuid;`.execute(db);
  await sql`ALTER TABLE "job_backlog" ADD "turn" bigint NOT NULL DEFAULT 0;`.execute(db);
  await sql`CREATE INDEX "job_backlog_queueName_ownerId_turn_idx" ON "job_backlog" ("queueName", "ownerId", "turn");`.execute(db);
  await sql`CREATE INDEX "job_backlog_queueName_priority_turn_id_idx" ON "job_backlog" ("queueName", "priority", "turn", "id");`.execute(db);
  await sql`DROP INDEX "job_backlog_queueName_priority_id_idx";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "job_backlog" DROP COLUMN "ownerId";`.execute(db);
  await sql`ALTER TABLE "job_backlog" DROP COLUMN "turn";`.execute(db);
  await sql`CREATE INDEX "job_backlog_queueName_priority_id_idx" ON "job_backlog" ("queueName", "priority", "id");`.execute(db);
  await sql`DROP INDEX "job_backlog_queueName_ownerId_turn_idx";`.execute(db);
  await sql`DROP INDEX "job_backlog_queueName_priority_turn_id_idx";`.execute(db);
}
