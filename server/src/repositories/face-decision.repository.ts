import { Injectable } from '@nestjs/common';
import { Kysely, NotNull } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';

/**
 * What users decided about faces, kept apart from what the models made of them: the person a user gave a face, and the
 * people a user said a face is not. Automatic grouping keeps to them, also after a change of the face model.
 */
@Injectable()
export class FaceDecisionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** A user gave faces to a person: they are its from now on, and not the person they had before, if another */
  @GenerateSql({ params: [[{ faceId: DummyValue.UUID, previous: DummyValue.UUID }], DummyValue.UUID, DummyValue.UUID] })
  async assign(
    faces: Array<{ faceId: string; previous: string | null }>,
    personGroupId: string,
    userId: string,
  ): Promise<void> {
    if (faces.length === 0) {
      return;
    }
    const faceIds = faces.map(({ faceId }) => faceId);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('face_user_assignment')
        .values(faceIds.map((faceId) => ({ faceId, personGroupId, userId })))
        .onConflict((oc) =>
          oc.column('faceId').doUpdateSet((eb) => ({
            personGroupId: eb.ref('excluded.personGroupId'),
            userId: eb.ref('excluded.userId'),
            createdAt: eb.ref('excluded.createdAt'),
          })),
        )
        .execute();
      // it is this person after all
      await trx
        .deleteFrom('face_user_rejection')
        .where('faceId', 'in', faceIds)
        .where('personGroupId', '=', personGroupId)
        .execute();
      const rejected = faces.filter(({ previous }) => previous && previous !== personGroupId);
      if (rejected.length > 0) {
        await trx
          .insertInto('face_user_rejection')
          .values(rejected.map(({ faceId, previous }) => ({ faceId, personGroupId: previous!, userId })))
          .onConflict((oc) => oc.columns(['faceId', 'personGroupId']).doNothing())
          .execute();
      }
    });
  }

  /** Takes a face from its person: the user said it is not this person */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.UUID] })
  async unassign(faceId: string, personGroupId: string, userId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('asset_face')
        .set({ personGroupId: null })
        .where('id', '=', faceId)
        .where('personGroupId', '=', personGroupId)
        .execute();
      await trx
        .insertInto('face_user_rejection')
        .values({ faceId, personGroupId, userId })
        .onConflict((oc) => oc.columns(['faceId', 'personGroupId']).doNothing())
        .execute();
      await trx.deleteFrom('face_user_assignment').where('faceId', '=', faceId).execute();
    });
  }

  /** The decisions about one person follow its faces into another, as people of an owner are merged */
  @GenerateSql({
    params: [{ oldPersonGroupId: DummyValue.UUID, newPersonGroupId: DummyValue.UUID, ownerId: DummyValue.UUID }],
  })
  async move({
    oldPersonGroupId,
    newPersonGroupId,
    ownerId,
  }: {
    oldPersonGroupId: string;
    newPersonGroupId: string;
    ownerId: string;
  }): Promise<void> {
    const ofOwner = this.db.selectFrom('asset_face').select('asset_face.id').where('asset_face.ownerId', '=', ownerId);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('face_user_assignment')
        .set({ personGroupId: newPersonGroupId })
        .where('personGroupId', '=', oldPersonGroupId)
        .where('faceId', 'in', ofOwner)
        .execute();
      await trx
        .insertInto('face_user_rejection')
        .columns(['faceId', 'personGroupId', 'userId', 'createdAt'])
        .expression((eb) =>
          eb
            .selectFrom('face_user_rejection')
            .select(['faceId', eb.val(newPersonGroupId).as('personGroupId'), 'userId', 'createdAt'])
            .where('personGroupId', '=', oldPersonGroupId)
            .where('faceId', 'in', ofOwner),
        )
        .onConflict((oc) => oc.columns(['faceId', 'personGroupId']).doNothing())
        .execute();
    });
  }

  /**
   * The people a face cannot be given automatically: those a user said it is not, and those of the other faces of its
   * photo (two faces of one photo are two people)
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getExcludedPeople(faceId: string): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('face_user_rejection')
      .select('personGroupId')
      .where('faceId', '=', faceId)
      .union((eb) =>
        eb
          .selectFrom('asset_face as other')
          .innerJoin('asset_face as face', 'face.assetId', 'other.assetId')
          .select('other.personGroupId')
          .where('face.id', '=', faceId)
          .where('other.id', '!=', faceId)
          .where('other.deletedAt', 'is', null)
          .where('other.personGroupId', 'is not', null)
          .$narrowType<{ personGroupId: NotNull }>(),
      )
      .execute();
    return new Set(rows.map(({ personGroupId }) => personGroupId));
  }

  /** Of `faceIds`, those whose person a user gave */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getAssigned(faceIds: string[]): Promise<Set<string>> {
    if (faceIds.length === 0) {
      return new Set();
    }
    // while the face is still with the person the user gave it
    const rows = await this.db
      .selectFrom('face_user_assignment')
      .innerJoin('asset_face', (join) =>
        join
          .onRef('asset_face.id', '=', 'face_user_assignment.faceId')
          .onRef('asset_face.personGroupId', '=', 'face_user_assignment.personGroupId'),
      )
      .select('face_user_assignment.faceId')
      .where('face_user_assignment.faceId', 'in', faceIds)
      .execute();
    return new Set(rows.map(({ faceId }) => faceId));
  }
}
