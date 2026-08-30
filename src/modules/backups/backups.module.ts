import { Module } from '@nestjs/common';
import { BackupsController } from './backups.controller';
import { BackupsScheduler } from './backups.scheduler';
import { BackupsService } from './backups.service';
import { BACKUP_STORAGE_ADAPTER } from './storage/backup-storage.interface';
import { LocalFilesystemBackupStorage } from './storage/local-filesystem-backup-storage';

@Module({
  controllers: [BackupsController],
  providers: [BackupsService, BackupsScheduler, { provide: BACKUP_STORAGE_ADAPTER, useClass: LocalFilesystemBackupStorage }],
  exports: [BackupsService],
})
export class BackupsModule {}
