import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { StorageRequestUsage } from 'src/utils/storage-metering.js';
import { GenerateSql } from 'src/decorators.js';
import { BuiltinStorageBackend, StorageUsageCategory } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

const builtinBackends = Object.values(BuiltinStorageBackend);

/**
 * The bytes an encrypted file takes besides its content, roughly: a tag for every chunk of 64 KiB, and a trailer of a
 * few hundred bytes. Stored sizes are estimates either way; the bill of the service is what counts.
 */
const encryptedSize = (size: string, encryption: string) =>
  sql<number>`coalesce(${sql.ref(size)}, 0) + case when ${sql.ref(encryption)} is null then 0
    else greatest(1, ceil(coalesce(${sql.ref(size)}, 0) / 65536.0)) * 16 + 512 end`;

@Injectable()
export class StorageUsageRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Add counted requests to what is recorded for their day */
  async addRequests(usage: StorageRequestUsage[]) {
    if (usage.length === 0) {
      return;
    }
    await this.db
      .insertInto('storage_request_usage')
      .values(usage)
      .onConflict((oc) =>
        oc.columns(['day', 'backendId', 'operation', 'purpose']).doUpdateSet((eb) => ({
          requests: eb('storage_request_usage.requests', '+', eb.ref('excluded.requests')),
          bytesSent: eb('storage_request_usage.bytesSent', '+', eb.ref('excluded.bytesSent')),
          bytesReceived: eb('storage_request_usage.bytesReceived', '+', eb.ref('excluded.bytesReceived')),
        })),
      )
      .execute();
  }

  /** Record what each configured backend stores now, as the usage of `day`, replacing what was recorded for it */
  @GenerateSql({ params: ['2026-10-22'] })
  async recordStored(day: string) {
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('storage_usage_daily').where('day', '=', day).execute();
      await sql`
        insert into "storage_usage_daily" ("day", "backendId", "category", "objects", "bytes")
        select ${day}::date, "backendId", "category", count(*), coalesce(sum("bytes"), 0)
        from (
          select "backendId", ${StorageUsageCategory.Files} as "category", ${encryptedSize('size', 'encryption')} as "bytes"
          from "asset_file"
          union all
          select "backendId", ${StorageUsageCategory.Files}, ${encryptedSize('size', 'encryption')}
          from "asset_original_file"
          union all
          select "backendId", ${StorageUsageCategory.Files}, ${encryptedSize('size', 'encryption')}
          from "person_thumbnail_file"
          union all
          select "backendId", ${StorageUsageCategory.Files}, ${encryptedSize('size', 'encryption')}
          from "user_profile_image_file"
          union all
          -- the size of derived files that wait for their deletion is not recorded
          select "backendId", ${StorageUsageCategory.PendingDeletion}, ${encryptedSize('size', 'encryption')}
          from "storage_deletion"
          union all
          select "backendId", ${StorageUsageCategory.Uploading}, "committedOffset" from "upload_session"
          union all
          select "replicaBackendId", ${StorageUsageCategory.Copies}, coalesce("size", 0)
          from "storage_replica_copy" where "completedAt" is not null
        ) as "stored"
        where "backendId" not in (${sql.join(builtinBackends)})
        group by "backendId", "category"
      `.execute(tx);
    });
  }

  @GenerateSql({ params: ['2026-10-01', '2026-10-31'] })
  getRequests(from: string, to: string) {
    return this.db
      .selectFrom('storage_request_usage')
      .select([
        sql<string>`"day"::text`.as('day'),
        'backendId',
        'operation',
        'purpose',
        'requests',
        'bytesSent',
        'bytesReceived',
      ])
      .where('day', '>=', from)
      .where('day', '<=', to)
      .orderBy('day')
      .orderBy('backendId')
      .execute();
  }

  @GenerateSql({ params: ['2026-10-01', '2026-10-31'] })
  getStored(from: string, to: string) {
    return this.db
      .selectFrom('storage_usage_daily')
      .select([sql<string>`"day"::text`.as('day'), 'backendId', 'category', 'objects', 'bytes'])
      .where('day', '>=', from)
      .where('day', '<=', to)
      .orderBy('day')
      .orderBy('backendId')
      .execute();
  }

  /** Forget usage older than `before` */
  @GenerateSql({ params: ['2023-10-22'] })
  async removeBefore(before: string) {
    await this.db.deleteFrom('storage_request_usage').where('day', '<', before).execute();
    await this.db.deleteFrom('storage_usage_daily').where('day', '<', before).execute();
  }
}
