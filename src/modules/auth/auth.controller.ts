import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { AuthService, InviteJoined, InvitePreview, LoginResult, MfaChallenge, MfaLoginResult } from './auth.service';
import { PasswordService } from './password.service';
import { MfaService, MfaStatus } from './mfa.service';
import { MfaCodeDto, MfaDisableDto, MfaVerifyDto } from './dto/mfa.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { CreateRoleDto, UpdateRoleDto, UpdateRolePermissionsDto } from './dto/update-role-permissions.dto';
import { ChangePasswordDto, EmailOnlyDto, ResetPasswordDto } from './dto/password.dto';
import { ResendVerificationDto, VerifyEmailDto } from './dto/verify-email.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly mfaService: MfaService,
    private readonly passwordService: PasswordService,
  ) {}

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
  // As tight as register: every call can send an email.
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send the email confirmation link again — the same answer for any address' })
  resendVerification(@Body() dto: ResendVerificationDto): ReturnType<AuthService['resendVerification']> {
    return this.authService.resendVerification(dto.email, dto.password);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email a password-reset link — the same answer for any address' })
  forgotPassword(@Body() dto: EmailOnlyDto): { emailEnabled: boolean } {
    return this.passwordService.forgot(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Choose a new password with a reset link — ends every session the account had' })
  resetPassword(@Body() dto: ResetPasswordDto): Promise<{ reset: true }> {
    return this.passwordService.reset(dto.token, dto.password);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @ApiOperation({ summary: 'Change my own password — ends my other sessions and returns a fresh one for this browser' })
  changePassword(@CurrentUser() user: JwtPayload, @Body() dto: ChangePasswordDto): Promise<LoginResult> {
    return this.passwordService.changePassword(user, dto.currentPassword, dto.newPassword);
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
  login(@Body() dto: LoginDto): Promise<LoginResult | MfaChallenge> {
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
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End the session behind a refresh token — signing out on the server, not just in the browser' })
  logout(@Body() dto: RefreshTokenDto): Promise<void> {
    return this.authService.logout(dto.refreshToken);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('invites/:token')
  @ApiOperation({ summary: 'What an invitation is for — who, where and as what — before accepting it' })
  previewInvite(@Param('token') token: string): Promise<InvitePreview> {
    return this.authService.previewInvite(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept-invite/:token')
  @ApiOperation({ summary: 'Accept a staff invite — someone new gets an account and is signed in; someone with an account here gives its password and then signs in as usual' })
  acceptInvite(
    @Param('token') token: string,
    @Body() dto: AcceptInviteDto,
  ): Promise<LoginResult | InviteJoined> {
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

  // --- Two-step sign-in (MFA) ------------------------------------------------

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  // Per IP, on top of the per-account lock after five wrong codes.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Second step of a sign-in: the ticket from /auth/login plus an authenticator or recovery code' })
  verifyMfa(@Body() dto: MfaVerifyDto): Promise<MfaLoginResult> {
    return this.authService.verifyMfaLogin(dto.challengeToken, dto.code);
  }

  @Get('mfa')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Whether my own two-step sign-in is on, and how many recovery codes are left' })
  mfaStatus(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload): Promise<MfaStatus> {
    return this.mfaService.status(tenantId, user.sub);
  }

  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start setting up two-step sign-in: a new secret and the link an authenticator app scans' })
  beginMfaSetup(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload): ReturnType<MfaService['beginSetup']> {
    return this.mfaService.beginSetup(tenantId, user.sub);
  }

  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Finish setup with the first code the app shows — returns recovery codes, shown only this once' })
  enableMfa(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: MfaCodeDto): ReturnType<MfaService['enable']> {
    return this.mfaService.enable(tenantId, user.sub, dto.code);
  }

  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Turn my two-step sign-in off — needs the password and a current code' })
  disableMfa(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: MfaDisableDto): Promise<MfaStatus> {
    return this.mfaService.disable(tenantId, user.sub, dto.password, dto.code);
  }

  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Replace all my recovery codes with new ones — needs a current code' })
  regenerateRecoveryCodes(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: MfaCodeDto): ReturnType<MfaService['regenerateRecoveryCodes']> {
    return this.mfaService.regenerateRecoveryCodes(tenantId, user.sub, dto.code);
  }

  @Post('mfa/reset/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Roles(SystemRole.Owner)
  @ApiOperation({ summary: 'Switch a colleague’s two-step sign-in off when their phone and recovery codes are lost (owner only, never your own)' })
  resetMfa(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('userId', ParseUUIDPipe) userId: string): Promise<{ reset: true }> {
    return this.mfaService.resetForUser(tenantId, user, userId);
  }

  @Get('permissions/catalogue')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'What a custom role can be given: the modules, the actions, what each built-in role really covers, and what can’t be delegated' })
  permissionCatalogue(): ReturnType<AuthService['permissionCatalogue']> {
    return this.authService.permissionCatalogue();
  }

  @Post('roles')
  @ApiBearerAuth()
  @Roles(SystemRole.Owner)
  @ApiOperation({ summary: 'Create a custom role beyond the six built-in ones (owner only)' })
  createRole(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: CreateRoleDto): Promise<Role> {
    return this.authService.createRole(tenantId, dto.name, dto.permissions ?? {}, user.sub);
  }

  @Patch('roles/:roleId')
  @ApiBearerAuth()
  @Roles(SystemRole.Owner)
  @ApiOperation({ summary: 'Rename or re-scope a custom role (owner only)' })
  updateRole(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<Role> {
    return this.authService.updateRole(tenantId, roleId, dto, user.sub);
  }

  @Delete('roles/:roleId')
  @ApiBearerAuth()
  @Roles(SystemRole.Owner)
  @ApiOperation({ summary: 'Delete a custom role nobody holds (owner only)' })
  deleteRole(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('roleId', ParseUUIDPipe) roleId: string): Promise<{ deleted: true }> {
    return this.authService.deleteRole(tenantId, roleId, user.sub);
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
