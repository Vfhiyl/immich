import { BadRequestException, Injectable } from '@nestjs/common';
import { basename, dirname, join } from 'node:path';
import type { StorageExportState } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import { StorageExportResponseDto, StorageExportStartDto } from 'src/dtos/storage-export.dto.js';
import { JobName, JobStatus, NotificationLevel, NotificationType, QueueName, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { ExportOptions, ExportedAsset, Exporter, toExportTarget, toSafeName } from 'src/utils/export-tool.js';
import { compileStorageTemplate, toTemplatePath } from 'src/utils/storage-template.js';

/**
 * An export runs in chunks of this long, each a job that queues the next one: so that the queue it runs in keeps
 * moving, and an export of years of photos survives restarts
 */
const EXPORT_CHUNK_MS = 5 * 60 * 1000;
/** Progress is saved, and a cancellation noticed, after this many originals */
const EXPORT_SAVE_EVERY = 50;

/**
 * Where an original goes by the storage template, within the folder of its owner: on storage backends, objects have
 * opaque keys, so the template only names the files of downloads and exports. A path that would leave the folder of
 * its owner goes where it would without a template.
 */
export const toTemplateTarget = (output: string, template: ReturnType<typeof compileStorageTemplate>) => {
  return (asset: ExportedAsset) => {
    const path = toTemplatePath(template, {
      ...asset,
      albumName: asset.albums[0] ?? null,
      make: asset.exif?.make ?? null,
      model: asset.exif?.model ?? null,
      lensModel: asset.exif?.lensModel ?? null,
    });
    if (!path) {
      return toExportTarget(output, asset);
    }
    const full = join(output, toSafeName(asset.ownerEmail), path);
    return { folder: dirname(full), fileName: basename(full) };
  };
};

/**
 * The export of the originals to a folder of the server (IMMICH_EXPORT_LOCATION, e.g. a mounted disk), started by an
 * administrator: the same folders, JSON files and XMP sidecars as `immich-export`, or the storage template's folders
 * when it is enabled. It goes on in chunks, can be cancelled, and keeps what it exported: an export started again skips
 * what was exported before and did not change.
 */
@Injectable()
export class StorageExportService extends BaseService {
  async getExport(): Promise<StorageExportResponseDto> {
    const { storageTemplate } = await this.getConfig({ withCache: true });
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.StorageExportState);
    return {
      location: this.getLocation() ?? null,
      usesStorageTemplate: storageTemplate.enabled,
      state: state ? mapState(state) : null,
    };
  }

  async startExport({ userIds }: StorageExportStartDto) {
    if (!this.getLocation()) {
      throw new BadRequestException('No export location is set (IMMICH_EXPORT_LOCATION)');
    }
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.StorageExportState);
    if (state?.status === 'running') {
      throw new BadRequestException('An export is running');
    }

    const users = userIds && userIds.length > 0 ? userIds : null;
    await this.systemMetadataRepository.set(SystemMetadataKey.StorageExportState, {
      status: 'running',
      userIds: users,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      cursor: null,
      total: await this.assetJobRepository.countForExport({ output: '', userIds: users ?? undefined }),
      exported: 0,
      skipped: 0,
      failed: 0,
      lastError: null,
    });
    await this.jobRepository.queue({ name: JobName.StorageExport });
  }

  async cancelExport() {
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.StorageExportState);
    if (state?.status !== 'running') {
      return;
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.StorageExportState, {
      ...state,
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
    });
  }

  @OnJob({ name: JobName.StorageExport, queue: QueueName.BackgroundTask })
  async handleExport(): Promise<JobStatus> {
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.StorageExportState);
    if (state?.status !== 'running') {
      return JobStatus.Skipped;
    }
    const location = this.getLocation();
    if (!location) {
      await this.finish(state, 'failed', 'No export location is set (IMMICH_EXPORT_LOCATION)');
      return JobStatus.Failed;
    }

    const { storageTemplate } = await this.getConfig({ withCache: false });
    const options: ExportOptions = {
      output: location,
      userIds: state.userIds ?? undefined,
      after: state.cursor ? { localDateTime: new Date(state.cursor.localDateTime), id: state.cursor.id } : undefined,
      naming: storageTemplate.enabled
        ? toTemplateTarget(location, compileStorageTemplate(storageTemplate.template))
        : undefined,
    };

    let lastError = state.lastError;
    const exporter = new Exporter(this.storageBackendRepository, {
      log: (message) => this.logger.log(message),
      error: (message) => {
        lastError = message;
        this.logger.warn(message);
      },
    });

    const deadline = Date.now() + EXPORT_CHUNK_MS;
    let cursor = state.cursor;
    let unsaved = 0;
    let isCancelled = false;
    let hasMore = false;
    const progress = (summary: { exported: number; skipped: number; failed: number }): StorageExportState => ({
      ...state,
      cursor,
      exported: state.exported + summary.exported,
      skipped: state.skipped + summary.skipped,
      failed: state.failed + summary.failed,
      lastError,
    });

    const summary = await exporter.exportAssets(
      this.assetJobRepository.streamForExport(options),
      options,
      async (asset, summary) => {
        cursor = { localDateTime: asset.localDateTime.toISOString(), id: asset.id };
        if (++unsaved >= EXPORT_SAVE_EVERY) {
          unsaved = 0;
          if (!(await this.isRunning())) {
            isCancelled = true;
            return false;
          }
          await this.systemMetadataRepository.set(SystemMetadataKey.StorageExportState, progress(summary));
        }
        if (Date.now() >= deadline) {
          hasMore = true;
          return false;
        }
        return true;
      },
    );

    // cancelled meanwhile: what was exported stays, the state says so
    if (isCancelled || !(await this.isRunning())) {
      return JobStatus.Success;
    }
    if (hasMore) {
      await this.systemMetadataRepository.set(SystemMetadataKey.StorageExportState, progress(summary));
      await this.jobRepository.queue({ name: JobName.StorageExport });
      return JobStatus.Success;
    }

    const done = progress(summary);
    await this.finish(done, 'done', lastError);
    await this.notifyAdmin(done);
    return JobStatus.Success;
  }

  private getLocation() {
    return this.configRepository.getEnv().storage.exportLocation;
  }

  private async isRunning() {
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.StorageExportState);
    return state?.status === 'running';
  }

  private async finish(state: StorageExportState, status: 'done' | 'failed', lastError: string | null) {
    await this.systemMetadataRepository.set(SystemMetadataKey.StorageExportState, {
      ...state,
      status,
      finishedAt: new Date().toISOString(),
      lastError,
    });
  }

  private async notifyAdmin({ exported, skipped, failed }: StorageExportState) {
    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      return;
    }
    const notification = await this.notificationRepository.create({
      userId: admin.id,
      type: NotificationType.SystemMessage,
      level: failed > 0 ? NotificationLevel.Warning : NotificationLevel.Success,
      title: 'The export of the originals is done',
      description: `${exported} originals exported, ${skipped} already exported before${failed > 0 ? `, ${failed} could not be exported (see the storage page)` : ''}.`,
    });
    this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(notification));
  }
}

const mapState = ({ cursor: _cursor, ...state }: StorageExportState) => state;
