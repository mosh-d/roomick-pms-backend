import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @Post('register')
  @ApiOperation({ summary: 'Tenant signup step 1 — creates tenant, owner account, system roles' })
  register(@Body() dto: RegisterDto): ReturnType<AuthService['register']> {
    return this.authService.register(dto);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm owner/staff email with the token from the signup email' })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ verified: true }> {
    return this.authService.verifyEmail(dto.token);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email + password (+ subdomain or X-Tenant-ID header)' })
  login(
    @Body() dto: LoginDto,
    // Public route — TenantGuard is skipped, so read the raw header as the
    // subdomain-less fallback for resolving the tenant.
    @Headers('x-tenant-id') headerTenantId?: string,
  ): Promise<LoginResult> {
    return this.authService.login(dto, headerTenantId);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a fresh token pair' })
  refresh(@Body() dto: RefreshTokenDto): Promise<LoginResult> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @Post('accept-invite/:token')
  @ApiOperation({ summary: 'Accept a staff invite — creates the account and logs in' })
  acceptInvite(
    @Param('token') token: string,
    @Body() dto: AcceptInviteDto,
  ): Promise<LoginResult> {
    return this.authService.acceptInvite(token, dto);
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
