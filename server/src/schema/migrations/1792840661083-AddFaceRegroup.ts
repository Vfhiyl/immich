import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "face_regroup" (
  "faceId" uuid NOT NULL,
  "before" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "face_regroup_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES "asset_face" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "face_regroup_before_fkey" FOREIGN KEY ("before") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "face_regroup_pkey" PRIMARY KEY ("faceId")
);`.execute(db);
  await sql`CREATE INDEX "face_regroup_before_idx" ON "face_regroup" ("before");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "face_regroup";`.execute(db);
}
