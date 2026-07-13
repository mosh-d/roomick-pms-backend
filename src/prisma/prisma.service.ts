import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Prisma transaction client scoped to a tenant (RLS context applied).
 */
export type TenantTx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      // Round-trip a real query so "connected" means the DB actually answers.
      await this.$queryRaw`SELECT 1`;
      this.logger.log(`Database connected: ${this.describeDatasource()}`);
    } catch (err) {
      // Don't kill the boot on a transient DB outage — Prisma reconnects on
      // first query and /system/health reports the database as down meanwhile.
      this.logger.error(`Database connection FAILED at startup (${this.describeDatasource()})`, err);
    }
  }

  /** Human-readable datasource identity for logs — never includes the password. */
  private describeDatasource(): string {
    try {
      const url = new URL(process.env.DATABASE_URL ?? '');
      const db = url.pathname.replace(/^\//, '') || '<no-db>';
      return `${url.username || '<no-user>'}@${url.hostname}:${url.port || '5432'}/${db}`;
    } catch {
      return '<unparseable DATABASE_URL>';
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs `fn` inside a transaction with `app.tenant_id` set via SET LOCAL,
   * so PostgreSQL RLS policies (`"tenantId" = current_setting('app.tenant_id')::uuid`)
   * apply to every statement in the transaction.
   *
   * This is the ONLY sanctioned way to touch tenant-scoped tables.
   * Application-layer guards still filter by tenantId (defense in depth) —
   * RLS is the backstop, not the only gate (spec §1.2).
   */
  async withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      // set_config(..., true) = SET LOCAL — reverts at transaction end
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }
}
