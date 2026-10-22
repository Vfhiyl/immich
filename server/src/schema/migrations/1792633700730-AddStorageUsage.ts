import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "storage_request_usage" (
  "day" date NOT NULL,
  "backendId" character varying NOT NULL,
  "operation" character varying NOT NULL,
  "purpose" character varying NOT NULL,
  "requests" bigint NOT NULL,
  "bytesSent" bigint NOT NULL,
  "bytesReceived" bigint NOT NULL,
  CONSTRAINT "storage_request_usage_pkey" PRIMARY KEY ("day", "backendId", "operation", "purpose")
);`.execute(db);
  await sql`CREATE TABLE "storage_usage_daily" (
  "day" date NOT NULL,
  "backendId" character varying NOT NULL,
  "category" character varying NOT NULL,
  "objects" bigint NOT NULL,
  "bytes" bigint NOT NULL,
  CONSTRAINT "storage_usage_daily_pkey" PRIMARY KEY ("day", "backendId", "category")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "storage_request_usage";`.execute(db);
  await sql`DROP TABLE "storage_usage_daily";`.execute(db);
}
