import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './context/tenant-context.service';
import { EncryptionService } from './crypto/encryption.service';
import { DOCUMENT_STORAGE_ADAPTER } from './documents/document-storage.interface';
import { LocalFilesystemDocumentStorage } from './documents/local-filesystem-document-storage';
import { MetricsService } from './metrics/metrics.service';

@Global()
@Module({
  providers: [
    TenantContextService,
    EncryptionService,
    MetricsService,
    { provide: DOCUMENT_STORAGE_ADAPTER, useClass: LocalFilesystemDocumentStorage },
  ],
  exports: [TenantContextService, EncryptionService, MetricsService, DOCUMENT_STORAGE_ADAPTER],
})
export class CommonModule {}
