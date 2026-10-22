import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { UploadSessionStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { UploadSessionTable } from 'src/schema/tables/upload-session.table.js';

@Injectable()
export class UploadSessionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  create(session: Insertable<UploadSessionTable>) {
    return this.db.insertInto('upload_session').values(session).returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db.selectFrom('upload_session').selectAll().where('id', '=', id).executeTakeFirst();
  }

  update(id: string, session: Updateable<UploadSessionTable>) {
    return this.db
      .updateTable('upload_session')
      .set({ ...session, updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('upload_session').where('id', '=', id).execute();
  }

  /** The bytes that uploads of a user still being received will add, which their quota has to leave room for */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getReservedBytes(ownerId: string): Promise<number> {
    const { reserved } = await this.db
      .selectFrom('upload_session')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('length'), eb.lit(0)).as('reserved'))
      .where('ownerId', '=', ownerId)
      .where('status', '=', UploadSessionStatus.Receiving)
      .executeTakeFirstOrThrow();
    return Number(reserved);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getByOwner(ownerId: string) {
    return this.db.selectFrom('upload_session').selectAll().where('ownerId', '=', ownerId).execute();
  }

  @GenerateSql({ params: [DummyValue.DATE] })
  getExpired(now: Date) {
    return this.db.selectFrom('upload_session').selectAll().where('expiresAt', '<', now).limit(1000).execute();
  }
}
