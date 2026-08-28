import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { DocumentStorageAdapter } from './document-storage.interface';

/**
 * MVP stand-in for real object storage (S3 or equivalent — schema comments
 * for `idDocUrl`/`documentUrl` both name "encrypted S3 bucket URL" as the
 * eventual target). Mirrors `LocalFilesystemBackupStorage`'s own shape
 * exactly, on its own env var so document and backup storage can be pointed
 * at different disks/volumes independently.
 */
@Injectable()
export class LocalFilesystemDocumentStorage implements DocumentStorageAdapter {
  // `||`, not `??` — an explicitly blank `DOCUMENT_STORAGE_DIR=` must fall
  // back too, matching `BACKUP_STORAGE_DIR`'s own convention.
  private readonly dir = process.env.DOCUMENT_STORAGE_DIR || join(tmpdir(), 'roomick-documents');

  async write(key: string, data: Buffer): Promise<string> {
    const filePath = join(this.dir, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return `file://${filePath}`;
  }

  async read(storageUrl: string): Promise<Buffer> {
    const filePath = storageUrl.replace(/^file:\/\//, '');
    return readFile(filePath);
  }
}
