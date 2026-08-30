import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { BackupsService, BackupRecordSummary, RestoreDrillResult } from './backups.service';

@ApiTags('backups')
@ApiBearerAuth()
@Controller('backups')
@Roles(SystemRole.Owner)
export class BackupsController {
  constructor(private readonly backupsService: BackupsService) {}

  @Get()
  @ApiOperation({ summary: 'System Admin — this tenant’s own backup history' })
  list(@CurrentTenant() tenantId: string): Promise<BackupRecordSummary[]> {
    return this.backupsService.listBackups(tenantId);
  }

  @Post()
  @ApiOperation({ summary: 'Trigger an on-demand backup for this tenant, outside the nightly schedule' })
  trigger(@CurrentTenant() tenantId: string): ReturnType<BackupsService['runTenantBackup']> {
    return this.backupsService.runTenantBackup(tenantId);
  }

  @Post(':backupId/verify')
  @ApiOperation({ summary: 'Confirm a stored backup file is readable and has the expected tables/row counts' })
  verify(
    @CurrentTenant() tenantId: string,
    @Param('backupId', ParseUUIDPipe) backupId: string,
  ): ReturnType<BackupsService['verifyOwnedBackup']> {
    return this.backupsService.verifyOwnedBackup(tenantId, backupId);
  }

  @Post(':backupId/restore-drill')
  @ApiOperation({ summary: 'Restore this backup into a throwaway tenant, verify row counts, then delete it — proves the backup is actually restorable' })
  restoreDrill(@CurrentTenant() tenantId: string, @Param('backupId', ParseUUIDPipe) backupId: string): Promise<RestoreDrillResult> {
    return this.backupsService.restoreDrillOwnedBackup(tenantId, backupId);
  }
}
