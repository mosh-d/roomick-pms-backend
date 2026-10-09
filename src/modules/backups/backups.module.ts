import { Module } from '@nestjs/common';
import { BackupsController } from './backups.controller';
import { BackupsScheduler } from './backups.scheduler';
import { BackupsService } from './backups.service';
import { BACKUP_STORAGE_ADAPTER } from './storage/backup-storage.interface';
import { LocalFilesystemBackupStorage } from './storage/local-filesystem-backup-storage';
import { ObjectStorageBackupStorage } from './storage/object-storage-backup-storage';

@Module({
  controllers: [BackupsController],
  // The bucket once STORAGE_S3_* is set (ObjectStorageService, from the global CommonModule), the server's own disk until then.
  providers: [BackupsService, BackupsScheduler, LocalFilesystemBackupStorage, { provide: BACKUP_STORAGE_ADAPTER, useClass: ObjectStorageBackupStorage }],
  exports: [BackupsService],
})
export class BackupsModule {}
