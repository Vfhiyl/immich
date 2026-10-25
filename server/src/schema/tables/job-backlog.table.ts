import { Column, CreateDateColumn, type Generated, Index, Table, type Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';

/**
 * A job waiting for room in its queue: a queue keeps only a window of jobs in redis, and the rest of a large batch (a
 * job for every asset of the library, say) waits here, on disk instead of in memory
 */
@Table({ name: 'job_backlog' })
@Index({ columns: ['queueName', 'priority', 'id'] })
export class JobBacklogTable {
  /** In the order the jobs came, to the millisecond */
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @Column()
  queueName!: string;

  @Column()
  name!: string;

  @Column({ type: 'jsonb' })
  data!: unknown;

  /** As in the queue: 0 for none, which goes first, then the lowest */
  @Column({ type: 'integer', default: 0 })
  priority!: Generated<number>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
