import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

export interface AuditLogRow {
  id: string;
  tenantId: string;
  branchId: string | null;
  userId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  ipAddress: string | null;
  timestamp: Date;
  user: { id: string; name: string; email: string } | null;
}

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `AuditLog.id` is a BigInt (autoincrement) — stringified the same way
   * `RateResolverService.getAuditTrail` already does, since Nest's default
   * JSON serializer throws on a raw BigInt. `to` is treated as inclusive of
   * the whole calendar day, matching how a person picking an end date in a
   * date-range filter expects it to behave.
   */
  async listAuditLogs(tenantId: string, query: ListAuditLogsQueryDto): Promise<{ rows: AuditLogRow[]; total: number; page: number; limit: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.AuditLogWhereInput = {
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.action ? { action: { contains: query.action, mode: 'insensitive' } } : {}),
        ...(query.from || query.to
          ? {
              timestamp: {
                ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
                ...(query.to ? { lt: new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000) } : {}),
              },
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        tx.auditLog.findMany({
          where,
          orderBy: { timestamp: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          include: { user: { select: { id: true, name: true, email: true } } },
        }),
        tx.auditLog.count({ where }),
      ]);

      return { rows: rows.map((r) => ({ ...r, id: r.id.toString() })), total, page, limit };
    });
  }
}
