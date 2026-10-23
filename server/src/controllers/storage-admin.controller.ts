import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StorageConfigurationResponseDto,
  StorageMasterKeyExportDto,
  StorageMasterKeyExportResponseDto,
} from 'src/dtos/storage-backend.dto.js';
import { StorageSetupResponseDto } from 'src/dtos/storage-setup.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StorageService } from 'src/services/storage.service.js';

/** The storage configuration, which is read from the configuration file and environment and cannot be changed here */
@ApiTags(ApiTag.Maintenance)
@Controller('admin/storage')
export class StorageAdminController {
  constructor(private service: StorageService) {}

  @Get()
  @Endpoint({
    summary: 'Get the storage configuration',
    description: 'The configured storage backends without their credentials, and the settings of storing files',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getStorageConfiguration(): Promise<StorageConfigurationResponseDto> {
    return this.service.getConfiguration();
  }

  @Get('setup')
  @Endpoint({
    summary: 'Check the storage of a new server',
    description:
      'What a new server finds in its storage configuration and storage (e.g. database backups of the server it replaces), for the welcome page; only before an administrator exists',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ public: true, setup: true })
  getStorageSetup(): Promise<StorageSetupResponseDto> {
    return this.service.getStorageSetup();
  }

  @Post('master-keys/export')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Endpoint({
    summary: 'Download the master keys',
    description:
      'The master keys as a key file, to keep a copy apart from the server, after the administrator confirmed their password; every administrator is notified',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  exportStorageMasterKeys(
    @Auth() auth: AuthDto,
    @Body() dto: StorageMasterKeyExportDto,
  ): Promise<StorageMasterKeyExportResponseDto> {
    return this.service.exportMasterKeys(auth, dto);
  }
}
