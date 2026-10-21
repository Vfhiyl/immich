import { BadRequestException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { DateTime } from 'luxon';
import sanitize from 'sanitize-filename';
import type { ClassConstructor } from 'src/types.js';
import { SALT_ROUNDS } from 'src/constants.js';
import { StorageCore, StorageLocation } from 'src/cores/storage.core.js';
import { UserAdmin } from 'src/database.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ActivityRepository } from 'src/repositories/activity.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetFileRepository } from 'src/repositories/asset-file.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EmailRepository } from 'src/repositories/email.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { MoveRepository } from 'src/repositories/move.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { OAuthRepository } from 'src/repositories/oauth.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonUserRepository } from 'src/repositories/person-user.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PluginRepository } from 'src/repositories/plugin.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { ServerInfoRepository } from 'src/repositories/server-info.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageBackendRepository, isBuiltinStorageBackend } from 'src/repositories/storage-backend.repository.js';
import { StorageCheckRepository } from 'src/repositories/storage-check.repository.js';
import { OriginalRecovery, StorageDeletionRepository } from 'src/repositories/storage-deletion.repository.js';
import { StorageReplicaRepository } from 'src/repositories/storage-replica.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SyncCheckpointRepository } from 'src/repositories/sync-checkpoint.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { TelemetryRepository } from 'src/repositories/telemetry.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { UploadSessionRepository } from 'src/repositories/upload-session.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { VersionHistoryRepository } from 'src/repositories/version-history.repository.js';
import { VideoStreamRepository } from 'src/repositories/video-stream.repository.js';
import { ViewRepository } from 'src/repositories/view-repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { WorkflowRepository } from 'src/repositories/workflow.repository.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import {
  AccessPersonRequest,
  AccessRequest,
  checkAccess,
  checkPersonAccess,
  requireAccess,
  requirePersonAccess,
} from 'src/utils/access.js';
import { getConfig, updateConfig } from 'src/utils/config.js';

export const BASE_SERVICE_DEPENDENCIES = [
  LoggingRepository,
  AccessRepository,
  ActivityRepository,
  AlbumRepository,
  AlbumUserRepository,
  ApiKeyRepository,
  AppRepository,
  AssetRepository,
  AssetEditRepository,
  AssetFileRepository,
  AssetJobRepository,
  ClusterGroupRepository,
  ConfigRepository,
  CronRepository,
  CryptoRepository,
  DatabaseRepository,
  DownloadRepository,
  DuplicateRepository,
  EmailRepository,
  EventRepository,
  IntegrityRepository,
  JobRepository,
  LibraryRepository,
  MachineLearningRepository,
  MapRepository,
  MediaRepository,
  MemoryRepository,
  MetadataRepository,
  MoveRepository,
  NotificationRepository,
  OAuthRepository,
  OcrRepository,
  PartnerRepository,
  PersonRepository,
  PersonUserRepository,
  PluginRepository,
  ProcessRepository,
  SearchRepository,
  ServerInfoRepository,
  SessionRepository,
  SharedLinkRepository,
  SharedLinkAssetRepository,
  StackRepository,
  StorageBackendRepository,
  StorageCheckRepository,
  StorageDeletionRepository,
  StorageReplicaRepository,
  StorageRepository,
  SyncRepository,
  SyncCheckpointRepository,
  SystemMetadataRepository,
  TagRepository,
  TelemetryRepository,
  TrashRepository,
  UploadSessionRepository,
  UserRepository,
  VersionHistoryRepository,
  VideoStreamRepository,
  ViewRepository,
  WebsocketRepository,
  WorkflowRepository,
] as const;

@Injectable()
export class BaseService {
  protected storageCore: StorageCore;

  constructor(
    protected logger: LoggingRepository,
    protected accessRepository: AccessRepository,
    protected activityRepository: ActivityRepository,
    protected albumRepository: AlbumRepository,
    protected albumUserRepository: AlbumUserRepository,
    protected apiKeyRepository: ApiKeyRepository,
    protected appRepository: AppRepository,
    protected assetRepository: AssetRepository,
    protected assetEditRepository: AssetEditRepository,
    protected assetFileRepository: AssetFileRepository,
    protected assetJobRepository: AssetJobRepository,
    protected clusterGroupRepository: ClusterGroupRepository,
    protected configRepository: ConfigRepository,
    protected cronRepository: CronRepository,
    protected cryptoRepository: CryptoRepository,
    protected databaseRepository: DatabaseRepository,
    protected downloadRepository: DownloadRepository,
    protected duplicateRepository: DuplicateRepository,
    protected emailRepository: EmailRepository,
    protected eventRepository: EventRepository,
    protected integrityRepository: IntegrityRepository,
    protected jobRepository: JobRepository,
    protected libraryRepository: LibraryRepository,
    protected machineLearningRepository: MachineLearningRepository,
    protected mapRepository: MapRepository,
    protected mediaRepository: MediaRepository,
    protected memoryRepository: MemoryRepository,
    protected metadataRepository: MetadataRepository,
    protected moveRepository: MoveRepository,
    protected notificationRepository: NotificationRepository,
    protected oauthRepository: OAuthRepository,
    protected ocrRepository: OcrRepository,
    protected partnerRepository: PartnerRepository,
    protected personRepository: PersonRepository,
    protected personUserRepository: PersonUserRepository,
    protected pluginRepository: PluginRepository,
    protected processRepository: ProcessRepository,
    protected searchRepository: SearchRepository,
    protected serverInfoRepository: ServerInfoRepository,
    protected sessionRepository: SessionRepository,
    protected sharedLinkRepository: SharedLinkRepository,
    protected sharedLinkAssetRepository: SharedLinkAssetRepository,
    protected stackRepository: StackRepository,
    protected storageBackendRepository: StorageBackendRepository,
    protected storageCheckRepository: StorageCheckRepository,
    protected storageDeletionRepository: StorageDeletionRepository,
    protected storageReplicaRepository: StorageReplicaRepository,
    protected storageRepository: StorageRepository,
    protected syncRepository: SyncRepository,
    protected syncCheckpointRepository: SyncCheckpointRepository,
    protected systemMetadataRepository: SystemMetadataRepository,
    protected tagRepository: TagRepository,
    protected telemetryRepository: TelemetryRepository,
    protected trashRepository: TrashRepository,
    protected uploadSessionRepository: UploadSessionRepository,
    protected userRepository: UserRepository,
    protected versionRepository: VersionHistoryRepository,
    protected videoStreamRepository: VideoStreamRepository,
    protected viewRepository: ViewRepository,
    protected websocketRepository: WebsocketRepository,
    protected workflowRepository: WorkflowRepository,
  ) {
    this.logger.setContext(this.constructor.name);
    this.storageCore = StorageCore.create(
      assetRepository,
      configRepository,
      cryptoRepository,
      moveRepository,
      personRepository,
      storageRepository,
      systemMetadataRepository,
      this.logger,
    );
  }

  static create<T extends ClassConstructor<typeof BaseService>>(Service: T, ctx: BaseService) {
    const service = new Service(
      LoggingRepository.create(),
      ctx.accessRepository,
      ctx.activityRepository,
      ctx.albumRepository,
      ctx.albumUserRepository,
      ctx.apiKeyRepository,
      ctx.appRepository,
      ctx.assetRepository,
      ctx.assetEditRepository,
      ctx.assetFileRepository,
      ctx.assetJobRepository,
      ctx.clusterGroupRepository,
      ctx.configRepository,
      ctx.cronRepository,
      ctx.cryptoRepository,
      ctx.databaseRepository,
      ctx.downloadRepository,
      ctx.duplicateRepository,
      ctx.emailRepository,
      ctx.eventRepository,
      ctx.integrityRepository,
      ctx.jobRepository,
      ctx.libraryRepository,
      ctx.machineLearningRepository,
      ctx.mapRepository,
      ctx.mediaRepository,
      ctx.memoryRepository,
      ctx.metadataRepository,
      ctx.moveRepository,
      ctx.notificationRepository,
      ctx.oauthRepository,
      ctx.ocrRepository,
      ctx.partnerRepository,
      ctx.personRepository,
      ctx.personUserRepository,
      ctx.pluginRepository,
      ctx.processRepository,
      ctx.searchRepository,
      ctx.serverInfoRepository,
      ctx.sessionRepository,
      ctx.sharedLinkRepository,
      ctx.sharedLinkAssetRepository,
      ctx.stackRepository,
      ctx.storageBackendRepository,
      ctx.storageCheckRepository,
      ctx.storageDeletionRepository,
      ctx.storageReplicaRepository,
      ctx.storageRepository,
      ctx.syncRepository,
      ctx.syncCheckpointRepository,
      ctx.systemMetadataRepository,
      ctx.tagRepository,
      ctx.telemetryRepository,
      ctx.trashRepository,
      ctx.uploadSessionRepository,
      ctx.userRepository,
      ctx.versionRepository,
      ctx.videoStreamRepository,
      ctx.viewRepository,
      ctx.websocketRepository,
      ctx.workflowRepository,
    );

    service.logger.setContext(BaseService.name);

    return service as InstanceType<T>;
  }

  get worker() {
    return this.configRepository.getWorker();
  }

  private get configRepos() {
    return {
      configRepo: this.configRepository,
      metadataRepo: this.systemMetadataRepository,
      logger: this.logger,
    };
  }

  getConfig(options: { withCache: boolean }) {
    return getConfig(this.configRepos, options);
  }

  updateConfig(newConfig: SystemConfig) {
    return updateConfig(this.configRepos, newConfig);
  }

  requireAccess(request: AccessRequest) {
    return requireAccess(this.accessRepository, request);
  }

  checkAccess(request: AccessRequest) {
    return checkAccess(this.accessRepository, request);
  }

  requirePersonAccess(request: AccessPersonRequest) {
    return requirePersonAccess(this.accessRepository, request);
  }

  checkPersonAccess(request: AccessPersonRequest) {
    return checkPersonAccess(this.accessRepository, request);
  }

  async isSetupAvailable(): Promise<boolean> {
    const { setup } = this.configRepository.getEnv();
    return setup.allow && !(await this.userRepository.hasAdmin());
  }

  async requireSetupAvailable(): Promise<void> {
    if (!(await this.isSetupAvailable())) {
      throw new BadRequestException('Admin setup is not available');
    }
  }

  async createUser(dto: Omit<Insertable<UserTable>, 'clusterGroupId'> & { email: string }): Promise<UserAdmin> {
    const exists = await this.userRepository.getByEmail(dto.email);
    if (exists) {
      this.logger.debug('User creation rejected: user already exists');
      throw new BadRequestException('Email is not available');
    }

    if (!dto.isAdmin) {
      const localAdmin = await this.userRepository.getAdmin();
      if (!localAdmin) {
        throw new BadRequestException('The first registered account must the administrator.');
      }
    }

    const payload: Omit<Insertable<UserTable>, 'clusterGroupId'> = { ...dto };
    if (payload.password) {
      payload.password = await this.cryptoRepository.hashBcrypt(payload.password, SALT_ROUNDS);
    }
    if (payload.storageLabel) {
      payload.storageLabel = sanitize(payload.storageLabel);
    }

    const clusterGroup = await this.clusterGroupRepository.create();
    const user = await this.userRepository.create({ ...payload, clusterGroupId: clusterGroup.id });

    await this.eventRepository.emit('UserCreate', user);

    return user;
  }

  /**
   * Register files on configured backends to be deleted once their delay has passed, which is written with each one so
   * that a shorter delay configured later does not delete it earlier. Originals can carry what recovering them needs.
   */
  protected async registerDeletions(files: Array<StorageLocation & OriginalRecovery>) {
    const now = DateTime.now();
    await this.storageDeletionRepository.register(
      files.map(({ backendId, key, ...recovery }) => {
        const { days, isOriginal } = this.storageBackendRepository.getDeletionDelay(backendId);
        return { backendId, key, isOriginal, notBefore: now.plus({ days }).toJSDate(), ...recovery };
      }),
    );
  }

  /**
   * Record newly stored files in the database. If that fails, files stored on a backend under new keys would be lost,
   * so they are deleted; files written to their path may be the ones already recorded there and are kept, as before.
   */
  protected async recordStoredFiles<T>(files: StorageLocation[], record: () => Promise<T>): Promise<T> {
    try {
      return await record();
    } catch (error) {
      const locations = files
        .filter(({ backendId }) => !isBuiltinStorageBackend(backendId))
        .map(({ backendId, key }) => ({ backendId, key }));
      if (locations.length > 0) {
        // never recorded, so nothing can need them
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [], locations, immediate: true } });
      }
      throw error;
    }
  }
}
