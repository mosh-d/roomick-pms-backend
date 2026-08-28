import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { BackupStorageAdapter } from './backup-storage.interface';

/**
 * MVP stand-in for real object storage (S3 or equivalent, spec's own
 * eventual target). Writes under `BACKUP_STORAGE_DIR` if set, otherwise the
 * OS temp dir — deliberately never inside the repo itself, so a local
 * backup run can never show up as an untracked file in `git status`.
 * `storageUrl` is a plain `file://` path; a real adapter would return an
 * `s3://bucket/key` URL instead, but nothing outside this class parses
 * that format, so the swap is contained here.
 */
@Injectable()
export class LocalFilesystemBackupStorage implements BackupStorageAdapter {
  // `||`, not `??` — an explicitly blank `BACKUP_STORAGE_DIR=` in `.env` (this
  // project's own convention for "optional, left unset") must fall back too,
  // not resolve paths against an empty string.
  private readonly dir = process.env.BACKUP_STORAGE_DIR || join(tmpdir(), 'roomick-backups');

  async write(key: string, data: Buffer): Promise<string> {
    const filePath = join(this.dir, key);
    // `key` carries a `<tenantId>/<recordId>.json.gz` structure — mkdir the
    // file's own parent, not just the base dir, or a fresh tenant's first
    // backup ever ENOENTs on the still-nonexistent tenant subdirectory.
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return `file://${filePath}`;
  }

  async read(storageUrl: string): Promise<Buffer> {
    const filePath = storageUrl.replace(/^file:\/\//, '');
    return readFile(filePath);
  }
}
