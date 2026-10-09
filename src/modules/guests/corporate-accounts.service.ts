import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CorporateAccount, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateCorporateAccountDto, ListCorporateAccountsQueryDto, UpdateCorporateAccountDto } from './dto/corporate-account.dto';

const ACCOUNT_INCLUDE = {
  ratePlan: { select: { id: true, name: true, amount: true, branchId: true, isActive: true, branch: { select: { name: true, currency: true } } } },
  _count: { select: { reservations: true } },
} as const;

const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

/**
 * Companies whose people stay with you (Month 9: "a corporate account with a
 * contracted rate plan correctly resolves through the Rate Resolver for a
 * linked traveler's booking"). Tenant-wide, like guest profiles: a company
 * books at any of the group's properties.
 *
 * The contracted rate is a `negotiated` rate plan. A plan belongs to one
 * branch, so the contract applies there; at the others a company booking
 * still gets any `corporate` discount plan the branch runs. "Linked
 * travelers" are simply the guests who have stayed under the account — no
 * separate membership to keep in step.
 */
@Injectable()
export class CorporateAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active first, by name — a page at a time (`limit`/`offset`, every account up to 500 unless asked); `count` says how many match in all. */
  async list(tenantId: string, query: ListCorporateAccountsQueryDto = {}) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.corporateAccount.findMany({
        where: this.listWhere(query),
        include: ACCOUNT_INCLUDE,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        take: query.limit ?? 500,
        skip: query.offset ?? 0,
      }),
    );
  }

  async count(tenantId: string, query: ListCorporateAccountsQueryDto = {}): Promise<{ count: number }> {
    return this.prisma.withTenant(tenantId, async (tx) => ({ count: await tx.corporateAccount.count({ where: this.listWhere(query) }) }));
  }

  private listWhere(query: ListCorporateAccountsQueryDto): Prisma.CorporateAccountWhereInput {
    const search = query.search?.trim();
    const domain = search?.toLowerCase().replace(/^@+/, '');
    return {
      ...(query.active ? { isActive: query.active === 'true' } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { contactName: { contains: search, mode: 'insensitive' } },
              { contactEmail: { contains: search, mode: 'insensitive' } },
              ...(domain ? [{ emailDomains: { has: domain } }] : []),
            ],
          }
        : {}),
    };
  }

  /** The account with its travelers — everyone who has stayed under it — and its latest stays. */
  async detail(tenantId: string, accountId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const account = await tx.corporateAccount.findFirst({ where: { id: accountId }, include: ACCOUNT_INCLUDE });
      if (!account) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Company account not found' });
      const stays = await tx.reservation.findMany({
        where: { corporateAccountId: accountId, deletedAt: null },
        select: {
          id: true,
          confirmationNumber: true,
          status: true,
          checkInDate: true,
          checkOutDate: true,
          confirmedRate: true,
          guest: { select: { id: true, name: true, email: true, phone: true } },
          branch: { select: { name: true, currency: true } },
        },
        orderBy: { checkInDate: 'desc' },
        // The latest five hundred stays are plenty to list the travellers; the twenty newest are shown.
        take: 500,
      });
      const travelers = new Map<string, { guest: (typeof stays)[number]['guest']; stays: number; lastStay: Date }>();
      for (const stay of stays) {
        const known = travelers.get(stay.guest.id);
        if (known) known.stays += 1;
        else travelers.set(stay.guest.id, { guest: stay.guest, stays: 1, lastStay: stay.checkInDate });
      }
      return { ...account, travelers: [...travelers.values()], recentStays: stays.slice(0, 20) };
    });
  }

  async create(tenantId: string, dto: CreateCorporateAccountDto, actorId: string): Promise<CorporateAccount> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const name = dto.name.trim();
      if (!name) throw invalid('Give the company a name');
      await this.assertNameFree(tx, name);
      const ratePlanId = dto.ratePlanId ? await this.assertContractPlan(tx, dto.ratePlanId) : null;
      const account = await tx.corporateAccount.create({
        data: {
          tenantId,
          name,
          emailDomains: this.domains(dto.emailDomains ?? []),
          ratePlanId,
          contactName: dto.contactName?.trim() || null,
          contactEmail: dto.contactEmail?.trim().toLowerCase() || null,
          paymentTermsDays: dto.paymentTermsDays ?? null,
          billingInfo: dto.billingAddress?.trim() ? { address: dto.billingAddress.trim() } : undefined,
        },
      });
      await this.audit(tx, tenantId, actorId, 'corporate_account.created', account.id, { name, ratePlanId });
      return account;
    });
  }

  async update(tenantId: string, accountId: string, dto: UpdateCorporateAccountDto, actorId: string): Promise<CorporateAccount> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const account = await tx.corporateAccount.findFirst({ where: { id: accountId } });
      if (!account) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Company account not found' });
      const data: Prisma.CorporateAccountUncheckedUpdateInput = {};
      if (dto.name !== undefined) {
        const name = dto.name.trim();
        if (!name) throw invalid('Give the company a name');
        await this.assertNameFree(tx, name, accountId);
        data.name = name;
      }
      if (dto.emailDomains !== undefined) data.emailDomains = this.domains(dto.emailDomains);
      if (dto.ratePlanId !== undefined) data.ratePlanId = dto.ratePlanId === null ? null : await this.assertContractPlan(tx, dto.ratePlanId);
      if (dto.contactName !== undefined) data.contactName = dto.contactName.trim() || null;
      if (dto.contactEmail !== undefined) data.contactEmail = dto.contactEmail.trim().toLowerCase() || null;
      if (dto.paymentTermsDays !== undefined) data.paymentTermsDays = dto.paymentTermsDays;
      if (dto.billingAddress !== undefined) data.billingInfo = dto.billingAddress.trim() ? { address: dto.billingAddress.trim() } : Prisma.JsonNull;
      if (dto.isActive !== undefined) data.isActive = dto.isActive;
      const updated = await tx.corporateAccount.update({ where: { id: accountId }, data });
      await this.audit(tx, tenantId, actorId, 'corporate_account.updated', accountId, this.changes(account, updated));
      return updated;
    });
  }

  /** "Dangote.com", "@dangote.com", " dangote.com " → "dangote.com"; anything that isn't a domain is refused by name. */
  private domains(input: string[]): string[] {
    const cleaned = [...new Set(input.map((d) => d.trim().toLowerCase().replace(/^@+/, '')).filter(Boolean))];
    const bad = cleaned.find((d) => !DOMAIN.test(d));
    if (bad) throw invalid(`"${bad}" isn't an email domain — enter it like dangote.com`);
    return cleaned;
  }

  /** The contract has to be a live negotiated plan of this tenant — the only kind the Rate Resolver applies for a company. */
  private async assertContractPlan(tx: TenantTx, ratePlanId: string): Promise<string> {
    const plan = await tx.ratePlan.findFirst({ where: { id: ratePlanId }, select: { id: true, type: true, isActive: true } });
    if (!plan) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Rate plan not found' });
    if (plan.type !== 'negotiated') throw invalid('A contracted rate has to be a negotiated rate plan');
    if (!plan.isActive) throw invalid('That rate plan is switched off');
    return plan.id;
  }

  private async assertNameFree(tx: TenantTx, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.corporateAccount.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { name: true },
    });
    if (clash) throw new ConflictException({ code: ErrorCode.CONFLICT, message: `There's already a company called "${clash.name}"` });
  }

  private changes(before: CorporateAccount, after: CorporateAccount): Prisma.InputJsonValue {
    const keys = ['name', 'emailDomains', 'ratePlanId', 'contactName', 'contactEmail', 'paymentTermsDays', 'billingInfo', 'isActive'] as const;
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of keys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed[key] = { from: before[key], to: after[key] };
    }
    return changed as Prisma.InputJsonValue;
  }

  private async audit(tx: TenantTx, tenantId: string, userId: string, action: string, entityId: string, after: Prisma.InputJsonValue): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, userId, action, entityType: 'corporate_account', entityId, after } });
  }
}
