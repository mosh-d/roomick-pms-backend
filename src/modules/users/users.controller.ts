import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { PasswordService } from '../auth/password.service';
import { BulkInviteDto } from './dto/bulk-invite.dto';
import { PatchStaffDto } from './dto/patch-staff.dto';
import { SetUserOutletsDto } from './dto/set-user-outlets.dto';
import { UsersService } from './users.service';

@ApiTags('staff')
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
  ) {}

  @Get('branches/:branchId/staff')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Staff visible at a branch (branch-scoped + all-branch roles), with what the caller may change for each' })
  listStaff(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<UsersService['listStaff']> {
    return this.usersService.listStaff(tenantId, branchId, user);
  }

  @Post('branches/:branchId/staff/invite')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({
    summary: 'Bulk staff invite — one row per email; emails each link when email is set up, and returns the links to hand over',
  })
  bulkInvite(
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: BulkInviteDto,
  ): ReturnType<UsersService['bulkInvite']> {
    return this.usersService.bulkInvite(user, branchId, dto);
  }

  @Get('branches/:branchId/staff/invites')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Invitations at a branch nobody has accepted yet' })
  listInvites(
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<UsersService['listInvites']> {
    return this.usersService.listInvites(user, branchId);
  }

  @Delete('staff-invites/:inviteId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Withdraw an invitation nobody has accepted — its link stops working' })
  cancelInvite(
    @CurrentUser() user: JwtPayload,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ): ReturnType<UsersService['cancelInvite']> {
    return this.usersService.cancelInvite(user, inviteId);
  }

  @Patch('staff/:userId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Update a staff member — role, outlets, active flag' })
  patchStaff(
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: PatchStaffDto,
  ): ReturnType<UsersService['patchStaff']> {
    return this.usersService.patchStaff(user, userId, dto);
  }

  @Post('staff/:userId/password-reset-link')
  @HttpCode(HttpStatus.OK)
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @ApiOperation({ summary: 'A one-use password-reset link for a colleague who’s locked out — emailed to them when email is set up, and returned to hand over' })
  passwordResetLink(
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): ReturnType<PasswordService['createLink']> {
    return this.passwordService.createLink(user, userId);
  }

  @Get('users/:id/outlets')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Outlet assignments for a user' })
  getUserOutlets(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) userId: string,
  ): ReturnType<UsersService['getUserOutlets']> {
    return this.usersService.getUserOutlets(tenantId, userId);
  }

  @Put('users/:id/outlets')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Replace a user’s outlet assignments at a branch' })
  setUserOutlets(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: SetUserOutletsDto,
  ): ReturnType<UsersService['setUserOutlets']> {
    return this.usersService.setUserOutlets(user, userId, dto);
  }
}
