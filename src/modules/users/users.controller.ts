import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { BulkInviteDto } from './dto/bulk-invite.dto';
import { PatchStaffDto } from './dto/patch-staff.dto';
import { SetUserOutletsDto } from './dto/set-user-outlets.dto';
import { UsersService } from './users.service';

@ApiTags('staff')
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('branches/:branchId/staff')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Staff visible at a branch (branch-scoped + all-branch roles)' })
  listStaff(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<UsersService['listStaff']> {
    return this.usersService.listStaff(tenantId, branchId);
  }

  @Post('branches/:branchId/staff/invite')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({
    summary: 'Bulk staff invite — one row per email; returns the invite links (email stubbed)',
  })
  bulkInvite(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: BulkInviteDto,
  ): ReturnType<UsersService['bulkInvite']> {
    return this.usersService.bulkInvite(tenantId, branchId, dto, user.sub);
  }

  @Patch('staff/:userId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Update a staff member — role, outlets, active flag' })
  patchStaff(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: PatchStaffDto,
  ): ReturnType<UsersService['patchStaff']> {
    return this.usersService.patchStaff(tenantId, userId, dto, user.sub);
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
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: SetUserOutletsDto,
  ): ReturnType<UsersService['setUserOutlets']> {
    return this.usersService.setUserOutlets(tenantId, userId, dto, user.sub);
  }
}
