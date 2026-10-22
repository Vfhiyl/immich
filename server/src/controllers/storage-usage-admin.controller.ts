import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StorageUsageQueryDto, StorageUsageResponseDto } from 'src/dtos/storage-usage.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { StorageUsageService } from 'src/services/storage-usage.service.js';

/** What the storage backends store and the requests made to them, with estimated costs */
@ApiTags(ApiTag.Maintenance)
@Controller('admin/storage/usage')
export class StorageUsageAdminController {
  constructor(private service: StorageUsageService) {}

  @Get()
  @Endpoint({
    summary: 'Get the storage usage',
    description:
      'Per storage backend and UTC day: what is stored, the requests made and by what, and the estimated cost by the prices in the settings',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getStorageUsage(@Query() query: StorageUsageQueryDto): Promise<StorageUsageResponseDto> {
    return this.service.getUsage(query);
  }
}
