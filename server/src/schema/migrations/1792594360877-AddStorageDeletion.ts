import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "storage_deletion" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "backendId" character varying NOT NULL,
  "key" character varying NOT NULL,
  "notBefore" timestamp with time zone NOT NULL,
  "isOriginal" boolean NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "attempts" integer NOT NULL DEFAULT 0,
  "lastError" character varying,
  "ownerId" uuid,
  "originalFileName" character varying,
  "originalPath" character varying,
  "fileCreatedAt" timestamp with time zone,
  "size" bigint,
  "checksum" bytea,
  "encryption" bytea,
  CONSTRAINT "storage_deletion_backendId_fkey" FOREIGN KEY ("backendId") REFERENCES "storage_backend" ("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "storage_deletion_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "storage_deletion_notBefore_idx" ON "storage_deletion" ("notBefore");`.execute(db);
  await sql`CREATE UNIQUE INDEX "storage_deletion_backendId_key_idx" ON "storage_deletion" ("backendId", "key");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "storage_deletion";`.execute(db);
}
