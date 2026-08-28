/**
 * Where a backup's bytes actually land — deliberately the one pluggable
 * seam in this module, the same "stubbed adapter behind a real interface"
 * shape `CommsLogService`'s sending adapter and `RegistrationCardsService`'s
 * document storage both already use in this codebase. `LocalFilesystemBackupStorage`
 * is the only implementation today; swapping in real S3 (or equivalent)
 * later needs a new class implementing this interface and a one-line
 * provider change in `backups.module.ts` — nothing in `BackupsService`
 * itself changes.
 */
export interface BackupStorageAdapter {
  /** Writes `data` under `key`, returns a URL/path that `read` can resolve back. */
  write(key: string, data: Buffer): Promise<string>;
  read(storageUrl: string): Promise<Buffer>;
}

export const BACKUP_STORAGE_ADAPTER = 'BACKUP_STORAGE_ADAPTER';
