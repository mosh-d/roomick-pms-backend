import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MaintenanceStatus } from '@prisma/client';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CreateAssetDto, CreateWorkOrderDto, UpdateWorkOrderDto } from './dto/maintenance.dto';
import { MaintenanceService } from './maintenance.service';

@ApiTags('maintenance')
@ApiBearerAuth()
@Controller()
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post('branches/:branchId/maintenance/work-orders')
  @ApiOperation({ summary: 'Submit a maintenance request — open to any department, not role-gated' })
  createWorkOrder(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateWorkOrderDto,
  ): ReturnType<MaintenanceService['createWorkOrder']> {
    return this.maintenanceService.createWorkOrder(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/maintenance/work-orders')
  @ApiOperation({ summary: 'The work order board — every status, or filtered to one' })
  listWorkOrders(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query('status') status?: MaintenanceStatus,
  ): ReturnType<MaintenanceService['listWorkOrders']> {
    return this.maintenanceService.listWorkOrders(tenantId, branchId, status);
  }

  @Patch('maintenance/work-orders/:orderId')
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
  @ApiOperation({ summary: 'Asset registry, each with a computed nextServiceDue' })
  listAssets(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<MaintenanceService['listAssets']> {
    return this.maintenanceService.listAssets(tenantId, branchId);
  }
}
