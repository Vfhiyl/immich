import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import { ImmichWorker, NotificationLevel, NotificationType, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  MEMORY_KILL_NOTIFY_EVERY_MS,
  MemoryKillState,
  addMemoryKill,
  countMemoryKills,
  isKilledProgram,
} from 'src/utils/memory-kills.js';
import { handlePromiseError } from 'src/utils/misc.js';
import { readOomKills } from 'src/utils/server-resources.js';
import { WORKER_LAST_EXIT_ENV } from 'src/utils/worker-restart.js';

/** How often the kernel's count of processes killed for memory is read */
const CHECK_MS = 60 * 1000;

/**
 * Notices when the background work runs out of memory, and tells the admin (the resources on the welcome and jobs
 * pages, and a notification at most once a day): the background worker killed (SIGKILL, as the kernel's OOM killer
 * does), a program of a job killed, or the kernel counting more processes killed for memory
 */
@Injectable()
export class MemoryKillService extends BaseService {
  private interval?: ReturnType<typeof setInterval>;

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    if (process.env[WORKER_LAST_EXIT_ENV] === 'SIGKILL') {
      await this.record('the background worker');
    }
    await this.check();
    this.interval = setInterval(() => handlePromiseError(this.check(), this.logger), CHECK_MS);
  }

  @OnEvent({ name: 'AppShutdown', workers: [ImmichWorker.Microservices] })
  onShutdown() {
    clearInterval(this.interval);
  }

  @OnEvent({ name: 'JobError' })
  async onJobError({ job, error }: ArgOf<'JobError'>) {
    if (isKilledProgram(error)) {
      await this.record(`a program of ${job.name}`);
    }
  }

  /** The kernel's count of processes killed for memory, against the one last read */
  async check() {
    const count = await readOomKills();
    if (count === null) {
      return;
    }
    const state = await this.getState();
    // (a new machine, or one started again, counts from 0)
    if (state.oomKills !== undefined && count > state.oomKills) {
      await this.record('a process', count - state.oomKills, count);
    } else if (state.oomKills !== count) {
      await this.systemMetadataRepository.set(SystemMetadataKey.MemoryKills, { ...state, oomKills: count });
    }
  }

  private async getState(): Promise<MemoryKillState> {
    return (await this.systemMetadataRepository.get(SystemMetadataKey.MemoryKills)) ?? { kills: [] };
  }

  private async record(what: string, count = 1, oomKills?: number) {
    const now = new Date();
    let state = addMemoryKill(await this.getState(), what, now, count);
    if (oomKills !== undefined) {
      state = { ...state, oomKills };
    }
    this.logger.warn(`The background work ran out of memory: ${what} was killed`);
    const notify = !state.notifiedAt || now.getTime() - Date.parse(state.notifiedAt) >= MEMORY_KILL_NOTIFY_EVERY_MS;
    if (notify) {
      state = { ...state, notifiedAt: now.toISOString() };
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.MemoryKills, state);
    if (notify) {
      await this.notifyAdmin(countMemoryKills(state, now));
    }
  }

  private async notifyAdmin(times: number) {
    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      return;
    }
    const notification = await this.notificationRepository.create({
      userId: admin.id,
      type: NotificationType.SystemMessage,
      level: NotificationLevel.Warning,
      title: 'The server ran out of memory',
      description:
        `The background work ran out of memory ${times === 1 ? 'once' : `${times} times`} in the last 7 days, and ` +
        'was stopped and started again. Add swap or memory to the server (the jobs page tells how much); the work ' +
        'goes on meanwhile, more slowly.',
    });
    this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(notification));
  }
}
