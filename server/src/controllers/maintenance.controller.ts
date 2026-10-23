import { BadRequestException, Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  MaintenanceAuthDto,
  MaintenanceDetectInstallResponseDto,
  MaintenanceLoginDto,
  MaintenanceStatusResponseDto,
  SetMaintenanceModeDto,
} from 'src/dtos/maintenance.dto.js';
import {
  StoredDatabaseBackupFetchResponseDto,
  StoredDatabaseBackupKeyParamDto,
  StoredDatabaseBackupListResponseDto,
} from 'src/dtos/storage-backup.dto.js';
import { StorageSetupResponseDto } from 'src/dtos/storage-setup.dto.js';
import { ApiTag, ImmichCookie, MaintenanceAction, Permission } from 'src/enum.js';
import { Auth, Authenticated, GetLoginDetails } from 'src/middleware/auth.guard.js';
import { MaintenanceService } from 'src/services/maintenance.service.js';
import { respondWithCookie } from 'src/utils/response.js';

@ApiTags(ApiTag.Maintenance)
@Controller('admin/maintenance')
export class MaintenanceController {
  constructor(private service: MaintenanceService) {}

  @Get('status')
  @Endpoint({
    summary: 'Get maintenance mode status',
    description: 'Fetch information about the currently running maintenance action.',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
  @Authenticated({ public: true })
  getMaintenanceStatus(): MaintenanceStatusResponseDto {
    return this.service.getMaintenanceStatus();
  }

  @Get('detect-install')
  @Endpoint({
    summary: 'Detect existing install',
    description: 'Collect integrity checks and other heuristics about local data.',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  detectPriorInstall(): Promise<MaintenanceDetectInstallResponseDto> {
    return this.service.detectPriorInstall();
  }

  @Post('login')
  @Endpoint({
    summary: 'Log into maintenance mode',
    description: 'Login with maintenance token or cookie to receive current information and perform further actions.',
    history: new HistoryBuilder().added('v2.3.0').alpha('v2.3.0'),
  })
  @Authenticated({ public: true })
  maintenanceLogin(@Body() _dto: MaintenanceLoginDto): MaintenanceAuthDto {
    throw new BadRequestException('Not in maintenance mode');
  }

  // the storage setup and restoring from the backend for backups, which only the maintenance worker answers

  @Get('storage')
  @Endpoint({
    summary: 'Check the storage in maintenance mode',
    description:
      'What is wrong with the storage configuration of a new server, and what storage holds; without authentication before an administrator exists',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ public: true })
  getMaintenanceStorageSetup(): StorageSetupResponseDto {
    throw new BadRequestException('Not in maintenance mode');
  }

  @Post('storage/continue')
  @Endpoint({
    summary: 'Continue after the storage setup',
    description: 'Check the storage again and, when nothing is wrong, end maintenance mode to start normally',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ public: true })
  continueAfterStorageSetup(): StorageSetupResponseDto {
    throw new BadRequestException('Not in maintenance mode');
  }

  @Get('storage/database-backups')
  @Endpoint({
    summary: 'List the database backups in storage in maintenance mode',
    description: 'The database backups on the storage backend for backups, to restore one',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  getMaintenanceStoredDatabaseBackups(): StoredDatabaseBackupListResponseDto {
    throw new BadRequestException('Not in maintenance mode');
  }

  @Post('storage/database-backups/:key/fetch')
  @Endpoint({
    summary: 'Fetch a database backup from storage in maintenance mode',
    description: 'Copy a database backup from the storage backend for backups into the backups folder, to restore it',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  fetchMaintenanceStoredDatabaseBackup(
    @Param() _params: StoredDatabaseBackupKeyParamDto,
  ): StoredDatabaseBackupFetchResponseDto {
    throw new BadRequestException('Not in maintenance mode');
  }

  @Post()
  @Endpoint({
    summary: 'Set maintenance mode',
    description: 'Put Immich into or take it out of maintenance mode',
    history: new HistoryBuilder().added('v2.3.0').alpha('v2.3.0'),
  })
  @Authenticated({ permission: Permission.Maintenance, admin: true })
  async setMaintenanceMode(
    @Auth() auth: AuthDto,
    @Body() dto: SetMaintenanceModeDto,
    @GetLoginDetails() loginDetails: LoginDetails,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (dto.action === MaintenanceAction.End) {
      return;
    }

    const { jwt } = await this.service.startMaintenance(dto, auth.user.name);
    return respondWithCookie(res, undefined, {
      isSecure: loginDetails.isSecure,
      values: [{ key: ImmichCookie.MaintenanceToken, value: jwt }],
    });
  }
}
