import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { SentryModule } from '@sentry/nestjs/setup';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { MetricsInterceptor } from './common/interceptors/metrics.interceptor';
import { TenantContextInterceptor } from './common/interceptors/tenant-context.interceptor';
import { JwtStrategy } from './common/strategies/jwt.strategy';
import { envValidationSchema } from './config/env.validation';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { AuthModule } from './modules/auth/auth.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { FoliosModule } from './modules/folios/folios.module';
import { GdprModule } from './modules/gdpr/gdpr.module';
import { GuestsModule } from './modules/guests/guests.module';
import { HousekeepingModule } from './modules/housekeeping/housekeeping.module';
import { HqModule } from './modules/hq/hq.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { SalesEventsModule } from './modules/sales-events/sales-events.module';
import { RevenueManagementModule } from './modules/revenue-management/revenue-management.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { NightAuditModule } from './modules/night-audit/night-audit.module';
import { PosModule } from './modules/pos/pos.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { PropertyModule } from './modules/property/property.module';
import { PublicBookingModule } from './modules/public-booking/public-booking.module';
import { RateResolverModule } from './modules/rate-resolver/rate-resolver.module';
import { RegistrationCardsModule } from './modules/registration-cards/registration-cards.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { ShiftsModule } from './modules/shifts/shifts.module';
import { CommsLogModule } from './modules/comms-log/comms-log.module';
import { ReportsModule } from './modules/reports/reports.module';
import { BackupsModule } from './modules/backups/backups.module';
import { TaxesModule } from './modules/taxes/taxes.module';
import { SystemModule } from './modules/system/system.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    // Registered first per @sentry/nestjs's own setup docs — a no-op module
    // when `Sentry.init()` never ran (src/instrument.ts, gated on
    // SENTRY_DSN being set).
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    PassportModule,
    ScheduleModule.forRoot(),
    // Global default: 100 req/min per IP. Generous enough not to trip up
    // normal browsing/polling; the auth module overrides this per-route
    // with much tighter limits (see auth.controller.ts) since those routes
    // are @Public() — reachable with no JWT at all — and register()
    // specifically provisions a full tenant + owner + 6 system roles in
    // one transaction, not just an INSERT. In-memory storage (the
    // package's default) is fine for this single-instance deployment;
    // running more than one API instance would need a shared store (e.g.
    // the package's Redis storage adapter) so instances share counters.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    CommonModule,
    PrismaModule,
    SystemModule,
    AuthModule,
    TenantsModule,
    UsersModule,
    PropertyModule,
    GuestsModule,
    RateResolverModule,
    RegistrationCardsModule,
    ReservationsModule,
    TaxesModule,
    FoliosModule,
    NightAuditModule,
    HousekeepingModule,
    ShiftsModule,
    CommsLogModule,
    ReportsModule,
    BackupsModule,
    AlertsModule,
    AuditLogsModule,
    GdprModule,
    MaintenanceModule,
    FeatureFlagsModule,
    LoyaltyModule,
    HqModule,
    IntegrationsModule,
    SalesEventsModule,
    RevenueManagementModule,
    PublicBookingModule,
    PosModule,
    MarketingModule,
  ],
  providers: [
    JwtStrategy,
    // Order matters: throttle first (reject abusive traffic before it
    // costs a DB round-trip) → authenticate → validate tenant header ↔ JWT
    // claim → check roles.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Metrics first — its own `next.handle()` wraps every interceptor after
    // it, timing the full remaining pipeline (every request, including
    // @Public() ones) rather than just its own no-op work. Context next so
    // the audit interceptor can read it.
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
