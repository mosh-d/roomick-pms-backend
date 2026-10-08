import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReportTemplate } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { branchDayStart, localDateOf, toBranchDate } from '../../common/utils/branch-date';
import { csvCell } from '../../common/utils/csv';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { CatalogField, DATASETS, DatasetKey, OPERATORS, datasetOf } from './custom-report.catalog';
import { CustomReportDefinitionDto, RunCustomReportDto } from './dto/custom-report.dto';

type Cell = string | number | null;
type Row = Record<string, Cell>;

/** More rows than this and the dates are too wide for one report — narrow them. */
const MAX_ROWS = 20_000;
/** A preview shows this many; the CSV has them all. */
const PREVIEW_ROWS = 500;

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const money = (d: Prisma.Decimal | null | undefined) => (d ? d.toFixed(2) : null);

export interface CustomReportResult {
  columns: Array<{ key: string; label: string; type: CatalogField['type'] }>;
  rows: Row[];
  total: number;
  /** The preview shows the first rows only — the CSV has every one. */
  previewOnly: boolean;
  /** The branch's ISO 4217 code, for the money columns. */
  currency: string;
}

/**
 * Custom Report Builder (ref: "Select fields, filters, groupings, save
 * templates"). A report is a dataset from the catalogue, the columns wanted,
 * filters, an optional grouping and a sort, run for a range of dates. Rows
 * are read for the dates in one query with a fixed set of columns, then
 * filtered, grouped and sorted here — the request never shapes the query
 * itself, so nothing outside the catalogue can be reached. Grouping gives
 * one row per value with a count and the sum of each money and number
 * column picked.
 */
@Injectable()
export class CustomReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
  ) {}

  catalogue() {
    return { datasets: DATASETS, operators: OPERATORS };
  }

  async run(tenantId: string, branchId: string, dto: RunCustomReportDto): Promise<CustomReportResult> {
    const { columns, rows, currency } = await this.compute(tenantId, branchId, dto);
    return { columns, rows: rows.slice(0, PREVIEW_ROWS), total: rows.length, previewOnly: rows.length > PREVIEW_ROWS, currency };
  }

  async runCsv(tenantId: string, branchId: string, dto: RunCustomReportDto): Promise<string> {
    const { columns, rows } = await this.compute(tenantId, branchId, dto);
    return [columns.map((c) => csvCell(c.label)).join(','), ...rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(','))].join('\n');
  }

  async listTemplates(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return tx.reportTemplate.findMany({
        where: { branchId },
        include: { createdByUser: { select: { name: true } } },
        orderBy: { name: 'asc' },
      });
    });
  }

  /** Saves a report under a name — saving again under the same name replaces it. */
  async saveTemplate(tenantId: string, branchId: string, name: string, definition: CustomReportDefinitionDto, actorId: string): Promise<ReportTemplate> {
    this.validate(definition);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const clean: Prisma.InputJsonObject = {
        dataset: definition.dataset,
        fields: definition.fields,
        filters: (definition.filters ?? []).map((f) => ({ field: f.field, operator: f.operator, value: f.value })),
        groupBy: definition.groupBy ?? null,
        sortBy: definition.sortBy ?? null,
        sortDir: definition.sortDir ?? 'asc',
      };
      const template = await tx.reportTemplate.upsert({
        where: { branchId_name: { branchId, name: name.trim() } },
        create: { tenantId, branchId, name: name.trim(), definition: clean, createdBy: actorId },
        update: { definition: clean },
      });
      await tx.auditLog.create({
        data: { tenantId, branchId, userId: actorId, action: 'report_template.saved', entityType: 'report_template', entityId: template.id, after: { name: template.name, dataset: definition.dataset } },
      });
      return template;
    });
  }

  async deleteTemplate(tenantId: string, templateId: string, actorId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const template = await tx.reportTemplate.findFirst({ where: { id: templateId } });
      if (!template) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Saved report not found' });
      await tx.reportTemplate.delete({ where: { id: templateId } });
      await tx.auditLog.create({
        data: { tenantId, branchId: template.branchId, userId: actorId, action: 'report_template.deleted', entityType: 'report_template', entityId: templateId, after: { name: template.name } },
      });
    });
  }

  // -------------------------------------------------------------------------

  private async compute(tenantId: string, branchId: string, dto: RunCustomReportDto) {
    const { dataset, fields, groupBy } = this.validate(dto);
    if (dto.to <= dto.from) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'The end date must be after the start date' });

    const { loaded, currency } = await this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      return { loaded: await this.load(tx, dataset, branchId, branch.timezone, dto.from, dto.to), currency: branch.currency };
    });
    if (loaded.length > MAX_ROWS) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `More than ${MAX_ROWS.toLocaleString()} rows in these dates — narrow them` });
    }

    const filtered = loaded.filter((row) => (dto.filters ?? []).every((f) => this.matches(row[f.field], fields.get(f.field)!.type, f.operator, f.value)));

    let columns: CustomReportResult['columns'];
    let rows: Row[];
    if (groupBy) {
      const totals = dto.fields.map((key) => fields.get(key)!).filter((f) => f.type === 'money' || f.type === 'number');
      const groups = new Map<string, { count: number; sums: Map<string, Prisma.Decimal> }>();
      const zero = new Prisma.Decimal(0);
      for (const row of filtered) {
        const key = String(row[groupBy.key] ?? '—');
        const group = groups.get(key) ?? { count: 0, sums: new Map<string, Prisma.Decimal>() };
        group.count += 1;
        for (const f of totals) group.sums.set(f.key, (group.sums.get(f.key) ?? zero).plus(Number(row[f.key] ?? 0)));
        groups.set(key, group);
      }
      columns = [
        { key: groupBy.key, label: groupBy.label, type: groupBy.type },
        { key: 'count', label: 'Count', type: 'number' },
        ...totals.map((f) => ({ key: f.key, label: `${f.label} (total)`, type: f.type })),
      ];
      rows = [...groups.entries()].map(([value, g]) => ({
        [groupBy.key]: value,
        count: g.count,
        ...Object.fromEntries(totals.map((f) => [f.key, f.type === 'money' ? g.sums.get(f.key)!.toFixed(2) : Number(g.sums.get(f.key)!.toFixed(2))])),
      }));
    } else {
      columns = dto.fields.map((key) => {
        const f = fields.get(key)!;
        return { key: f.key, label: f.label, type: f.type };
      });
      rows = filtered.map((row) => Object.fromEntries(dto.fields.map((key) => [key, row[key] ?? null])));
    }

    const sortKey = dto.sortBy && columns.some((c) => c.key === dto.sortBy) ? dto.sortBy : null;
    if (sortKey) {
      const type = columns.find((c) => c.key === sortKey)!.type;
      const dir = dto.sortDir === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const x = a[sortKey];
        const y = b[sortKey];
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (type === 'money' || type === 'number' ? Number(x) - Number(y) : String(x).localeCompare(String(y))) * dir;
      });
    }
    return { columns, rows, currency };
  }

  /** Every name in a report must be in the catalogue — the dataset, each column, filter field and operator, the grouping. */
  private validate(def: CustomReportDefinitionDto) {
    const dataset = datasetOf(def.dataset);
    if (!dataset) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Pick a dataset from the list' });
    const fields = new Map(dataset.fields.map((f) => [f.key, f]));
    const unknown = def.fields.filter((key) => !fields.has(key));
    if (unknown.length) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `${dataset.label} has no column ${unknown.join(', ')}` });
    for (const f of def.filters ?? []) {
      const field = fields.get(f.field);
      if (!field) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `${dataset.label} has no column ${f.field} to filter on` });
      if (!OPERATORS[field.type].some((op) => op.key === f.operator)) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `"${f.operator}" can't be used on ${field.label}` });
      }
    }
    let groupBy: CatalogField | null = null;
    if (def.groupBy) {
      groupBy = fields.get(def.groupBy) ?? null;
      if (!groupBy || groupBy.type === 'money' || groupBy.type === 'number') {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Group by a text, list or date column' });
      }
    }
    return { dataset, fields, groupBy };
  }

  private matches(cell: Cell, type: CatalogField['type'], operator: string, value: string): boolean {
    if (type === 'text' || type === 'enum') {
      const a = String(cell ?? '').toLowerCase();
      const b = value.trim().toLowerCase();
      if (operator === 'contains') return a.includes(b);
      if (operator === 'equals') return a === b;
      return a !== b;
    }
    if (type === 'date') {
      if (cell === null) return false;
      const a = String(cell);
      if (operator === 'on') return a === value;
      if (operator === 'before') return a < value;
      return a > value;
    }
    if (cell === null) return false;
    const a = Number(cell);
    const b = Number(value);
    if (!Number.isFinite(b)) return false;
    switch (operator) {
      case 'eq':
        return a === b;
      case 'ne':
        return a !== b;
      case 'gt':
        return a > b;
      case 'gte':
        return a >= b;
      case 'lt':
        return a < b;
      default:
        return a <= b;
    }
  }

  /** One dataset's rows for the dates, as flat cells keyed by catalogue field — one more than the limit at most, to know it's over. */
  private async load(tx: TenantTx, dataset: { key: DatasetKey }, branchId: string, timezone: string, fromStr: string, toStr: string): Promise<Row[]> {
    const from = toBranchDate(fromStr);
    const to = toBranchDate(toStr);
    const take = MAX_ROWS + 1;
    switch (dataset.key) {
      case 'reservations': {
        const rows = await tx.reservation.findMany({
          where: { branchId, deletedAt: null, checkInDate: { gte: from, lt: to } },
          select: {
            confirmationNumber: true,
            status: true,
            channel: true,
            checkInDate: true,
            checkOutDate: true,
            adults: true,
            children: true,
            confirmedRate: true,
            createdAt: true,
            guest: { select: { name: true, email: true, phone: true } },
            roomType: { select: { name: true } },
            room: { select: { number: true } },
            corporateAccount: { select: { name: true } },
            groupBlock: { select: { name: true } },
          },
          take,
        });
        return rows.map((r) => ({
          confirmationNumber: r.confirmationNumber,
          status: r.status,
          channel: r.channel,
          guestName: r.guest.name,
          guestEmail: r.guest.email,
          guestPhone: r.guest.phone,
          roomType: r.roomType.name,
          room: r.room?.number ?? null,
          company: r.corporateAccount?.name ?? null,
          group: r.groupBlock?.name ?? null,
          checkInDate: iso(r.checkInDate),
          checkOutDate: iso(r.checkOutDate),
          nights: Math.round((r.checkOutDate.getTime() - r.checkInDate.getTime()) / 86_400_000),
          adults: r.adults,
          children: r.children,
          roomTotal: money(r.confirmedRate),
          bookedOn: localDateOf(r.createdAt, timezone),
        }));
      }
      case 'charges': {
        const rows = await tx.lineItem.findMany({
          where: { folio: { branchId }, isVoid: false, deletedAt: null, serviceDate: { gte: from, lt: to } },
          select: {
            serviceDate: true,
            chargeType: true,
            description: true,
            amount: true,
            correctsLineItem: { select: { chargeType: true } },
            outlet: { select: { name: true } },
            postedByUser: { select: { name: true } },
            folio: { select: { guest: { select: { name: true } }, reservation: { select: { confirmationNumber: true, room: { select: { number: true } } } } } },
          },
          take,
        });
        return rows.map((r) => ({
          serviceDate: iso(r.serviceDate),
          department: r.chargeType === 'correction' ? (r.correctsLineItem?.chargeType ?? 'correction') : r.chargeType,
          description: r.description,
          amount: money(r.amount),
          guestName: r.folio.guest.name,
          room: r.folio.reservation?.room?.number ?? null,
          confirmationNumber: r.folio.reservation?.confirmationNumber ?? null,
          outlet: r.outlet?.name ?? null,
          postedBy: r.postedByUser?.name ?? 'System',
        }));
      }
      case 'payments': {
        const rows = await tx.payment.findMany({
          where: { folio: { branchId }, isVoid: false, deletedAt: null, recordedAt: { gte: branchDayStart(fromStr, timezone), lt: branchDayStart(toStr, timezone) } },
          select: {
            amount: true,
            method: true,
            reference: true,
            recordedAt: true,
            recordedByUser: { select: { name: true } },
            folio: { select: { guest: { select: { name: true } }, reservation: { select: { confirmationNumber: true } } } },
          },
          take,
        });
        return rows.map((r) => ({
          date: localDateOf(r.recordedAt, timezone),
          method: r.method,
          kind: r.amount.isNegative() ? 'refund' : 'payment',
          amount: money(r.amount),
          reference: r.reference,
          guestName: r.folio.guest.name,
          confirmationNumber: r.folio.reservation?.confirmationNumber ?? null,
          recordedBy: r.recordedByUser?.name ?? null,
        }));
      }
      case 'guests': {
        // This property's guests — anyone with a booking here. It listed every
        // guest of every property in the group, with their contact details,
        // for any manager or accountant at any one of them.
        const rows = await tx.guestProfile.findMany({
          where: { deletedAt: null, createdAt: { gte: branchDayStart(fromStr, timezone), lt: branchDayStart(toStr, timezone) }, reservations: { some: { branchId } } },
          select: { name: true, email: true, phone: true, nationality: true, vipLevel: true, loyaltyTier: true, loyaltyPoints: true, createdAt: true },
          take,
        });
        return rows.map((r) => ({
          name: r.name,
          email: r.email,
          phone: r.phone,
          nationality: r.nationality,
          vipLevel: r.vipLevel ?? 0,
          loyaltyTier: r.loyaltyTier,
          loyaltyPoints: r.loyaltyPoints ?? 0,
          firstSeen: localDateOf(r.createdAt, timezone),
        }));
      }
    }
  }
}
