import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Permission } from '../../common/decorators/permission.decorator';
import { ALL_SYSTEM_ROLES, Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { AddShiftIssueDto, CloseShiftDto, OpenShiftDto, UpdateShiftIssueDto } from './dto/shift.dto';
import { ShiftsService } from './shifts.service';
import { BranchOf } from '../../common/decorators/branch-of.decorator';

const FLOOR_STAFF = [SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.PosStaff];

@ApiTags('shifts')
@ApiBearerAuth()
@Controller()
@Permission('shifts')
export class ShiftsController {
  constructor(private readonly shiftsService: ShiftsService) {}

  @Post('branches/:branchId/shifts/open')
  @Roles(...FLOOR_STAFF)
  @ApiOperation({ summary: 'Open a cash shift — one at a time per agent per branch' })
  openShift(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: OpenShiftDto,
  ): ReturnType<ShiftsService['openShift']> {
    return this.shiftsService.openShift(tenantId, branchId, dto, user.sub);
  }

  @Post('shifts/:shiftId/close')
  @BranchOf('shift', 'shiftId')
  @Permission('shifts', 'update')
  @Roles(...FLOOR_STAFF)
  @ApiOperation({ summary: 'Close a shift — computes system cash total from linked payments, flags variance, requires an explanation past the branch threshold' })
  closeShift(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() dto: CloseShiftDto,
  ): ReturnType<ShiftsService['closeShift']> {
    return this.shiftsService.closeShift(tenantId, shiftId, dto, user);
  }

  @Get('shifts/:shiftId')
  @BranchOf('shift', 'shiftId')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'A shift with its issues and linked payments' })
  getShift(@CurrentTenant() tenantId: string, @Param('shiftId', ParseUUIDPipe) shiftId: string): ReturnType<ShiftsService['getShift']> {
    return this.shiftsService.getShift(tenantId, shiftId);
  }

  @Get('branches/:branchId/shifts')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'Shift history for a branch, newest first' })
  listShifts(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<ShiftsService['listShifts']> {
    return this.shiftsService.listShifts(tenantId, branchId);
  }

  @Get('branches/:branchId/shifts/current')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: "The calling agent's own open shift on this branch, if any" })
  getCurrentShift(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<ShiftsService['getCurrentShift']> {
    return this.shiftsService.getCurrentShift(tenantId, branchId, user.sub);
  }

  @Get('branches/:branchId/shifts/handover')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'Last closed shift’s handover notes, plus every unresolved issue branch-wide, for an agent opening a new shift' })
  getHandoverContext(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<ShiftsService['getHandoverContext']> {
    return this.shiftsService.getHandoverContext(tenantId, branchId);
  }

  @Post('shifts/:shiftId/issues')
  @BranchOf('shift', 'shiftId')
  @Roles(...FLOOR_STAFF)
  @ApiOperation({ summary: 'Log an issue against a shift' })
  addShiftIssue(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() dto: AddShiftIssueDto,
  ): ReturnType<ShiftsService['addShiftIssue']> {
    return this.shiftsService.addShiftIssue(tenantId, shiftId, dto, user.sub);
  }

  @Patch('shift-issues/:issueId')
  @BranchOf('shiftIssue', 'issueId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Resolve a shift issue, or explicitly carry it over to the next shift — never silently deleted' })
  updateShiftIssue(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() dto: UpdateShiftIssueDto,
  ): ReturnType<ShiftsService['updateShiftIssue']> {
    return this.shiftsService.updateShiftIssue(tenantId, issueId, dto, user.sub);
  }
}
