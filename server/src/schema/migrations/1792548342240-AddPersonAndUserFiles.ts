import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "person_thumbnail_file" (
  "ownerId" uuid NOT NULL,
  "personGroupId" uuid NOT NULL,
  "backendId" character varying NOT NULL,
  "key" character varying NOT NULL,
  "size" bigint,
  "checksum" bytea,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "person_thumbnail_file_backendId_fkey" FOREIGN KEY ("backendId") REFERENCES "storage_backend" ("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "person_thumbnail_file_ownerId_personGroupId_fkey" FOREIGN KEY ("ownerId", "personGroupId") REFERENCES "person" ("ownerId", "personGroupId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_thumbnail_file_pkey" PRIMARY KEY ("ownerId", "personGroupId")
);`.execute(db);
  await sql`CREATE UNIQUE INDEX "person_thumbnail_file_backendId_key_idx" ON "person_thumbnail_file" ("backendId", "key") WHERE ("backendId" <> 'host');`.execute(db);
  await sql`CREATE TABLE "user_profile_image_file" (
  "userId" uuid NOT NULL,
  "backendId" character varying NOT NULL,
  "key" character varying NOT NULL,
  "size" bigint,
  "checksum" bytea,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "user_profile_image_file_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "user_profile_image_file_backendId_fkey" FOREIGN KEY ("backendId") REFERENCES "storage_backend" ("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "user_profile_image_file_pkey" PRIMARY KEY ("userId")
);`.execute(db);
  await sql`CREATE UNIQUE INDEX "user_profile_image_file_backendId_key_idx" ON "user_profile_image_file" ("backendId", "key") WHERE ("backendId" <> 'host');`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_person_thumbnail_file_backendId_key_idx', '{"type":"index","name":"person_thumbnail_file_backendId_key_idx","sql":"CREATE UNIQUE INDEX \\"person_thumbnail_file_backendId_key_idx\\" ON \\"person_thumbnail_file\\" (\\"backendId\\", \\"key\\") WHERE (\\"backendId\\" <> ''host'');"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_user_profile_image_file_backendId_key_idx', '{"type":"index","name":"user_profile_image_file_backendId_key_idx","sql":"CREATE UNIQUE INDEX \\"user_profile_image_file_backendId_key_idx\\" ON \\"user_profile_image_file\\" (\\"backendId\\", \\"key\\") WHERE (\\"backendId\\" <> ''host'');"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "person_thumbnail_file";`.execute(db);
  await sql`DROP TABLE "user_profile_image_file";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_person_thumbnail_file_backendId_key_idx';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_user_profile_image_file_backendId_key_idx';`.execute(db);
}
