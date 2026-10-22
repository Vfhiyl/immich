import { BadRequestException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { SystemConfig } from 'src/dtos/config.dto.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  StorageBackendUsageDto,
  StorageCostDto,
  StorageUsageQueryDto,
  StorageUsageResponseDto,
} from 'src/dtos/storage-usage.dto.js';
import { JobName, JobStatus, QueueName, StorageUsageCategory } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { handlePromiseError } from 'src/utils/misc.js';

/**
 * Counted requests are written to the database this often, and when the application closes; a process that is killed
 * loses what it counted since, which is little enough for estimates
 */
const FLUSH_INTERVAL_MS = 10 * 1000;
/** Usage is kept for three years, like the reports of the storage checks */
const USAGE_RETENTION_YEARS = 3;
/** The usage shown when no range is asked for */
const DEFAULT_RANGE_DAYS = 30;
const GIB = 1024 ** 3;
/** Prices per month are spread over the days of a month of 30 days */
const DAYS_PER_MONTH = 30;

export enum StoragePriceClass {
  Write = 'write',
  Read = 'read',
  Delete = 'delete',
}

/** How services charge for a request: reads (GET, HEAD), deletes, and everything else (PUT, POST, LIST) */
export const toPriceClass = (operation: string): StoragePriceClass => {
  if (['GetObject', 'HeadObject'].includes(operation)) {
    return StoragePriceClass.Read;
  }
  if (['DeleteObject', 'DeleteObjects', 'AbortMultipartUpload'].includes(operation)) {
    return StoragePriceClass.Delete;
  }
  return StoragePriceClass.Write;
};

type Pricing = SystemConfig['storagePricing']['backends'][number];
type Requests = Record<StoragePriceClass, number>;

const noRequests = (): Requests => ({ write: 0, read: 0, delete: 0 });

const round = (value: number) => Math.round(value * 10_000) / 10_000;

const toCost = (
  pricing: Pricing | undefined,
  { storedBytes, requests, bytesReceived }: { storedBytes: number; requests: Requests; bytesReceived: number },
): StorageCostDto | null => {
  if (!pricing) {
    return null;
  }
  const storage = (storedBytes / GIB) * (pricing.storageGbMonth / DAYS_PER_MONTH);
  const requestCost =
    (requests.write * pricing.writeRequests10k +
      requests.read * pricing.readRequests10k +
      requests.delete * pricing.deleteRequests10k) /
    10_000;
  const egress = (bytesReceived / GIB) * pricing.egressGb;
  return {
    currency: pricing.currency,
    storage: round(storage),
    requests: round(requestCost),
    egress: round(egress),
    total: round(storage + requestCost + egress),
  };
};

const sumCosts = (costs: Array<StorageCostDto | null>): StorageCostDto | null => {
  const known = costs.filter((cost) => cost !== null);
  if (known.length === 0) {
    return null;
  }
  const sum = (key: 'storage' | 'requests' | 'egress' | 'total') =>
    round(known.reduce((total, cost) => total + cost[key], 0));
  return {
    currency: known[0].currency,
    storage: sum('storage'),
    requests: sum('requests'),
    egress: sum('egress'),
    total: sum('total'),
  };
};

/**
 * What the storage backends store and the requests made to them, per day, and what that costs by the prices the
 * deployment filled in. Requests are counted as they are sent and written to the database every minute; what is stored
 * is recorded every night from the records of the files. Both are estimates: the bill of the service is what counts.
 */
@Injectable()
export class StorageUsageService extends BaseService {
  private flushTimer?: NodeJS.Timeout;

  @OnEvent({ name: 'AppBootstrap' })
  onBootstrap() {
    if (!this.storageBackendRepository.hasConfiguredBackends()) {
      return;
    }
    this.flushTimer = setInterval(() => handlePromiseError(this.flush(), this.logger), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    clearInterval(this.flushTimer);
    await this.flush();
  }

  /** Write the counted requests to the database; counts that cannot be written are lost, as they are estimates */
  async flush() {
    const usage = this.storageBackendRepository.drainRequestUsage();
    try {
      await this.storageUsageRepository.addRequests(usage);
    } catch (error) {
      this.logger.warn(`Unable to record ${usage.length} counts of storage requests: ${error}`);
    }
  }

  @OnJob({ name: JobName.StorageUsageSnapshot, queue: QueueName.BackgroundTask })
  async handleSnapshot(): Promise<JobStatus> {
    if (!this.storageBackendRepository.hasConfiguredBackends()) {
      return JobStatus.Skipped;
    }

    await this.flush();
    const today = DateTime.utc();
    await this.storageUsageRepository.recordStored(today.toISODate());
    await this.storageUsageRepository.removeBefore(today.minus({ years: USAGE_RETENTION_YEARS }).toISODate());
    return JobStatus.Success;
  }

  async getUsage({ from, to }: StorageUsageQueryDto): Promise<StorageUsageResponseDto> {
    const end = to ?? DateTime.utc().toISODate();
    const start =
      from ??
      DateTime.fromISO(end, { zone: 'utc' })
        .minus({ days: DEFAULT_RANGE_DAYS - 1 })
        .toISODate()!;
    if (start > end) {
      throw new BadRequestException('The range starts after it ends');
    }

    const { storagePricing } = await this.getConfig({ withCache: true });
    const [requests, stored] = await Promise.all([
      this.storageUsageRepository.getRequests(start, end),
      this.storageUsageRepository.getStored(start, end),
    ]);

    const backendIds = new Set([
      ...this.storageBackendRepository.getConfiguredBackends().map(({ id }) => id),
      ...requests.map(({ backendId }) => backendId),
      ...stored.map(({ backendId }) => backendId),
    ]);
    const backends: StorageBackendUsageDto[] = [];
    for (const backendId of [...backendIds].toSorted((a, b) => a.localeCompare(b))) {
      const pricing = storagePricing.backends.find((pricing) => pricing.backendId === backendId);
      const ofBackend = requests.filter((row) => row.backendId === backendId);
      const storedOfBackend = stored.filter((row) => row.backendId === backendId);
      const days = [...new Set([...ofBackend, ...storedOfBackend].map(({ day }) => day))].toSorted();

      const dailyUsage = days.map((day) => {
        const storedOfDay = storedOfBackend.filter((row) => row.day === day);
        const requestsOfDay = ofBackend.filter((row) => row.day === day);
        const byClass = noRequests();
        for (const row of requestsOfDay) {
          byClass[toPriceClass(row.operation)] += Number(row.requests);
        }
        const usage = {
          day,
          storedObjects: storedOfDay.reduce((total, row) => total + Number(row.objects), 0),
          storedBytes: storedOfDay.reduce((total, row) => total + Number(row.bytes), 0),
          stored: Object.fromEntries(
            storedOfDay.map((row) => [row.category, { objects: Number(row.objects), bytes: Number(row.bytes) }]),
          ) as Partial<Record<StorageUsageCategory, { objects: number; bytes: number }>>,
          requests: byClass,
          bytesSent: requestsOfDay.reduce((total, row) => total + Number(row.bytesSent), 0),
          bytesReceived: requestsOfDay.reduce((total, row) => total + Number(row.bytesReceived), 0),
        };
        return { ...usage, cost: toCost(pricing, usage) };
      });

      const purposes = Map.groupBy(ofBackend, ({ purpose }) => purpose);
      const byPurpose = [...purposes].map(([purpose, rows]) => {
        const byClass = noRequests();
        for (const row of rows) {
          byClass[toPriceClass(row.operation)] += Number(row.requests);
        }
        const bytesReceived = rows.reduce((total, row) => total + Number(row.bytesReceived), 0);
        return {
          purpose,
          requests: byClass,
          bytesSent: rows.reduce((total, row) => total + Number(row.bytesSent), 0),
          bytesReceived,
          cost: toCost(pricing, { storedBytes: 0, requests: byClass, bytesReceived }),
        };
      });

      backends.push({
        backendId,
        days: dailyUsage,
        purposes: byPurpose.toSorted((a, b) => a.purpose.localeCompare(b.purpose)),
        cost: sumCosts(dailyUsage.map(({ cost }) => cost)),
      });
    }

    return { from: start, to: end, backends };
  }
}
