import {
  Column,
  CreateDateColumn,
  type Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  type Timestamp,
} from '@immich/sql-tools';

/**
 * The models that made results: a task, the name the model was asked by, and the fingerprint of its files (SHA-256,
 * reported by the machine learning service; null when it does not report one, as upstream's does not)
 */
@Table({ name: 'ml_model' })
@Index({
  name: 'ml_model_task_name_fingerprint_uq',
  columns: ['task', 'name', 'fingerprint'],
  unique: true,
  where: '"fingerprint" IS NOT NULL',
})
@Index({ name: 'ml_model_task_name_uq', columns: ['task', 'name'], unique: true, where: '"fingerprint" IS NULL' })
export class MachineLearningModelTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column()
  task!: string;

  @Column()
  name!: string;

  @Column({ nullable: true })
  fingerprint!: string | null;

  /** The format it ran in when last seen (onnx, armnn, rknn), for troubleshooting */
  @Column({ nullable: true })
  format!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  lastSeenAt!: Generated<Timestamp>;

  /** When other files of the same model replaced these */
  @Column({ type: 'timestamp with time zone', nullable: true })
  retiredAt!: Timestamp | null;
}
