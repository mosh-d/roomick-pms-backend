import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './context/tenant-context.service';
import { EncryptionService } from './crypto/encryption.service';
import { DOCUMENT_STORAGE_ADAPTER } from './documents/document-storage.interface';
import { LocalFilesystemDocumentStorage } from './documents/local-filesystem-document-storage';

@Global()
@Module({
  providers: [
    TenantContextService,
    EncryptionService,
    { provide: DOCUMENT_STORAGE_ADAPTER, useClass: LocalFilesystemDocumentStorage },
  ],
  exports: [TenantContextService, EncryptionService, DOCUMENT_STORAGE_ADAPTER],
})
export class CommonModule {}
