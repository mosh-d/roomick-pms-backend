import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Permission } from '../../common/decorators/permission.decorator';
import { ALL_SYSTEM_ROLES, Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CreateAssetDto, CreateWorkOrderDto, ListWorkOrdersQueryDto, UpdateWorkOrderDto } from './dto/maintenance.dto';
import { MaintenanceService } from './maintenance.service';
import { BranchOf } from '../../common/decorators/branch-of.decorator';

@ApiTags('maintenance')
@ApiBearerAuth()
@Controller()
@Permission('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post('branches/:branchId/maintenance/work-orders')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'Submit a maintenance request — open to any department, not role-gated' })
  createWorkOrder(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateWorkOrderDto,
  ): ReturnType<MaintenanceService['createWorkOrder']> {
    return this.maintenanceService.createWorkOrder(tenantId, branchId, dto, user);
  }

  @Get('branches/:branchId/maintenance/work-orders')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'The work order board — every status, or filtered to one' })
  listWorkOrders(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: ListWorkOrdersQueryDto,
  ): ReturnType<MaintenanceService['listWorkOrders']> {
    return this.maintenanceService.listWorkOrders(tenantId, branchId, query.status);
  }

  @Patch('maintenance/work-orders/:orderId')
  @BranchOf('maintenanceOrder', 'orderId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Housekeeper)
  @ApiOperation({ summary: 'Move a work order across the board, assign it, or close it out with notes' })
  updateWorkOrder(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateWorkOrderDto,
  ): ReturnType<MaintenanceService['updateWorkOrder']> {
    return this.maintenanceService.updateWorkOrder(tenantId, orderId, dto, user.sub);
  }

  @Post('branches/:branchId/maintenance/assets')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Register an asset for service tracking' })
  createAsset(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateAssetDto,
  ): ReturnType<MaintenanceService['createAsset']> {
    return this.maintenanceService.createAsset(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/maintenance/assets')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'Asset registry, each with a computed nextServiceDue' })
  listAssets(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<MaintenanceService['listAssets']> {
    return this.maintenanceService.listAssets(tenantId, branchId);
  }
}
