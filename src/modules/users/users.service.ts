import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { UserOutlet } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { BulkInviteDto } from './dto/bulk-invite.dto';
import { PatchStaffDto } from './dto/patch-staff.dto';
import { SetUserOutletsDto } from './dto/set-user-outlets.dto';

const INVITE_TTL_HOURS = 72; // DB doc: expiresAt = NOW() + 72 hours

export interface StaffListEntry {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  emailVerified: boolean;
  lastLoginAt: Date | null;
  active: boolean;
  roles: Array<{ branchId: string | null; role: string; roleId: string }>;
  outletIds: string[];
}

export interface InviteResult {
  email: string;
  inviteId: string;
  /** `<tenantId>.<secret>` — goes into the invite email link (stubbed in MVP) */
  publicToken: string;
  expiresAt: Date;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  /** Staff visible at a branch = branch-scoped assignments + all-branch (NULL) assignments. */
  async listStaff(tenantId: string, branchId: string): Promise<StaffListEntry[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const assignments = await tx.userBranchRole.findMany({
        where: { OR: [{ branchId }, { branchId: null }] },
        include: {
          role: { select: { id: true, name: true } },
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              phone: true,
              emailVerified: true,
              lastLoginAt: true,
              deletedAt: true,
            },
          },
        },
      });

      const outletRows = await tx.userOutlet.findMany({
        where: { branchId },
        select: { userId: true, outletId: true },
      });
      const outletsByUser = new Map<string, string[]>();
      for (const row of outletRows) {
        const list = outletsByUser.get(row.userId) ?? [];
        list.push(row.outletId);
        outletsByUser.set(row.userId, list);
      }

      const byUser = new Map<string, StaffListEntry>();
      for (const a of assignments) {
        const entry = byUser.get(a.user.id) ?? {
          id: a.user.id,
          email: a.user.email,
          name: a.user.name,
          phone: a.user.phone,
          emailVerified: a.user.emailVerified,
          lastLoginAt: a.user.lastLoginAt,
          active: a.user.deletedAt === null,
          roles: [],
          outletIds: outletsByUser.get(a.user.id) ?? [],
        };
        entry.roles.push({ branchId: a.branchId, role: a.role.name, roleId: a.role.id });
        byUser.set(a.user.id, entry);
      }
      return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /** One invite_tokens row per email (spec §3.1). Re-inviting replaces the pending row. */
  async bulkInvite(
    tenantId: string,
    branchId: string,
    dto: BulkInviteDto,
    actorUserId: string,
  ): Promise<InviteResult[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranch(tx, branchId);

      const roleIds = [...new Set(dto.invites.map((i) => i.roleId))];
      const roles = await tx.role.findMany({ where: { id: { in: roleIds } } });
      if (roles.length !== roleIds.length) {
        throw new BadRequestException({
          code: ErrorCode.NOT_FOUND,
          message: 'One or more roleIds do not exist',
        });
      }

      const results: InviteResult[] = [];
      for (const row of dto.invites) {
        // Single-use: hard-delete any still-pending invite for the same target
        // (hard delete on invite_tokens is explicitly allowed, spec §3.8).
        await tx.inviteToken.deleteMany({
          where: { email: row.email, roleId: row.roleId, branchId, acceptedAt: null },
        });

        const { secret, publicToken } = this.authService.createInviteSecret(tenantId);
        const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000);
        const invite = await tx.inviteToken.create({
          data: {
            tenantId,
            email: row.email,
            token: secret,
            roleId: row.roleId,
            branchId,
            invitedBy: actorUserId,
            expiresAt,
          },
        });
        results.push({ email: row.email, inviteId: invite.id, publicToken, expiresAt });
      }

      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: actorUserId,
          action: 'staff.bulk_invite',
          entityType: 'invite_token',
          after: { emails: dto.invites.map((i) => i.email), branchId },
        },
      });
      return results;
    });
  }

  async patchStaff(
    tenantId: string,
    userId: string,
    dto: PatchStaffDto,
    actorUserId: string,
  ): Promise<StaffListEntry> {
    if (dto.roleId === undefined && dto.outletIds === undefined && dto.active === undefined) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Provide at least one of roleId, outletIds, active',
      });
    }
    if (dto.outletIds !== undefined && !dto.branchId) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'outletIds requires branchId to scope the assignments',
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'User not found' });
      }

      if (dto.active !== undefined) {
        await tx.user.update({
          where: { id: userId },
          data: { deletedAt: dto.active ? null : (user.deletedAt ?? new Date()) },
        });
      }

      if (dto.roleId !== undefined) {
        const role = await tx.role.findFirst({ where: { id: dto.roleId } });
        if (!role) {
          throw new BadRequestException({ code: ErrorCode.NOT_FOUND, message: 'Role not found' });
        }
        // Replace the user's assignment at this scope (one role per user per branch).
        await tx.userBranchRole.deleteMany({
          where: { userId, branchId: dto.branchId ?? null },
        });
        await tx.userBranchRole.create({
          data: {
            tenantId,
            userId,
            roleId: dto.roleId,
            branchId: dto.branchId ?? null,
            assignedBy: actorUserId,
          },
        });
      }

      if (dto.outletIds !== undefined && dto.branchId) {
        await this.replaceOutlets(tx, tenantId, userId, dto.branchId, dto.outletIds, actorUserId);
      }

      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: dto.branchId,
          userId: actorUserId,
          action: 'staff.updated',
          entityType: 'user',
          entityId: userId,
          after: { roleId: dto.roleId, outletIds: dto.outletIds, active: dto.active },
        },
      });

      const [entry] = await this.staffEntry(tx, userId, dto.branchId ?? null);
      return entry;
    });
  }

  async getUserOutlets(tenantId: string, userId: string): Promise<UserOutlet[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.userOutlet.findMany({ where: { userId }, include: { outlet: true } }),
    );
  }

  async setUserOutlets(
    tenantId: string,
    userId: string,
    dto: SetUserOutletsDto,
    actorUserId: string,
  ): Promise<UserOutlet[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null } });
      if (!user) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'User not found' });
      }
      await this.replaceOutlets(tx, tenantId, userId, dto.branchId, dto.outletIds, actorUserId);
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: dto.branchId,
          userId: actorUserId,
          action: 'staff.outlets_set',
          entityType: 'user',
          entityId: userId,
          after: { outletIds: dto.outletIds },
        },
      });
      return tx.userOutlet.findMany({ where: { userId }, include: { outlet: true } });
    });
  }

  // ---------------------------------------------------------------------------

  private async replaceOutlets(
    tx: TenantTx,
    tenantId: string,
    userId: string,
    branchId: string,
    outletIds: string[],
    actorUserId: string,
  ): Promise<void> {
    if (outletIds.length > 0) {
      const outlets = await tx.outlet.findMany({
        where: { id: { in: outletIds }, branchId },
      });
      if (outlets.length !== new Set(outletIds).size) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'One or more outletIds do not exist at this branch',
        });
      }
    }
    await tx.userOutlet.deleteMany({ where: { userId, branchId } });
    if (outletIds.length > 0) {
      await tx.userOutlet.createMany({
        data: outletIds.map((outletId) => ({
          tenantId,
          userId,
          outletId,
          branchId,
          assignedBy: actorUserId,
        })),
      });
    }
  }

  private async staffEntry(
    tx: TenantTx,
    userId: string,
    branchId: string | null,
  ): Promise<StaffListEntry[]> {
    const user = await tx.user.findFirstOrThrow({ where: { id: userId } });
    const assignments = await tx.userBranchRole.findMany({
      where: { userId },
      include: { role: { select: { id: true, name: true } } },
    });
    const outlets = await tx.userOutlet.findMany({
      where: { userId, ...(branchId ? { branchId } : {}) },
      select: { outletId: true },
    });
    return [
      {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        emailVerified: user.emailVerified,
        lastLoginAt: user.lastLoginAt,
        active: user.deletedAt === null,
        roles: assignments.map((a) => ({ branchId: a.branchId, role: a.role.name, roleId: a.role.id })),
        outletIds: outlets.map((o) => o.outletId),
      },
    ];
  }

  private async assertBranch(tx: TenantTx, branchId: string): Promise<void> {
    const branch = await tx.branch.findFirst({ where: { id: branchId, deletedAt: null } });
    if (!branch) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Branch not found' });
    }
  }
}
