import { Body, Controller, Get, HttpCode, HttpStatus, Next, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssetMediaResponseDto } from 'src/dtos/asset-media-response.dto.js';
import {
  StorageDeletionImportDto,
  StorageDeletionOriginalsQueryDto,
  StorageDeletionOriginalsResponseDto,
  StorageDeletionPurgeDto,
  StorageDeletionStatusResponseDto,
} from 'src/dtos/storage-deletion.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { StorageDeletionService } from 'src/services/storage-deletion.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

/** Files deleted from storage backends wait for their deletion delay; administrators can recover or delete originals */
@ApiTags(ApiTag.Maintenance)
@Controller('admin/storage/deletions')
export class StorageDeletionAdminController {
  constructor(
    private logger: LoggingRepository,
    private service: StorageDeletionService,
    private assetMediaService: AssetMediaService,
  ) {}

  @Get()
  @Endpoint({
    summary: 'Get the status of deleting files from storage',
    description: 'Whether deleting is paused, and how many deleted files wait for their deletion delay',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getStorageDeletionStatus(): Promise<StorageDeletionStatusResponseDto> {
    return this.service.getStatus();
  }

  @Post('resume')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Resume deleting files from storage',
    description: 'Approve the unusual amount of deleted originals that paused deleting, and delete what is due',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  resumeStorageDeletion(@Auth() auth: AuthDto): Promise<void> {
    return this.service.resume(auth);
  }

  @Get('originals')
  @Endpoint({
    summary: 'List deleted originals',
    description: 'Deleted originals that wait for their deletion delay and can still be recovered',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getDeletedOriginals(@Query() dto: StorageDeletionOriginalsQueryDto): Promise<StorageDeletionOriginalsResponseDto> {
    return this.service.listOriginals(dto);
  }

  @Get('originals/:id/file')
  @FileResponse()
  @Endpoint({
    summary: 'Download a deleted original',
    description: 'The deleted original, decrypted, to look at before recovering or deleting it',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  async getDeletedOriginalFile(
    @Param() { id }: UUIDParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    await sendFile(res, next, () => this.service.getOriginalFile(id), this.logger);
  }

  @Post('originals/:id/import')
  @Endpoint({
    summary: 'Recover a deleted original as a new photo',
    description:
      'Upload the deleted original again for its owner or another user; albums, descriptions, tags and people are not recovered',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  importDeletedOriginal(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: StorageDeletionImportDto,
  ): Promise<AssetMediaResponseDto> {
    return this.assetMediaService.importDeletedOriginal(auth, id, dto);
  }

  @Post('originals/:id/purge')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a deleted original now',
    description: 'Delete the original from storage before its deletion delay has passed, which cannot be undone',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  purgeDeletedOriginal(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: StorageDeletionPurgeDto,
  ): Promise<void> {
    return this.service.purgeOriginal(auth, id, dto);
  }
}
