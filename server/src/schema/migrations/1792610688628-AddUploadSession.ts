import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "upload_session" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "ownerId" uuid NOT NULL,
  "status" character varying NOT NULL,
  "assetData" jsonb NOT NULL,
  "interopVersion" integer,
  "length" bigint,
  "declaredChecksum" bytea,
  "backendId" character varying NOT NULL,
  "key" character varying NOT NULL,
  "blobUploadId" character varying NOT NULL,
  "partSize" integer NOT NULL,
  "encryption" bytea,
  "parts" jsonb NOT NULL DEFAULT '[]',
  "committedOffset" bigint NOT NULL DEFAULT 0,
  "hashState" bytea,
  "assetId" uuid,
  "expiresAt" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "upload_session_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "upload_session_backendId_fkey" FOREIGN KEY ("backendId") REFERENCES "storage_backend" ("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "upload_session_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "upload_session_expiresAt_idx" ON "upload_session" ("expiresAt");`.execute(db);
  await sql`CREATE INDEX "upload_session_ownerId_idx" ON "upload_session" ("ownerId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "upload_session";`.execute(db);
}
