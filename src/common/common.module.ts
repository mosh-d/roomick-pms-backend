import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { TenantContextService } from './context/tenant-context.service';
import { EncryptionService } from './crypto/encryption.service';
import { DOCUMENT_STORAGE_ADAPTER } from './documents/document-storage.interface';
import { LocalFilesystemDocumentStorage } from './documents/local-filesystem-document-storage';
import { LogMailTransport } from './mail/log-mail-transport';
import { MAIL_TRANSPORT } from './mail/mail-transport.interface';
import { MetricsService } from './metrics/metrics.service';
import { PermissionsService } from './permissions/permissions.service';
import { RoutePermissionMapService } from './permissions/route-permission-map.service';

@Global()
@Module({
  // DiscoveryModule lets RoutePermissionMapService read what each route requires.
  imports: [DiscoveryModule],
  providers: [
    TenantContextService,
    EncryptionService,
    MetricsService,
    PermissionsService,
    RoutePermissionMapService,
    { provide: DOCUMENT_STORAGE_ADAPTER, useClass: LocalFilesystemDocumentStorage },
    // Only a log-only transport exists today, so it's bound unconditionally
    // rather than behind an env switch — a `MAIL_TRANSPORT=smtp` branch with
    // exactly one possible value would be indirection pretending to be a
    // choice. Add the switch alongside the second implementation, not before.
    { provide: MAIL_TRANSPORT, useClass: LogMailTransport },
  ],
  exports: [TenantContextService, EncryptionService, MetricsService, PermissionsService, RoutePermissionMapService, DOCUMENT_STORAGE_ADAPTER, MAIL_TRANSPORT],
})
export class CommonModule {}
