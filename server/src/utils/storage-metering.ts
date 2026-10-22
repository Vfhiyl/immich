import { AsyncLocalStorage } from 'node:async_hooks';

/** What storage requests are made for: the job that makes them, or requests of users (`api`) */
const purpose = new AsyncLocalStorage<string>();

/** Requests made outside of jobs are made for users */
export const DEFAULT_STORAGE_PURPOSE = 'api';

export const withStoragePurpose = <T>(name: string, run: () => T): T => purpose.run(name, run);

export const getStoragePurpose = () => purpose.getStore() ?? DEFAULT_STORAGE_PURPOSE;

/** One request to a storage service, as it went over the network */
export interface StorageRequest {
  operation: string;
  bytesSent: number;
  bytesReceived: number;
}

export interface StorageRequestUsage {
  /** The UTC day, as YYYY-MM-DD */
  day: string;
  backendId: string;
  operation: string;
  purpose: string;
  requests: number;
  bytesSent: number;
  bytesReceived: number;
}

/** Counts requests to storage services in memory, until they are written to the database */
export class StorageMeter {
  private usage = new Map<string, StorageRequestUsage>();

  record(backendId: string, { operation, bytesSent, bytesReceived }: StorageRequest, now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    const name = getStoragePurpose();
    const id = `${day}|${backendId}|${operation}|${name}`;
    let usage = this.usage.get(id);
    if (!usage) {
      usage = { day, backendId, operation, purpose: name, requests: 0, bytesSent: 0, bytesReceived: 0 };
      this.usage.set(id, usage);
    }
    usage.requests++;
    usage.bytesSent += bytesSent;
    usage.bytesReceived += bytesReceived;
  }

  /** What was counted since the last call, which is forgotten */
  drain(): StorageRequestUsage[] {
    const usage = this.usage.values().toArray();
    this.usage.clear();
    return usage;
  }
}
