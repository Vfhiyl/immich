import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_file" ADD "encryption" bytea;`.execute(db);
  await sql`ALTER TABLE "asset_original_file" ADD "encryption" bytea;`.execute(db);
  await sql`ALTER TABLE "person_thumbnail_file" ADD "encryption" bytea;`.execute(db);
  await sql`ALTER TABLE "user_profile_image_file" ADD "encryption" bytea;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_file" DROP COLUMN "encryption";`.execute(db);
  await sql`ALTER TABLE "asset_original_file" DROP COLUMN "encryption";`.execute(db);
  await sql`ALTER TABLE "person_thumbnail_file" DROP COLUMN "encryption";`.execute(db);
  await sql`ALTER TABLE "user_profile_image_file" DROP COLUMN "encryption";`.execute(db);
}
