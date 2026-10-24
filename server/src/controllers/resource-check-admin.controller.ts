import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { ResourceCheckResponseDto } from 'src/dtos/resource-check.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { ResourceCheckService } from 'src/services/resource-check.service.js';

@ApiTags(ApiTag.Server)
@Controller('admin/resources')
export class ResourceCheckAdminController {
  constructor(private service: ResourceCheckService) {}

  @Get()
  @Endpoint({
    summary: 'Check the resources of the server',
    description:
      'The memory, cores and free disk of the server, and the machine learning services, against what is documented as needed',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ permission: Permission.ServerStatistics, admin: true })
  getResourceCheck(): Promise<ResourceCheckResponseDto> {
    return this.service.getResourceCheck();
  }

  @Get('setup')
  @Endpoint({
    summary: 'Check the resources of a new server',
    description:
      'As the check of the resources of the server, for the welcome page; only before an administrator exists',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ public: true, setup: true })
  getResourceSetupCheck(): Promise<ResourceCheckResponseDto> {
    return this.service.getResourceCheck();
  }
}
