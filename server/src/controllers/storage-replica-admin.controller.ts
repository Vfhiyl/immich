import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StorageReplicaFailingResponseDto,
  StorageReplicaListResponseDto,
  StorageReplicaParamDto,
  StorageReplicaRetryResponseDto,
} from 'src/dtos/storage-replica.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { StorageReplicaService } from 'src/services/storage-replica.service.js';

/** The replicas configured in the storage backend configuration, and how far copying to them is */
@ApiTags(ApiTag.Maintenance)
@Controller('admin/storage/replicas')
export class StorageReplicaAdminController {
  constructor(private service: StorageReplicaService) {}

  @Get()
  @Endpoint({
    summary: 'List the replicas',
    description: 'Each replica with what it copies, what is copied and what waits, and the last reconciliation',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getStorageReplicas(): Promise<StorageReplicaListResponseDto> {
    return this.service.getReplicas();
  }

  @Get(':id/failing')
  @Endpoint({
    summary: 'List failing copies',
    description: 'Files whose copy to the replica failed several times, with why',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getFailingStorageReplicaCopies(@Param() { id }: StorageReplicaParamDto): Promise<StorageReplicaFailingResponseDto> {
    return this.service.getFailing(id);
  }

  @Post(':id/retry')
  @Endpoint({
    summary: 'Retry failed copies',
    description: 'Copy the files whose copy to the replica failed again now',
    history: new HistoryBuilder().added('v3.3.4').alpha('v3.3.4'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  retryStorageReplicaCopies(@Param() { id }: StorageReplicaParamDto): Promise<StorageReplicaRetryResponseDto> {
    return this.service.retryFailed(id);
  }
}
