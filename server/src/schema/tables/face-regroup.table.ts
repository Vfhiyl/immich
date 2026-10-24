import { CreateDateColumn, ForeignKeyColumn, type Generated, Table, type Timestamp } from '@immich/sql-tools';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';

/**
 * Who every face belonged to as the people were regrouped after a change of the face model: what the regroup changed
 * is shown against it, and undoing it puts the faces back
 */
@Table({ name: 'face_regroup' })
export class FaceRegroupTable {
  @ForeignKeyColumn(() => AssetFaceTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  faceId!: string;

  @ForeignKeyColumn(() => PersonGroupTable, { onUpdate: 'CASCADE', onDelete: 'SET NULL', nullable: true })
  before!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
