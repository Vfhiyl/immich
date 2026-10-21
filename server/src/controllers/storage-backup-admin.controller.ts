import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StoredDatabaseBackupFetchResponseDto,
  StoredDatabaseBackupKeyParamDto,
  StoredDatabaseBackupListResponseDto,
} from 'src/dtos/storage-backup.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { StorageBackupService } from 'src/services/storage-backup.service.js';

@ApiTags(ApiTag.DatabaseBackups)
@Controller('admin/storage/database-backups')
export class StorageBackupAdminController {
  constructor(private service: StorageBackupService) {}

  @Get()
  @Endpoint({
    summary: 'List stored database backups',
    description: 'Database backups on the storage backend for backups, the newest first',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.BackupList, admin: true })
  getStoredDatabaseBackups(): Promise<StoredDatabaseBackupListResponseDto> {
    return this.service.getStoredBackups();
  }

  @Post(':key/fetch')
  @Endpoint({
    summary: 'Fetch a stored database backup',
    description: 'Copy a database backup from the storage backend for backups into the backups folder, to restore it',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.BackupUpload, admin: true })
  fetchStoredDatabaseBackup(
    @Param() { key }: StoredDatabaseBackupKeyParamDto,
  ): Promise<StoredDatabaseBackupFetchResponseDto> {
    return this.service.fetchStoredBackup(key);
  }
}
