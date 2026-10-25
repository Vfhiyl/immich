import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { JobFailureRetryDto, JobFailureRetryResponseDto, JobFailuresResponseDto } from 'src/dtos/job-failure.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { JobFailureService } from 'src/services/job-failure.service.js';

/** The files that jobs failed on again and again, which they are no longer queued for */
@ApiTags(ApiTag.Jobs)
@Controller('admin/job-failures')
export class JobFailureController {
  constructor(private service: JobFailureService) {}

  @Get()
  @Endpoint({
    summary: 'Get the files jobs failed on',
    description:
      'The files that a job (metadata, thumbnails, video, smart search, faces or text recognition) failed on in a row so often that it is no longer queued for them, with why it failed last',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ permission: Permission.QueueJobRead, admin: true })
  getJobFailures(): Promise<JobFailuresResponseDto> {
    return this.service.getFailures();
  }

  @Post('retry')
  @Endpoint({
    summary: 'Retry the files a job failed on',
    description: 'Queues the job again for the files it is no longer queued for, as after their cause was fixed',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ permission: Permission.QueueJobCreate, admin: true })
  retryJobFailures(@Body() dto: JobFailureRetryDto): Promise<JobFailureRetryResponseDto> {
    return this.service.retry(dto);
  }
}
