import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { CurrentTenant, CurrentUser, Public } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { AuthService, LoginResult } from './auth.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateRolePermissionsDto } from './dto/update-role-permissions.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  // Strictest limit in this controller: register() isn't a plain INSERT —
  // it provisions a tenant + owner + 6 seeded system roles in one
  // transaction (see AuthService.register), so unlimited unauthenticated
  // calls here are both a spam vector and a real resource-exhaustion risk.
  // 5 per 15 minutes per IP is generous for a genuine signup (nobody
  // registers 6 tenants in 15 minutes from one machine) and cheap for an
  // attacker to not bother with.
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Tenant signup step 1 — creates tenant, owner account, system roles' })
  register(@Body() dto: RegisterDto): ReturnType<AuthService['register']> {
    return this.authService.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm owner/staff email with the token from the signup email' })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ verified: true }> {
    return this.authService.verifyEmail(dto.token);
  }

  @Public()
  // Standard anti-brute-force/credential-stuffing limit. Loose enough that
  // a shared office/hotel-desk IP with a few staff mistyping passwords
  // won't get itself locked out, tight enough to make password guessing
  // impractical. AuthService.login's DUMMY_HASH already makes timing
  // attacks against this endpoint uninformative; this closes the other
  // half (raw guess-rate).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email + password' })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.authService.login(dto);
  }

  @Public()
  // Looser than login: reaching this route at all requires already
  // possessing a valid (signed, unexpired) refresh token, which is a much
  // higher bar than "knows an email address."
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a fresh token pair' })
  refresh(@Body() dto: RefreshTokenDto): Promise<LoginResult> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept-invite/:token')
  @ApiOperation({ summary: 'Accept a staff invite — creates the account and logs in' })
  acceptInvite(
    @Param('token') token: string,
    @Body() dto: AcceptInviteDto,
  ): Promise<LoginResult> {
    return this.authService.acceptInvite(token, dto);
  }

  @Get('me/branches')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "List display names for the caller's own branch-scoped roles — powers the post-login branch/property picker",
  })
  listMyBranches(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
  ): ReturnType<AuthService['listMyBranches']> {
    return this.authService.listMyBranches(tenantId, user.roles);
  }

  @Get('roles')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List roles for the current tenant' })
  listRoles(
    @CurrentTenant() tenantId: string,
    @Query('tenantId') queryTenantId?: string,
  ): Promise<Role[]> {
    // The spec's ?tenantId= is redundant with the header — but if supplied it
    // must not point at someone else's tenant.
    if (queryTenantId && queryTenantId !== tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_MISMATCH,
        message: 'Tenant context does not match credentials',
      });
    }
    return this.authService.listRoles(tenantId);
  }

  @Put('roles/:roleId/permissions')
  @ApiBearerAuth()
  @Roles(SystemRole.Owner)
  @ApiOperation({ summary: 'Replace a role’s permission map (owner only)' })
  updateRolePermissions(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: UpdateRolePermissionsDto,
  ): Promise<Role> {
    return this.authService.updateRolePermissions(tenantId, roleId, dto.permissions, user.sub);
  }
}
