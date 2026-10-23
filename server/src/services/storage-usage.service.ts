import { BadRequestException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { SystemConfig } from 'src/dtos/config.dto.js';
import type { StorageUsageRepository } from 'src/repositories/storage-usage.repository.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import {
  StorageBackendUsageDto,
  StorageBudgetDto,
  StorageCostDto,
  StorageUsageQueryDto,
  StorageUsageResponseDto,
} from 'src/dtos/storage-usage.dto.js';
import {
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  QueueName,
  StorageUsageCategory,
  SystemMetadataKey,
} from 'src/enum.js';
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
  // S3, and Azure (whose read operations also include reading the list of blocks)
  if (['GetObject', 'HeadObject', 'GetBlob', 'GetBlobProperties', 'GetBlockList'].includes(operation)) {
    return StoragePriceClass.Read;
  }
  if (['DeleteObject', 'DeleteObjects', 'AbortMultipartUpload', 'DeleteBlob'].includes(operation)) {
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

type RequestRow = Awaited<ReturnType<StorageUsageRepository['getRequests']>>[number];
type StoredRow = Awaited<ReturnType<StorageUsageRepository['getStored']>>[number];

/** The usage of a backend per day and by what made the requests, from its rows */
const summarize = (pricing: Pricing | undefined, requests: RequestRow[], stored: StoredRow[]) => {
  const days = [...new Set([...requests, ...stored].map(({ day }) => day))].toSorted();

  const dailyUsage = days.map((day) => {
    const storedOfDay = stored.filter((row) => row.day === day);
    const requestsOfDay = requests.filter((row) => row.day === day);
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

  const purposes = Map.groupBy(requests, ({ purpose }) => purpose);
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

  return {
    days: dailyUsage,
    purposes: byPurpose.toSorted((a, b) => a.purpose.localeCompare(b.purpose)),
    cost: sumCosts(dailyUsage.map(({ cost }) => cost)),
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
    await this.remindOfBudgets();
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
    const budgets = await this.getBudgets(storagePricing.backends);

    const backendIds = new Set([
      ...this.storageBackendRepository.getConfiguredBackends().map(({ id }) => id),
      ...requests.map(({ backendId }) => backendId),
      ...stored.map(({ backendId }) => backendId),
    ]);
    const backends: StorageBackendUsageDto[] = [];
    for (const backendId of [...backendIds].toSorted((a, b) => a.localeCompare(b))) {
      const pricing = storagePricing.backends.find((pricing) => pricing.backendId === backendId);
      backends.push({
        backendId,
        ...summarize(
          pricing,
          requests.filter((row) => row.backendId === backendId),
          stored.filter((row) => row.backendId === backendId),
        ),
        budget: budgets.get(backendId) ?? null,
      });
    }

    return { from: start, to: end, backends };
  }

  /** The budgets of this calendar month (UTC), with what the month cost so far and will cost at that pace */
  private async getBudgets(pricings: Pricing[]): Promise<Map<string, StorageBudgetDto>> {
    const withBudget = pricings.filter((pricing) => pricing.monthlyBudget !== null);
    const budgets = new Map<string, StorageBudgetDto>();
    if (withBudget.length === 0) {
      return budgets;
    }

    const today = DateTime.utc();
    const [start, end] = [today.startOf('month').toISODate(), today.toISODate()];
    const [requests, stored] = await Promise.all([
      this.storageUsageRepository.getRequests(start, end),
      this.storageUsageRepository.getStored(start, end),
    ]);
    for (const pricing of withBudget) {
      const { cost } = summarize(
        pricing,
        requests.filter((row) => row.backendId === pricing.backendId),
        stored.filter((row) => row.backendId === pricing.backendId),
      );
      const monthToDate = cost?.total ?? 0;
      budgets.set(pricing.backendId, {
        month: today.toFormat('yyyy-MM'),
        currency: pricing.currency,
        amount: pricing.monthlyBudget!,
        monthToDate,
        // at the pace of the days of the month so far
        projected: round((monthToDate / today.day) * today.daysInMonth!),
      });
    }
    return budgets;
  }

  /**
   * Remind administrators once a month when a backend's estimated cost would exceed its budget, and once more when it
   * did; only a reminder: nothing is paused
   */
  private async remindOfBudgets() {
    const { storagePricing } = await this.getConfig({ withCache: false });
    const budgets = await this.getBudgets(storagePricing.backends);
    if (budgets.size === 0) {
      return;
    }

    const sent = (await this.systemMetadataRepository.get(SystemMetadataKey.StorageBudgetReminders)) ?? {};
    let changed = false;
    for (const [backendId, budget] of budgets) {
      const reminder =
        budget.monthToDate > budget.amount ? 'exceeded' : budget.projected > budget.amount ? 'projected' : null;
      const key = `${budget.month}:${reminder}`;
      if (!reminder || sent[backendId]?.includes(key)) {
        continue;
      }
      await this.notifyAdmin(backendId, budget, reminder);
      // only this month's are kept
      sent[backendId] = [...(sent[backendId] ?? []).filter((item) => item.startsWith(budget.month)), key];
      changed = true;
    }
    if (changed) {
      await this.systemMetadataRepository.set(SystemMetadataKey.StorageBudgetReminders, sent);
    }
  }

  private async notifyAdmin(backendId: string, budget: StorageBudgetDto, reminder: 'projected' | 'exceeded') {
    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      return;
    }
    const amount = (value: number) => `${value.toFixed(2)} ${budget.currency}`;
    const notification = await this.notificationRepository.create({
      userId: admin.id,
      type: NotificationType.SystemMessage,
      level: reminder === 'exceeded' ? NotificationLevel.Error : NotificationLevel.Warning,
      title:
        reminder === 'exceeded'
          ? `Storage backend ${backendId} exceeded its budget`
          : `Storage backend ${backendId} is on course to exceed its budget`,
      description:
        reminder === 'exceeded'
          ? `This month (${budget.month}) cost an estimated ${amount(budget.monthToDate)} so far, over the budget of ${amount(budget.amount)}. Nothing is paused; see the storage usage page.`
          : `At the pace so far, this month (${budget.month}) will cost an estimated ${amount(budget.projected)}, over the budget of ${amount(budget.amount)}. Nothing is paused; see the storage usage page.`,
    });
    this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(notification));
  }
}
