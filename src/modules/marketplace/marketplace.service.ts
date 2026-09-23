import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationConnection, Prisma } from '@prisma/client';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import {
  ACCOUNTING_PROVIDERS,
  AccountingConfig,
  AccountingProvider,
  DATE_FORMATS,
  DEPARTMENT_LABELS,
  METHOD_LABELS,
  PAYMENT_METHODS,
  REVENUE_DEPARTMENTS,
  defaultAccountingConfig,
  parseAccountingConfig,
} from './connectors/accounting-export';
import { DEFAULT_REVIEW_REQUEST, REVIEW_PLACEHOLDERS, ReviewRequestConfig, parseReviewRequestConfig } from './connectors/review-requests';
import { AvailableProvider, CATALOG, CatalogEntry, MARKETPLACE_CATEGORIES, catalogEntry, isAvailableProvider } from './marketplace-catalog';

export interface ConnectionState {
  status: 'enabled' | 'disabled';
  enabledAt: Date;
  disabledAt: Date | null;
  lastRunAt: Date | null;
  lastRunSummary: string | null;
}

export interface MarketplaceListing extends CatalogEntry {
  categoryLabel: string;
  /** null = never switched on. */
  connection: ConnectionState | null;
}

export interface MarketplaceView {
  categories: Array<{ key: string; label: string }>;
  listings: MarketplaceListing[];
}

export type ListingSetup =
  | {
      kind: 'accounting';
      departments: Array<{ key: string; label: string }>;
      methods: Array<{ key: string; label: string }>;
      dateFormats: readonly string[];
    }
  | {
      kind: 'review_requests';
      properties: Array<{ id: string; name: string }>;
      placeholders: readonly string[];
    }
  | { kind: 'none' };

export interface ListingDetail extends MarketplaceListing {
  /** The saved settings, or suggested ones until it has been set up — `configured` says which. */
  config: AccountingConfig | ReviewRequestConfig | null;
  configured: boolean;
  setup: ListingSetup;
}

/**
 * Who may switch a connector on or off. Anyone who can see the marketplace
 * can read it; an accounting export can also be set up by the accountant,
 * whose work it is. Sending guests email stays with owners and managers.
 */
const WRITE_ROLES: Record<AvailableProvider, readonly string[]> = {
  quickbooks_online: [SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant],
  xero: [SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant],
  review_requests: [SystemRole.Owner, SystemRole.Manager],
};

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

export function isAccountingProvider(provider: string): provider is AccountingProvider {
  return (ACCOUNTING_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * The Integrations Marketplace (Month 11): a browsable catalogue and one
 * enable → configure → disable lifecycle shared by every connector. The
 * connectors' own work lives beside it (`AccountingExportService`,
 * `ReviewRequestsService`); this service only owns the switch and the
 * settings, and re-validates the settings every time they're read.
 */
@Injectable()
export class MarketplaceService {
  constructor(private readonly prisma: PrismaService) {}

  async listCatalog(tenantId: string): Promise<MarketplaceView> {
    const connections = await this.prisma.withTenant(tenantId, (tx) => tx.integrationConnection.findMany());
    const byProvider = new Map(connections.map((connection) => [connection.provider, connection]));
    const listings = CATALOG.map((entry) => this.toListing(entry, byProvider.get(entry.key) ?? null));
    const usedCategories = new Set(CATALOG.map((entry) => entry.category));
    return {
      categories: Object.entries(MARKETPLACE_CATEGORIES)
        .filter(([key]) => usedCategories.has(key as keyof typeof MARKETPLACE_CATEGORIES))
        .map(([key, label]) => ({ key, label })),
      listings,
    };
  }

  async getListing(tenantId: string, provider: string): Promise<ListingDetail> {
    const entry = catalogEntry(provider);
    if (!entry) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'There’s no such integration' });

    return this.prisma.withTenant(tenantId, async (tx) => {
      const connection = await tx.integrationConnection.findFirst({ where: { provider } });
      const listing = this.toListing(entry, connection);
      if (!isAvailableProvider(provider)) return { ...listing, config: null, configured: false, setup: { kind: 'none' } };

      if (isAccountingProvider(provider)) {
        return {
          ...listing,
          config: connection ? parseAccountingConfig(connection.config) : defaultAccountingConfig(provider),
          configured: connection !== null,
          setup: {
            kind: 'accounting',
            departments: REVENUE_DEPARTMENTS.map((key) => ({ key, label: DEPARTMENT_LABELS[key] })),
            methods: PAYMENT_METHODS.map((key) => ({ key, label: METHOD_LABELS[key] })),
            dateFormats: DATE_FORMATS,
          },
        };
      }

      const properties = await this.properties(tx);
      return {
        ...listing,
        config: connection
          ? parseReviewRequestConfig(connection.config, properties.map((p) => p.id))
          : { ...DEFAULT_REVIEW_REQUEST, links: {} },
        configured: connection !== null,
        setup: { kind: 'review_requests', properties, placeholders: REVIEW_PLACEHOLDERS },
      };
    });
  }

  /**
   * Enable, or save new settings for one already on. Switching back on after
   * a disable restarts `enabledAt` — the review sweep counts from it, so
   * guests who left while it was off aren't asked retroactively. Changing the
   * settings of one that's on leaves it alone.
   */
  async saveConnection(tenantId: string, provider: string, rawConfig: unknown, actor: JwtPayload): Promise<ListingDetail> {
    this.assertCanWrite(provider, actor);
    await this.prisma.withTenant(tenantId, async (tx) => {
      const config = isAccountingProvider(provider)
        ? parseAccountingConfig(rawConfig)
        : parseReviewRequestConfig(rawConfig, (await this.properties(tx)).map((p) => p.id));

      const existing = await tx.integrationConnection.findFirst({ where: { provider } });
      const now = new Date();
      const data = { config: config as unknown as Prisma.InputJsonValue, updatedBy: actor.sub };
      if (!existing) {
        await tx.integrationConnection.create({ data: { ...data, tenantId, provider, status: 'enabled', enabledAt: now, enabledBy: actor.sub } });
      } else if (existing.status === 'disabled') {
        await tx.integrationConnection.update({
          where: { id: existing.id },
          data: { ...data, status: 'enabled', enabledAt: now, enabledBy: actor.sub, disabledAt: null },
        });
      } else {
        await tx.integrationConnection.update({ where: { id: existing.id }, data });
      }
      await this.audit(tx, tenantId, actor.sub, existing?.status === 'enabled' ? 'integration.configured' : 'integration.enabled', provider);
    });
    return this.getListing(tenantId, provider);
  }

  /** Keeps the settings, so switching back on doesn't mean re-entering an account map. */
  async disable(tenantId: string, provider: string, actor: JwtPayload): Promise<ListingDetail> {
    this.assertCanWrite(provider, actor);
    await this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.integrationConnection.findFirst({ where: { provider } });
      if (!existing || existing.status === 'disabled') return;
      await tx.integrationConnection.update({ where: { id: existing.id }, data: { status: 'disabled', disabledAt: new Date(), updatedBy: actor.sub } });
      await this.audit(tx, tenantId, actor.sub, 'integration.disabled', provider);
    });
    return this.getListing(tenantId, provider);
  }

  /** For the connectors: the settings of one that's switched on, or a clear refusal. */
  async enabledConnection(tx: TenantTx, provider: AvailableProvider): Promise<IntegrationConnection> {
    const connection = await tx.integrationConnection.findFirst({ where: { provider, status: 'enabled' } });
    if (!connection) {
      const name = catalogEntry(provider)?.name ?? provider;
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: `${name} isn’t switched on. Set it up in the Integrations Marketplace first.` });
    }
    return connection;
  }

  private assertCanWrite(provider: string, actor: JwtPayload): void {
    const entry = catalogEntry(provider);
    if (!entry) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'There’s no such integration' });
    if (!isAvailableProvider(provider)) throw invalid(`${entry.name} isn’t available yet — it’s waiting on ${entry.waitingOn ?? 'more work'}`);
    // Tenant-wide settings, so any branch's role counts — the same rule RolesGuard applies to a route with no branch in it.
    if (!actor.roles.some((r) => WRITE_ROLES[provider].includes(r.role))) {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Insufficient role for this action' });
    }
  }

  private properties(tx: TenantTx): Promise<Array<{ id: string; name: string }>> {
    return tx.branch.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }

  private toListing(entry: CatalogEntry, connection: IntegrationConnection | null): MarketplaceListing {
    return {
      ...entry,
      categoryLabel: MARKETPLACE_CATEGORIES[entry.category],
      connection: connection
        ? {
            status: connection.status,
            enabledAt: connection.enabledAt,
            disabledAt: connection.disabledAt,
            lastRunAt: connection.lastRunAt,
            lastRunSummary: connection.lastRunSummary,
          }
        : null,
    };
  }

  private async audit(tx: TenantTx, tenantId: string, userId: string, action: string, provider: string): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, userId, action, entityType: 'integration_connection', after: { provider } } });
  }
}
