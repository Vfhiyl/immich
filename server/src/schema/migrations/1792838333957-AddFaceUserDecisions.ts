import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "face_user_assignment" (
  "faceId" uuid NOT NULL,
  "personGroupId" uuid NOT NULL,
  "userId" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "face_user_assignment_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES "asset_face" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "face_user_assignment_personGroupId_fkey" FOREIGN KEY ("personGroupId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "face_user_assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "face_user_assignment_pkey" PRIMARY KEY ("faceId")
);`.execute(db);
  await sql`CREATE INDEX "face_user_assignment_personGroupId_idx" ON "face_user_assignment" ("personGroupId");`.execute(db);
  await sql`CREATE INDEX "face_user_assignment_userId_idx" ON "face_user_assignment" ("userId");`.execute(db);
  await sql`CREATE TABLE "face_user_rejection" (
  "faceId" uuid NOT NULL,
  "personGroupId" uuid NOT NULL,
  "userId" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "face_user_rejection_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES "asset_face" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "face_user_rejection_personGroupId_fkey" FOREIGN KEY ("personGroupId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "face_user_rejection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "face_user_rejection_pkey" PRIMARY KEY ("faceId", "personGroupId")
);`.execute(db);
  await sql`CREATE INDEX "face_user_rejection_personGroupId_idx" ON "face_user_rejection" ("personGroupId");`.execute(db);
  await sql`CREATE INDEX "face_user_rejection_userId_idx" ON "face_user_rejection" ("userId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "face_user_assignment";`.execute(db);
  await sql`DROP TABLE "face_user_rejection";`.execute(db);
}
