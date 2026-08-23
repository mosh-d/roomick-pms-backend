import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { Prisma, Role, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { demoExpiryFromNow } from '../tenants/tenants.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

export const BCRYPT_COST = 12; // spec §3.1: cost ≥ 12
export const SYSTEM_ROLE_NAMES = [
  'owner',
  'manager',
  'front_desk',
  'housekeeper',
  'accountant',
  'pos_staff',
] as const;

// Compared against when the user doesn't exist, so login latency doesn't
// reveal which emails are registered.
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpDLhAuxrTNqtC1sTEIOhKkBUeRlq';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  roles: Array<{ branchId: string | null; role: string }>;
}

export interface LoginResult extends TokenPair {
  user: AuthenticatedUser;
}

interface RefreshTokenPayload {
  sub: string;
  tenantId: string;
  tokenType: 'refresh';
}

interface EmailVerifyPayload {
  sub: string;
  tenantId: string;
  tokenType: 'email_verify';
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // Signup (step 1) — creates tenant + owner + seeded system roles
  // -------------------------------------------------------------------------
  async register(dto: RegisterDto): Promise<{
    tenantId: string;
    userId: string;
    subdomain: string;
    verificationToken: string;
  }> {
    const existing = await this.prisma.tenant.findUnique({ where: { subdomain: dto.subdomain } });
    if (existing) {
      throw new ConflictException({
        code: ErrorCode.SUBDOMAIN_TAKEN,
        message: 'This subdomain is already in use',
      });
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    // brandMode is finalised by POST /tenants/configure-mode (signup step 2);
    // 'single' is the placeholder until then — immutability is enforced there.
    const tenant = await this.prisma.tenant.create({
      data: {
        subdomain: dto.subdomain,
        groupName: dto.groupName,
        brandMode: 'single',
        status: 'trial',
        country: dto.country,
        isDemo: dto.isDemo ?? false,
        demoExpiresAt: dto.isDemo ? demoExpiryFromNow() : null,
      },
    });

    const owner = await this.prisma.withTenant(tenant.id, async (tx) => {
      // Seed system roles per tenant on signup (DB doc: seeded per tenant, not via migration).
      await tx.role.createMany({
        data: SYSTEM_ROLE_NAMES.map((name) => ({ tenantId: tenant.id, name, isSystem: true })),
      });
      const ownerRole = await tx.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenant.id, name: 'owner' } },
      });

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: dto.email,
          passwordHash,
          name: dto.name,
          phone: dto.phone,
        },
      });

      // branchId NULL = owner everywhere
      await tx.userBranchRole.create({
        data: { tenantId: tenant.id, userId: user.id, roleId: ownerRole.id, branchId: null },
      });

      await this.audit(tx, tenant.id, user.id, 'auth.register', 'tenant', tenant.id, {
        subdomain: dto.subdomain,
      });
      return user;
    });

    // Email dispatch is a stubbed adapter in MVP — the token is returned/logged
    // so the flow is testable end-to-end. Wire a real sender in P5 comms work.
    const verificationToken = await this.jwt.signAsync(
      { sub: owner.id, tenantId: tenant.id, tokenType: 'email_verify' } satisfies EmailVerifyPayload,
      { secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: '72h' },
    );
    this.logger.log(`[stub email] verification token for ${dto.email} issued`);

    return { tenantId: tenant.id, userId: owner.id, subdomain: tenant.subdomain, verificationToken };
  }

  async verifyEmail(token: string): Promise<{ verified: true }> {
    let payload: EmailVerifyPayload;
    try {
      payload = await this.jwt.verifyAsync<EmailVerifyPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new BadRequestException({
        code: ErrorCode.TOKEN_INVALID,
        message: 'Verification token is invalid or expired',
      });
    }
    if (payload.tokenType !== 'email_verify') {
      throw new BadRequestException({
        code: ErrorCode.TOKEN_INVALID,
        message: 'Verification token is invalid or expired',
      });
    }

    await this.prisma.withTenant(payload.tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: payload.sub, deletedAt: null } });
      if (!user) {
        throw new BadRequestException({
          code: ErrorCode.TOKEN_INVALID,
          message: 'Verification token is invalid or expired',
        });
      }
      if (!user.emailVerified) {
        await tx.user.update({ where: { id: user.id }, data: { emailVerified: true } });
        await this.audit(tx, payload.tenantId, user.id, 'auth.verify_email', 'user', user.id);
      }
    });
    return { verified: true };
  }

  // -------------------------------------------------------------------------
  // Login / refresh
  // -------------------------------------------------------------------------
  async login(dto: LoginDto, headerTenantId?: string): Promise<LoginResult> {
    const tenantId = await this.resolveTenantId(dto.subdomain, headerTenantId);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { tenantId, email: dto.email, deletedAt: null },
      });

      const passwordOk = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !passwordOk) {
        throw new UnauthorizedException({
          code: ErrorCode.INVALID_CREDENTIALS,
          message: 'Email or password is incorrect',
        });
      }
      if (!user.emailVerified) {
        throw new ForbiddenException({
          code: ErrorCode.EMAIL_NOT_VERIFIED,
          message: 'Verify your email before logging in',
        });
      }

      const roles = await this.loadRolesClaim(tx, user.id);
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await this.audit(tx, tenantId, user.id, 'auth.login', 'user', user.id);

      return this.buildLoginResult(user, roles);
    });
  }

  async refresh(refreshToken: string): Promise<LoginResult> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException({
        code: ErrorCode.TOKEN_INVALID,
        message: 'Refresh token is invalid or expired',
      });
    }
    if (payload.tokenType !== 'refresh') {
      throw new UnauthorizedException({
        code: ErrorCode.TOKEN_INVALID,
        message: 'Refresh token is invalid or expired',
      });
    }

    return this.prisma.withTenant(payload.tenantId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: payload.sub, deletedAt: null, emailVerified: true },
      });
      if (!user) {
        throw new UnauthorizedException({
          code: ErrorCode.TOKEN_INVALID,
          message: 'Refresh token is invalid or expired',
        });
      }
      const roles = await this.loadRolesClaim(tx, user.id);
      return this.buildLoginResult(user, roles);
    });
  }

  // -------------------------------------------------------------------------
  // Invites
  // -------------------------------------------------------------------------
  /**
   * Public invite tokens are `<tenantId>.<secret>` — the tenant prefix lets a
   * pre-auth request establish RLS context; the secret half is what's stored
   * in invite_tokens and does the actual authentication.
   */
  async acceptInvite(publicToken: string, dto: AcceptInviteDto): Promise<LoginResult> {
    const { tenantId, secret } = this.parseInviteToken(publicToken);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const invite = await tx.inviteToken.findUnique({ where: { token: secret } });
      if (!invite || invite.acceptedAt !== null || invite.expiresAt < new Date()) {
        throw new BadRequestException({
          code: ErrorCode.INVITE_INVALID,
          message: 'Invite is invalid, expired or already used',
        });
      }

      let user = await tx.user.findFirst({
        where: { tenantId, email: invite.email, deletedAt: null },
      });
      if (!user) {
        const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
        user = await tx.user.create({
          data: {
            tenantId,
            email: invite.email,
            passwordHash,
            name: dto.name,
            phone: dto.phone,
            emailVerified: true, // receiving the invite email proves ownership
          },
        });
      }

      // Idempotent role attach (re-inviting existing staff to a new branch is legal).
      const existingAssignment = await tx.userBranchRole.findFirst({
        where: { userId: user.id, roleId: invite.roleId, branchId: invite.branchId },
      });
      if (!existingAssignment) {
        await tx.userBranchRole.create({
          data: {
            tenantId,
            userId: user.id,
            roleId: invite.roleId,
            branchId: invite.branchId,
          },
        });
      }

      await tx.inviteToken.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      await this.audit(tx, tenantId, user.id, 'auth.accept_invite', 'user', user.id, {
        inviteId: invite.id,
        branchId: invite.branchId,
      });

      const roles = await this.loadRolesClaim(tx, user.id);
      return this.buildLoginResult(user, roles);
    });
  }

  /** Generates the stored secret + public token for an invite row. */
  createInviteSecret(tenantId: string): { secret: string; publicToken: string } {
    const secret = randomBytes(48).toString('hex');
    return { secret, publicToken: `${tenantId}.${secret}` };
  }

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------
  async listRoles(tenantId: string): Promise<Role[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.role.findMany({ orderBy: { name: 'asc' } }),
    );
  }

  async updateRolePermissions(
    tenantId: string,
    roleId: string,
    permissions: Record<string, string[]>,
    actorUserId: string,
  ): Promise<Role> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const role = await tx.role.findFirst({ where: { id: roleId } });
      if (!role) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Role not found' });
      }
      const updated = await tx.role.update({
        where: { id: roleId },
        data: { permissions },
      });
      await this.audit(tx, tenantId, actorUserId, 'role.permissions_updated', 'role', roleId, {
        before: role.permissions,
        after: permissions,
      });
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------
  private async resolveTenantId(subdomain?: string, headerTenantId?: string): Promise<string> {
    if (subdomain) {
      const tenant = await this.prisma.tenant.findUnique({ where: { subdomain } });
      if (!tenant) {
        throw new UnauthorizedException({
          code: ErrorCode.INVALID_CREDENTIALS,
          message: 'Email or password is incorrect',
        });
      }
      return tenant.id;
    }
    if (headerTenantId) return headerTenantId;
    throw new BadRequestException({
      code: ErrorCode.TENANT_HEADER_MISSING,
      message: 'Provide a subdomain or an X-Tenant-ID header',
    });
  }

  private async loadRolesClaim(
    tx: TenantTx,
    userId: string,
  ): Promise<Array<{ branchId: string | null; role: string }>> {
    const assignments = await tx.userBranchRole.findMany({
      where: { userId },
      include: { role: { select: { name: true } } },
    });
    return assignments.map((a) => ({ branchId: a.branchId, role: a.role.name }));
  }

  private async buildLoginResult(
    user: User,
    roles: Array<{ branchId: string | null; role: string }>,
  ): Promise<LoginResult> {
    const accessPayload: JwtPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      email: user.email,
      roles,
      tokenType: 'access',
    };
    const accessTtl = (this.config.get<string>('JWT_ACCESS_TTL') ??
      '900s') as JwtSignOptions['expiresIn'];
    const refreshTtl = (this.config.get<string>('JWT_REFRESH_TTL') ??
      '30d') as JwtSignOptions['expiresIn'];
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessTtl,
      }),
      this.jwt.signAsync(
        { sub: user.id, tenantId: user.tenantId, tokenType: 'refresh' } satisfies RefreshTokenPayload,
        {
          secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
          expiresIn: refreshTtl,
        },
      ),
    ]);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        name: user.name,
        roles,
      },
    };
  }

  private parseInviteToken(publicToken: string): { tenantId: string; secret: string } {
    const dot = publicToken.indexOf('.');
    const tenantId = dot > 0 ? publicToken.slice(0, dot) : '';
    const secret = dot > 0 ? publicToken.slice(dot + 1) : '';
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(tenantId) || secret.length < 32) {
      throw new BadRequestException({
        code: ErrorCode.INVITE_INVALID,
        message: 'Invite is invalid, expired or already used',
      });
    }
    return { tenantId, secret };
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    userId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    after?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: { tenantId, userId, action, entityType, entityId, after },
    });
  }
}
