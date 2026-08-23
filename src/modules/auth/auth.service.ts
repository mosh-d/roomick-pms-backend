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
    // Email is the real, global uniqueness check now (see UserEmailIndex in
    // schema.prisma) — subdomain no longer has a user-facing collision to
    // check, it's generated below regardless of what already exists.
    const existingEmail = await this.prisma.userEmailIndex.findUnique({ where: { email: dto.email } });
    if (existingEmail) {
      throw new ConflictException({
        code: ErrorCode.EMAIL_TAKEN,
        message: 'An account with this email already exists',
      });
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const subdomain = await this.generateUniqueSubdomain(dto.groupName);

    // brandMode is finalised by POST /tenants/configure-mode (signup step 2);
    // 'single' is the placeholder until then — immutability is enforced there.
    const tenant = await this.prisma.tenant.create({
      data: {
        subdomain,
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

      // Written via `tx`, inside the same transaction as user creation, for
      // atomicity — `user_email_index` isn't RLS-scoped (no policy applies
      // to it, see its schema.prisma comment) so this is only about the
      // transaction boundary, not visibility. Doing this as a separate
      // top-level call after the transaction commits would leave a real
      // crash window: a user that exists but isn't indexed, unable to log
      // in and unable to re-register (a Postgres-level unique violation on
      // `users.email`, not the clean EMAIL_TAKEN this method's own
      // pre-check is meant to give).
      await tx.userEmailIndex.create({
        data: { email: dto.email, tenantId: tenant.id, userId: user.id },
      });

      await this.audit(tx, tenant.id, user.id, 'auth.register', 'tenant', tenant.id, {
        subdomain,
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
  /**
   * Two-step lookup, not a single query — `users` has FORCE ROW LEVEL
   * SECURITY, and a query with no `app.tenant_id` set (i.e. before we know
   * which tenant to even look in) returns zero rows, always, verified
   * directly against the running app role (not assumed). `UserEmailIndex`
   * exists purely to answer "which tenant" before `withTenant()` is even
   * callable; it holds nothing else, so the real password/verification
   * checks still happen against the RLS-protected `users` row exactly as
   * before.
   */
  async login(dto: LoginDto): Promise<LoginResult> {
    const indexRow = await this.prisma.userEmailIndex.findUnique({ where: { email: dto.email } });
    if (!indexRow) {
      // Still runs bcrypt against DUMMY_HASH even on a known miss — login
      // latency must not reveal whether an email is registered (this was
      // already the point of DUMMY_HASH before; an index-table lookup miss
      // is just as observable a timing signal as a `users` miss was).
      await bcrypt.compare(dto.password, DUMMY_HASH);
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Email or password is incorrect',
      });
    }

    return this.prisma.withTenant(indexRow.tenantId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { tenantId: indexRow.tenantId, email: dto.email, deletedAt: null },
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
      await this.audit(tx, indexRow.tenantId, user.id, 'auth.login', 'user', user.id);

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

  /**
   * Resolves display names for the caller's own branch-scoped roles —
   * powers the post-login branch/property picker. Not a general
   * `GET /branches` list (deliberately deferred elsewhere in this
   * codebase): it only ever returns names for branch IDs the caller's own
   * JWT already grants a role on, matching the purpose-built-endpoint
   * precedent `GET /tenants/me/onboarding-status` already set. `roles`
   * comes straight from the JWT payload, not re-queried — it's already
   * the authoritative list of what this token can see.
   */
  async listMyBranches(
    tenantId: string,
    roles: Array<{ branchId: string | null; role: string }>,
  ): Promise<Array<{ id: string; name: string }>> {
    const branchIds = [...new Set(roles.map((r) => r.branchId).filter((id): id is string => id !== null))];
    if (branchIds.length === 0) return [];
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.branch.findMany({
        where: { id: { in: branchIds }, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    );
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
        // Email is global now (see UserEmailIndex) — a real behavior
        // change, not incidental: before this, the same address could be
        // staff at multiple independent tenants; now it can't. Checked
        // here, not left to the DB's unique constraint, so this comes back
        // as a clean EMAIL_TAKEN instead of a raw 500.
        const existingElsewhere = await tx.userEmailIndex.findUnique({ where: { email: invite.email } });
        if (existingElsewhere && existingElsewhere.tenantId !== tenantId) {
          throw new ConflictException({
            code: ErrorCode.EMAIL_TAKEN,
            message: 'This email already belongs to an account in a different organization',
          });
        }

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
        await tx.userEmailIndex.create({
          data: { email: invite.email, tenantId, userId: user.id },
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
  private slugify(input: string): string {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * `Tenant.subdomain` is still `@unique` at the DB level, but it's no
   * longer user-typed (see RegisterDto's own comment) — this generates one
   * from `groupName` and silently retries on collision, so a duplicate
   * slug can never surface as an error a real user would ever see.
   */
  private async generateUniqueSubdomain(groupName: string): Promise<string> {
    const base = this.slugify(groupName).slice(0, 50) || 'tenant';
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      const existing = await this.prisma.tenant.findUnique({ where: { subdomain: candidate } });
      if (!existing) return candidate;
    }
    return `${base}-${randomBytes(6).toString('hex')}`; // astronomically unlikely fallback
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
