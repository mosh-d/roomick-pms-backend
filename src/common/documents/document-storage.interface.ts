/**
 * Where an encrypted compliance document's bytes actually land — registration
 * card PDFs, generated report PDFs, guest ID document photos. Deliberately a
 * SEPARATE interface from `BackupStorageAdapter` (`src/modules/backups/storage/`)
 * even though the shape looks identical: backups and compliance documents are
 * different consumers with different retention/access rules, and this
 * codebase's own precedent (CommsLog's adapter, Backups' adapter) is
 * duplication over stretching one shared shape to fit both. Bytes handed to
 * `write` are expected to already be encrypted (`EncryptionService.encryptBuffer`)
 * — this interface only moves bytes, it never decides whether to encrypt them.
 */
export interface DocumentStorageAdapter {
  /** Writes `data` under `key`, returns a URL/path that `read` can resolve back. */
  write(key: string, data: Buffer): Promise<string>;
  read(storageUrl: string): Promise<Buffer>;
}

export const DOCUMENT_STORAGE_ADAPTER = 'DOCUMENT_STORAGE_ADAPTER';
