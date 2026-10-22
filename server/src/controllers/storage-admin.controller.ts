import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StorageConfigurationResponseDto } from 'src/dtos/storage-backend.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
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
  getStorageConfiguration(): StorageConfigurationResponseDto {
    return this.service.getConfiguration();
  }
}
