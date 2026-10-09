import { Injectable } from '@nestjs/common';
import { ObjectStorageService } from '../storage/object-storage.service';
import { DocumentStorageAdapter } from './document-storage.interface';
import { LocalFilesystemDocumentStorage } from './local-filesystem-document-storage';

/**
 * Compliance documents in the bucket once one is configured (under
 * `documents/`), on the server's own disk until then. A document is read and
 * deleted wherever its stored address says it is, so the ones written to disk
 * before the bucket was set up still open. Bytes arrive already encrypted.
 */
@Injectable()
export class ObjectStorageDocumentStorage implements DocumentStorageAdapter {
  constructor(
    private readonly objects: ObjectStorageService,
    private readonly local: LocalFilesystemDocumentStorage,
  ) {}

  async write(key: string, data: Buffer): Promise<string> {
    if (!this.objects.configured) return this.local.write(key, data);
    return this.objects.put(`documents/${key}`, data, 'application/octet-stream');
  }

  async read(storageUrl: string): Promise<Buffer> {
    const key = this.objects.keyOf(storageUrl);
    if (key === null) return this.local.read(storageUrl);
    const object = await this.objects.get(key);
    if (!object) throw new Error(`Document not found in storage: ${key}`);
    return object.body;
  }

  async remove(storageUrl: string): Promise<void> {
    const key = this.objects.keyOf(storageUrl);
    if (key === null) return this.local.remove(storageUrl);
    await this.objects.remove(key);
  }
}
