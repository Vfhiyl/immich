import { CreateDateColumn, ForeignKeyColumn, type Generated, Table, type Timestamp } from '@immich/sql-tools';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** A person a user said a face is not: never given to it again by an automatic grouping */
@Table({ name: 'face_user_rejection' })
export class FaceUserRejectionTable {
  @ForeignKeyColumn(() => AssetFaceTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: false })
  faceId!: string;

  @ForeignKeyColumn(() => PersonGroupTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  personGroupId!: string;

  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'SET NULL', nullable: true })
  userId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
