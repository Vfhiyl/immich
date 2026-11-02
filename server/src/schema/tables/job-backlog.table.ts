import { Column, CreateDateColumn, type Generated, Index, type Int8, Table, type Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';

/**
 * A job waiting for room in its queue: a queue keeps only a window of jobs in redis, and the rest of a large batch (a
 * job for every asset of the library, say) waits here, on disk instead of in memory
 */
@Table({ name: 'job_backlog' })
@Index({ columns: ['queueName', 'priority', 'turn', 'id'] })
@Index({ columns: ['queueName', 'ownerId', 'turn'] })
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

  /** The user the job is for (of its asset, or its owner), if any: the jobs of users take turns (see `turn`) */
  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

  /**
   * Its turn among the jobs of its user in the queue: jobs come out by turn, so that one user who uploads 50,000 photos
   * does not hold back the photos of others behind them
   */
  @Column({ type: 'bigint', default: 0 })
  turn!: Generated<Int8>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
