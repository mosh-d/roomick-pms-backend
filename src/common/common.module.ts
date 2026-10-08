import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccountStatusService } from './auth/account-status.service';
import { ApiKeyAuthService } from './auth/api-key-auth.service';
import { TenantContextService } from './context/tenant-context.service';
import { EncryptionService } from './crypto/encryption.service';
import { DOCUMENT_STORAGE_ADAPTER } from './documents/document-storage.interface';
import { LocalFilesystemDocumentStorage } from './documents/local-filesystem-document-storage';
import { AccountMailService } from './mail/account-mail.service';
import { LogMailTransport } from './mail/log-mail-transport';
import { MAIL_TRANSPORT, MailTransport } from './mail/mail-transport.interface';
import { SmtpMailTransport, smtpSettingsFromEnv } from './mail/smtp-mail-transport';
import { MetricsService } from './metrics/metrics.service';
import { PageAccessService } from './permissions/page-access.service';
import { PermissionsService } from './permissions/permissions.service';
import { RoutePermissionMapService } from './permissions/route-permission-map.service';

@Global()
@Module({
  // DiscoveryModule lets RoutePermissionMapService read what each route requires.
  imports: [DiscoveryModule],
  providers: [
    // Signs a request in with an API key — `JwtAuthGuard` is global, so this is too.
    ApiKeyAuthService,
    // Whether the person behind a token still has an account — asked by `JwtAuthGuard` on every request.
    AccountStatusService,
    AccountMailService,
    TenantContextService,
    EncryptionService,
    MetricsService,
    PermissionsService,
    PageAccessService,
    RoutePermissionMapService,
    { provide: DOCUMENT_STORAGE_ADAPTER, useClass: LocalFilesystemDocumentStorage },
    // SMTP once `SMTP_HOST` is set (any provider — they all take SMTP), the
    // log transport until then, so development sends nothing by default.
    {
      provide: MAIL_TRANSPORT,
      useFactory: (): MailTransport => {
        const smtp = smtpSettingsFromEnv(process.env);
        return smtp ? new SmtpMailTransport(smtp) : new LogMailTransport();
      },
    },
  ],
  exports: [ApiKeyAuthService, AccountStatusService, AccountMailService, TenantContextService, EncryptionService, MetricsService, PermissionsService, PageAccessService, RoutePermissionMapService, DOCUMENT_STORAGE_ADAPTER, MAIL_TRANSPORT],
})
export class CommonModule {}
