import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "login_code" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "code" bytea NOT NULL,
  "userId" uuid NOT NULL,
  "createdById" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "expiresAt" timestamp with time zone NOT NULL,
  CONSTRAINT "login_code_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "login_code_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "login_code_code_uq" UNIQUE ("code"),
  CONSTRAINT "login_code_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "login_code_userId_idx" ON "login_code" ("userId");`.execute(db);
  await sql`CREATE INDEX "login_code_createdById_idx" ON "login_code" ("createdById");`.execute(db);
  await sql`CREATE INDEX "login_code_expiresAt_idx" ON "login_code" ("expiresAt");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "login_code";`.execute(db);
}
