import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  JobFailureListQueryDto,
  JobFailureListResponseDto,
  JobHistoryQueryDto,
  JobHistoryResponseDto,
} from 'src/dtos/job-history.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { JobHistoryService } from 'src/services/job-history.service.js';

/** How many jobs ran and failed over time, and why they failed */
@ApiTags(ApiTag.Jobs)
@Controller('admin/job-history')
export class JobHistoryController {
  constructor(private service: JobHistoryService) {}

  @Get()
  @Endpoint({
    summary: 'Get the history of jobs',
    description:
      'How many jobs ran, failed and were put back for later since a time, in all and per job, over time; why they failed; and the jobs that failed far more often than usual in the last 24 hours',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ permission: Permission.QueueJobRead, admin: true })
  getJobHistory(@Query() dto: JobHistoryQueryDto): Promise<JobHistoryResponseDto> {
    return this.service.getHistory(dto);
  }

  @Get('failures')
  @Endpoint({
    summary: 'Get the jobs that failed',
    description: 'The jobs that failed since a time, the last first, by job, kind and reason, a page at a time',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ permission: Permission.QueueJobRead, admin: true })
  getJobFailureLog(@Query() dto: JobFailureListQueryDto): Promise<JobFailureListResponseDto> {
    return this.service.getFailures(dto);
  }
}
