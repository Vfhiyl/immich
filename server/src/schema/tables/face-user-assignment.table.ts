import { CreateDateColumn, ForeignKeyColumn, type Generated, Table, type Timestamp } from '@immich/sql-tools';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * The person a user gave a face (in the web or the apps): kept by every automatic grouping, also after a change of
 * the face model. Faces drawn by hand or read from a file are the user's without a row here.
 */
@Table({ name: 'face_user_assignment' })
export class FaceUserAssignmentTable {
  @ForeignKeyColumn(() => AssetFaceTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  faceId!: string;

  @ForeignKeyColumn(() => PersonGroupTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE' })
  personGroupId!: string;

  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'SET NULL', nullable: true })
  userId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
