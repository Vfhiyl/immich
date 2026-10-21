import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StorageCheckRunDto,
  StorageCheckRunsQueryDto,
  StorageCheckStartDto,
  StorageCheckSummaryResponseDto,
  StorageIssuesQueryDto,
  StorageIssuesResponseDto,
} from 'src/dtos/storage-check.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { StorageCheckService } from 'src/services/storage-check.service.js';
import { UUIDParamDto } from 'src/validation.js';

/** The data health reports of the files on storage backends */
@ApiTags(ApiTag.Maintenance)
@Controller('admin/storage/checks')
export class StorageCheckAdminController {
  constructor(private service: StorageCheckService) {}

  @Get()
  @Endpoint({
    summary: 'Get the data health summary',
    description: 'Open problems by kind, the last runs of each check and the last 12 months',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getStorageCheckSummary(): Promise<StorageCheckSummaryResponseDto> {
    return this.service.getSummary();
  }

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Run a storage check',
    description: 'Reconcile the storage backends with what is recorded, or read files back to verify them, now',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  startStorageCheck(@Body() dto: StorageCheckStartDto): Promise<void> {
    return this.service.startCheck(dto);
  }

  @Get('runs')
  @Endpoint({
    summary: 'List storage check runs',
    description: 'Every run of a check is a report, the newest first',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getStorageCheckRuns(@Query() dto: StorageCheckRunsQueryDto): Promise<StorageCheckRunDto[]> {
    return this.service.getRuns(dto);
  }

  @Get('issues')
  @Endpoint({
    summary: 'List storage issues',
    description: 'Problems with stored files that checks reported, the most recently seen first',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getStorageIssues(@Query() dto: StorageIssuesQueryDto): Promise<StorageIssuesResponseDto> {
    return this.service.getIssues(dto);
  }

  @Get('issues/csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="storage-issues.csv"')
  @Endpoint({
    summary: 'Export storage issues as CSV',
    description: 'All reported problems with stored files, open and resolved',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  async getStorageIssuesCsv(@Res() res: Response): Promise<void> {
    await pipeline(Readable.from(this.service.getIssuesCsv()), res);
  }

  @Post('issues/:id/acknowledge')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Acknowledge a storage issue',
    description: 'Note that an administrator saw the problem; it stays open until a check no longer finds it',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  acknowledgeStorageIssue(@Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.acknowledgeIssue(id);
  }
}
