import { Injectable } from '@nestjs/common';
import { ObjectStorageService } from '../../../common/storage/object-storage.service';
import { BackupStorageAdapter } from './backup-storage.interface';
import { LocalFilesystemBackupStorage } from './local-filesystem-backup-storage';

/**
 * Backups in the bucket once one is configured (under `backups/`), on the
 * server's own disk until then — which a host like Render wipes on every
 * deploy. A backup is read and deleted wherever its stored address says it is.
 */
@Injectable()
export class ObjectStorageBackupStorage implements BackupStorageAdapter {
  constructor(
    private readonly objects: ObjectStorageService,
    private readonly local: LocalFilesystemBackupStorage,
  ) {}

  async write(key: string, data: Buffer): Promise<string> {
    if (!this.objects.configured) return this.local.write(key, data);
    return this.objects.put(`backups/${key}`, data, 'application/gzip');
  }

  async read(storageUrl: string): Promise<Buffer> {
    const key = this.objects.keyOf(storageUrl);
    if (key === null) return this.local.read(storageUrl);
    const object = await this.objects.get(key);
    if (!object) throw new Error(`Backup not found in storage: ${key}`);
    return object.body;
  }

  async remove(storageUrl: string): Promise<void> {
    const key = this.objects.keyOf(storageUrl);
    if (key === null) return this.local.remove(storageUrl);
    await this.objects.remove(key);
  }
}
