import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Branch, UserOutlet } from '@prisma/client';
import { AccountStatusService } from '../../common/auth/account-status.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { AccountMailService } from '../../common/mail/account-mail.service';
import { JwtPayload } from '../../common/types/request-context';
import {
  HeldRole,
  assertMayGrant,
  assertMayManageAccount,
  isOwner,
  managesBranch,
  whyCannotChangeRoleAt,
  whyCannotGrant,
  whyCannotManageAccount,
} from '../../common/utils/staff-authority';
import { webUrl } from '../../common/utils/web-url';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { BulkInviteDto } from './dto/bulk-invite.dto';
import { PatchStaffDto } from './dto/patch-staff.dto';
import { SetUserOutletsDto } from './dto/set-user-outlets.dto';

const INVITE_TTL_HOURS = 72; // DB doc: expiresAt = NOW() + 72 hours

/** Invitation emails go out a few at a time — fifty one after another would keep the page waiting. */
const SEND_IN_PARALLEL = 5;

export interface StaffListEntry {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  emailVerified: boolean;
  lastLoginAt: Date | null;
  active: boolean;
  /** Two-step sign-in is on for this person — an owner can reset it from Staff. */
  mfaEnabled: boolean;
  roles: Array<{ branchId: string | null; role: string; roleId: string }>;
  outletIds: string[];
  /** Whether the person asking may change this person's role at this branch. */
  canChangeRole: boolean;
  /** Whether they may deactivate, reactivate or make a password-reset link for this person's account. */
  canManageAccount: boolean;
}

export interface InviteResult {
  email: string;
  inviteId: string;
  /** `<tenantId>.<secret>` — what the link carries. */
  publicToken: string;
  /** The page that accepts it — emailed when email is set up, and always shown to hand over. */
  link: string;
  /** The invitation reached the person's inbox. */
  emailed: boolean;
  expiresAt: Date;
}

export interface PendingInvite {
  id: string;
  email: string;
  roleId: string;
  role: string;
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  expired: boolean;
  /** Only for invitations the person asking could have made themselves — a manager never sees the link to a manager's invitation. */
  link: string | null;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly accountMail: AccountMailService,
    private readonly accountStatus: AccountStatusService,
  ) {}

  /**
   * Staff visible at a branch = branch-scoped assignments + all-branch (NULL)
   * assignments. With `actor`, each entry also says what that person may
   * change; without (another module reusing the list), nothing is changeable.
   * A branch that isn't there is a 404 — not the all-branch staff under any id.
   */
  async listStaff(tenantId: string, branchId: string, actor: JwtPayload | null = null): Promise<StaffListEntry[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranch(tx, branchId);
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
              mfaEnabledAt: true,
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

      // What each person holds everywhere, not just here — whether their
      // account is this manager's to manage depends on all of it.
      const heldByUser = actor ? await this.heldRoles(tx, [...new Set(assignments.map((a) => a.user.id))]) : new Map<string, HeldRole[]>();

      const byUser = new Map<string, StaffListEntry>();
      for (const a of assignments) {
        const held = heldByUser.get(a.user.id) ?? [];
        const entry = byUser.get(a.user.id) ?? {
          id: a.user.id,
          email: a.user.email,
          name: a.user.name,
          phone: a.user.phone,
          emailVerified: a.user.emailVerified,
          lastLoginAt: a.user.lastLoginAt,
          active: a.user.deletedAt === null,
          mfaEnabled: a.user.mfaEnabledAt !== null,
          roles: [],
          outletIds: outletsByUser.get(a.user.id) ?? [],
          canChangeRole: actor !== null && whyCannotChangeRoleAt(actor, a.user.id, held, branchId) === null,
          canManageAccount: actor !== null && whyCannotManageAccount(actor, a.user.id, held) === null,
        };
        entry.roles.push({ branchId: a.branchId, role: a.role.name, roleId: a.role.id });
        byUser.set(a.user.id, entry);
      }
      return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /**
   * One invite_tokens row per email (spec §3.1). Re-inviting replaces the
   * pending row — which is also how an invitation is sent again. A manager
   * invites to the branches they manage and never as manager or owner.
   * The emails go after the rows are committed; each result says whether
   * its email went, and carries the link to hand over either way.
   */
  async bulkInvite(actor: JwtPayload, branchId: string, dto: BulkInviteDto): Promise<InviteResult[]> {
    const tenantId = actor.tenantId;
    const created = await this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.assertBranch(tx, branchId);

      const roleIds = [...new Set(dto.invites.map((i) => i.roleId))];
      const roles = await tx.role.findMany({ where: { id: { in: roleIds } } });
      if (roles.length !== roleIds.length) {
        throw new BadRequestException({
          code: ErrorCode.NOT_FOUND,
          message: 'One or more roleIds do not exist',
        });
      }
      for (const role of roles) assertMayGrant(actor, role.name, branchId);
      const roleName = new Map(roles.map((r) => [r.id, r.name]));

      // Someone deactivated can't accept (their account stays off) — say so now, not at their end.
      const deactivated = await tx.user.findMany({
        where: { email: { in: dto.invites.map((i) => i.email) }, deletedAt: { not: null } },
        select: { email: true },
      });
      if (deactivated.length > 0) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: `${deactivated.map((u) => u.email).join(', ')} ${deactivated.length === 1 ? 'has a deactivated account' : 'have deactivated accounts'} here — reactivate instead of inviting`,
        });
      }

      const inviter = await tx.user.findFirst({ where: { id: actor.sub }, select: { name: true } });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { groupName: true } });

      const rows: Array<Omit<InviteResult, 'emailed'> & { role: string }> = [];
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
            invitedBy: actor.sub,
            expiresAt,
          },
        });
        rows.push({ email: row.email, inviteId: invite.id, publicToken, link: inviteLink(publicToken), expiresAt, role: roleName.get(row.roleId) ?? 'staff' });
      }

      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: actor.sub,
          action: 'staff.bulk_invite',
          entityType: 'invite_token',
          after: { emails: dto.invites.map((i) => i.email), branchId },
        },
      });
      return { rows, branch, organisation: tenant.groupName, invitedBy: inviter?.name ?? null };
    });

    const results: InviteResult[] = [];
    for (let i = 0; i < created.rows.length; i += SEND_IN_PARALLEL) {
      const batch = created.rows.slice(i, i + SEND_IN_PARALLEL);
      const sent = await Promise.all(
        batch.map((row) =>
          this.accountMail.staffInvite(row.email, {
            organisation: created.organisation,
            branch: created.branch.name,
            role: row.role.replace(/_/g, ' '),
            invitedBy: created.invitedBy,
            link: row.link,
            expiresAt: row.expiresAt,
          }),
        ),
      );
      batch.forEach(({ role: _role, ...row }, k) => results.push({ ...row, emailed: sent[k] }));
    }
    return results;
  }

  /** Invitations at a branch nobody has accepted yet, newest first — expired ones too, so they can be sent again. */
  async listInvites(actor: JwtPayload, branchId: string): Promise<PendingInvite[]> {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const invites = await tx.inviteToken.findMany({
        where: { branchId, acceptedAt: null },
        include: { role: { select: { name: true } }, invitedByUser: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const now = Date.now();
      return invites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        roleId: invite.roleId,
        role: invite.role.name,
        invitedBy: invite.invitedByUser?.name ?? null,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        expired: invite.expiresAt.getTime() <= now,
        link: whyCannotGrant(actor, invite.role.name, invite.branchId) === null ? inviteLink(`${actor.tenantId}.${invite.token}`) : null,
      }));
    });
  }

  /** Withdraws an invitation nobody has accepted: its link stops working. Only someone who could have made it. */
  async cancelInvite(actor: JwtPayload, inviteId: string): Promise<{ cancelled: true }> {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const invite = await tx.inviteToken.findFirst({ where: { id: inviteId, acceptedAt: null }, include: { role: { select: { name: true } } } });
      if (!invite) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'That invitation was already accepted or withdrawn' });
      assertMayGrant(actor, invite.role.name, invite.branchId);
      await tx.inviteToken.delete({ where: { id: invite.id } });
      await tx.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          branchId: invite.branchId,
          userId: actor.sub,
          action: 'staff.invite_cancelled',
          entityType: 'invite_token',
          entityId: invite.id,
          before: { email: invite.email, role: invite.role.name },
        },
      });
      return { cancelled: true as const };
    });
  }

  async patchStaff(actor: JwtPayload, userId: string, dto: PatchStaffDto): Promise<StaffListEntry> {
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
    const tenantId = actor.tenantId;

    return this.prisma.withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'User not found' });
      }
      const held = (await this.heldRoles(tx, [userId])).get(userId) ?? [];
      // Every rule is checked before anything is written.
      if (dto.active !== undefined) assertMayManageAccount(actor, userId, held);
      let roleName: string | null = null;
      if (dto.roleId !== undefined) {
        const role = await tx.role.findFirst({ where: { id: dto.roleId } });
        if (!role) {
          throw new BadRequestException({ code: ErrorCode.NOT_FOUND, message: 'Role not found' });
        }
        const reason = whyCannotChangeRoleAt(actor, userId, held, dto.branchId ?? null);
        if (reason) throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: reason });
        assertMayGrant(actor, role.name, dto.branchId ?? null);
        if (dto.branchId) await this.assertBranch(tx, dto.branchId);
        roleName = role.name;
      }
      if (dto.outletIds !== undefined && dto.branchId) this.assertMayAssignOutlets(actor, userId, held, dto.branchId);

      if (dto.active !== undefined) {
        await tx.user.update({
          where: { id: userId },
          data: { deletedAt: dto.active ? null : (user.deletedAt ?? new Date()) },
        });
        // Deactivated means signed out too — not whenever their session next
        // renews, and not when their current access token runs out either.
        if (!dto.active) {
          await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
          this.accountStatus.forget(userId);
        }
      }

      if (dto.roleId !== undefined) {
        // Counted from their next request, not when their token is next renewed.
        this.accountStatus.forget(userId);
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
            assignedBy: actor.sub,
          },
        });
      }

      if (dto.outletIds !== undefined && dto.branchId) {
        await this.replaceOutlets(tx, tenantId, userId, dto.branchId, dto.outletIds, actor.sub);
      }

      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: dto.branchId,
          userId: actor.sub,
          action: 'staff.updated',
          entityType: 'user',
          entityId: userId,
          after: { roleId: dto.roleId, role: roleName ?? undefined, outletIds: dto.outletIds, active: dto.active },
        },
      });

      return this.staffEntry(tx, actor, userId, dto.branchId ?? null);
    });
  }

  /** Someone's outlets at the branches the asker manages — a manager at one property used to see another's assignments too. */
  async getUserOutlets(actor: JwtPayload, userId: string): Promise<UserOutlet[]> {
    const rows = await this.prisma.withTenant(actor.tenantId, (tx) => tx.userOutlet.findMany({ where: { userId }, include: { outlet: true } }));
    return rows.filter((row) => managesBranch(actor, row.outlet.branchId));
  }

  async setUserOutlets(actor: JwtPayload, userId: string, dto: SetUserOutletsDto): Promise<UserOutlet[]> {
    const tenantId = actor.tenantId;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null } });
      if (!user) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'User not found' });
      }
      const held = (await this.heldRoles(tx, [userId])).get(userId) ?? [];
      this.assertMayAssignOutlets(actor, userId, held, dto.branchId);
      await this.replaceOutlets(tx, tenantId, userId, dto.branchId, dto.outletIds, actor.sub);
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: dto.branchId,
          userId: actor.sub,
          action: 'staff.outlets_set',
          entityType: 'user',
          entityId: userId,
          after: { outletIds: dto.outletIds },
        },
      });
      // What the asker may see, as on the read: not this person's outlets at other properties.
      const rows = await tx.userOutlet.findMany({ where: { userId }, include: { outlet: true } });
      return rows.filter((row) => managesBranch(actor, row.outlet.branchId));
    });
  }

  // ---------------------------------------------------------------------------

  /** Outlets at a branch the actor runs — their own included; someone else's only if their account is below the actor's. */
  private assertMayAssignOutlets(actor: JwtPayload, userId: string, held: readonly HeldRole[], branchId: string): void {
    if (!managesBranch(actor, branchId)) {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'You can only manage staff at a branch you manage' });
    }
    if (userId !== actor.sub && !isOwner(actor) && held.some((r) => r.role === 'owner' || r.role === 'manager')) {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Only the owner can change a manager’s account' });
    }
  }

  /** Every role each of these people holds, at every branch. */
  private async heldRoles(tx: TenantTx, userIds: string[]): Promise<Map<string, HeldRole[]>> {
    const rows = userIds.length === 0 ? [] : await tx.userBranchRole.findMany({ where: { userId: { in: userIds } }, include: { role: { select: { name: true } } } });
    const byUser = new Map<string, HeldRole[]>();
    for (const row of rows) {
      const list = byUser.get(row.userId) ?? [];
      list.push({ branchId: row.branchId, role: row.role.name });
      byUser.set(row.userId, list);
    }
    return byUser;
  }

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

  private async staffEntry(tx: TenantTx, actor: JwtPayload, userId: string, branchId: string | null): Promise<StaffListEntry> {
    const user = await tx.user.findFirstOrThrow({ where: { id: userId } });
    const assignments = await tx.userBranchRole.findMany({
      where: { userId },
      include: { role: { select: { id: true, name: true } } },
    });
    const outlets = await tx.userOutlet.findMany({
      where: { userId, ...(branchId ? { branchId } : {}) },
      select: { outletId: true },
    });
    const held = assignments.map((a) => ({ branchId: a.branchId, role: a.role.name }));
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      emailVerified: user.emailVerified,
      lastLoginAt: user.lastLoginAt,
      active: user.deletedAt === null,
      mfaEnabled: user.mfaEnabledAt !== null,
      roles: assignments.map((a) => ({ branchId: a.branchId, role: a.role.name, roleId: a.role.id })),
      outletIds: outlets.map((o) => o.outletId),
      canChangeRole: whyCannotChangeRoleAt(actor, userId, held, branchId) === null,
      canManageAccount: whyCannotManageAccount(actor, userId, held) === null,
    };
  }

  private async assertBranch(tx: TenantTx, branchId: string): Promise<Branch> {
    const branch = await tx.branch.findFirst({ where: { id: branchId, deletedAt: null } });
    if (!branch) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Branch not found' });
    }
    return branch;
  }
}

function inviteLink(publicToken: string): string {
  return webUrl(`/accept-invite?token=${encodeURIComponent(publicToken)}`);
}
