import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StorageExportResponseDto, StorageExportStartDto } from 'src/dtos/storage-export.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { StorageExportService } from 'src/services/storage-export.service.js';

@ApiTags(ApiTag.Maintenance)
@Controller('admin/storage/export')
export class StorageExportAdminController {
  constructor(private service: StorageExportService) {}

  @Get()
  @Endpoint({
    summary: 'Get the export',
    description: 'Where exports go, and the current or last export of the originals',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getStorageExport(): Promise<StorageExportResponseDto> {
    return this.service.getExport();
  }

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Start an export',
    description:
      'Export the originals, with their metadata, to the export location: in folders by user and date (or by the storage template), each with a JSON file and an XMP sidecar. What was exported before and did not change is kept.',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  startStorageExport(@Body() dto: StorageExportStartDto): Promise<void> {
    return this.service.startExport(dto);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Cancel the export',
    description: 'Stop the running export; what it exported is kept, and an export started later goes on from there',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  cancelStorageExport(): Promise<void> {
    return this.service.cancelExport();
  }
}
