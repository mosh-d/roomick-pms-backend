import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Permission } from '../../common/decorators/permission.decorator';
import { ALL_SYSTEM_ROLES, Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CreateBrandDto, UpdateBrandDto } from './dto/brand.dto';
import {
  CreateBranchDto,
  CancellationPolicyDto,
  NoShowPolicyDto,
  RegCardTemplateDto,
  UpdateBranchDto,
} from './dto/branch.dto';
import { UpdateOverbookingConfigDto } from './dto/overbooking-config.dto';
import { CreateBuildingDto, CreateFloorDto, RenameBuildingDto, UpdateFloorDto } from './dto/structure.dto';
import { PropertyService } from './property.service';
import { BranchOf } from '../../common/decorators/branch-of.decorator';

@ApiTags('property')
@ApiBearerAuth()
@Controller()
@Permission('property')
export class PropertyController {
  constructor(private readonly propertyService: PropertyService) {}

  // --- Brands ---------------------------------------------------------------
  @Post('brands')
  @Roles(SystemRole.Owner)
  @ApiOperation({ summary: 'Create a brand (multi-brand tenants; single-mode allows exactly one)' })
  createBrand(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateBrandDto,
  ): ReturnType<PropertyService['createBrand']> {
    return this.propertyService.createBrand(tenantId, dto, user.sub);
  }

  @Get('brands')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'List brands for the current tenant' })
  listBrands(@CurrentTenant() tenantId: string): ReturnType<PropertyService['listBrands']> {
    return this.propertyService.listBrands(tenantId);
  }

  @Patch('brands/:brandId')
  @Roles(SystemRole.Owner)
  @ApiOperation({ summary: 'Update brand identity/policies' })
  updateBrand(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Body() dto: UpdateBrandDto,
  ): ReturnType<PropertyService['updateBrand']> {
    return this.propertyService.updateBrand(tenantId, brandId, dto, user.sub);
  }

  // --- Branches ---------------------------------------------------------------
  @Post('brands/:brandId/branches')
  @Roles(SystemRole.Owner)
  @ApiOperation({ summary: 'Create a branch (physical property) under a brand' })
  createBranch(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Body() dto: CreateBranchDto,
  ): ReturnType<PropertyService['createBranch']> {
    return this.propertyService.createBranch(tenantId, brandId, dto, user.sub);
  }

  @Get('branches')
  @Roles(SystemRole.Owner)
  @ApiOperation({
    summary:
      "List every branch under the tenant — resolves which branch an owner's dashboard opens to. " +
      'Owner-only, deliberately not Manager too: this route has no :branchId param, and RolesGuard ' +
      "lets any role assignment matching the required role through when there's no param to scope " +
      'against — a branch-scoped manager would see every branch in the tenant, not just their own, ' +
      'if this allowed Manager. An owner’s branchId:null role already means all-branches by definition, ' +
      'so no such over-disclosure risk exists for that role.',
  })
  listBranches(@CurrentTenant() tenantId: string): ReturnType<PropertyService['listBranches']> {
    return this.propertyService.listBranches(tenantId);
  }

  @Get('branches/:branchId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Get a single branch\'s full settings — Property Config\'s own read side' })
  getBranch(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<PropertyService['getBranch']> {
    return this.propertyService.getBranch(tenantId, branchId);
  }

  @Patch('branches/:branchId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Update branch config (times, currency, timezone, policies)' })
  updateBranch(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpdateBranchDto,
  ): ReturnType<PropertyService['updateBranch']> {
    return this.propertyService.updateBranch(tenantId, branchId, dto, user.sub);
  }

  @Patch('branches/:branchId/policies/no-show')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Set the branch no-show policy (night audit consumes it)' })
  setNoShowPolicy(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: NoShowPolicyDto,
  ): ReturnType<PropertyService['setNoShowPolicy']> {
    return this.propertyService.setNoShowPolicy(tenantId, branchId, dto, user.sub);
  }

  @Patch('branches/:branchId/policies/cancellation')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Set the branch cancellation policy — applied to every cancellation, by staff or by the guest online' })
  setCancellationPolicy(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CancellationPolicyDto,
  ): ReturnType<PropertyService['setCancellationPolicy']> {
    return this.propertyService.setCancellationPolicy(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/registration-card-template')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Read the branch registration-card template — lets the edit form pre-fill' })
  getRegCardTemplate(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<PropertyService['getRegCardTemplate']> {
    return this.propertyService.getRegCardTemplate(tenantId, branchId);
  }

  @Patch('branches/:branchId/registration-card-template')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Set the branch registration-card template' })
  setRegCardTemplate(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: RegCardTemplateDto,
  ): ReturnType<PropertyService['setRegCardTemplate']> {
    return this.propertyService.setRegCardTemplate(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/overbooking-config')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: "A branch's overbooking config rows (branch-wide plus any per-room-type overrides)" })
  listOverbookingConfigs(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<PropertyService['listOverbookingConfigs']> {
    return this.propertyService.listOverbookingConfigs(tenantId, branchId);
  }

  @Patch('branches/:branchId/overbooking-config')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Upsert overbooking config (branch-wide or per room type)' })
  updateOverbookingConfig(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpdateOverbookingConfigDto,
  ): ReturnType<PropertyService['updateOverbookingConfig']> {
    return this.propertyService.updateOverbookingConfig(tenantId, branchId, dto, user.sub);
  }

  // --- Buildings & floors -----------------------------------------------------
  @Get('branches/:branchId/layout')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: "Every building and floor at the branch, empty ones too, with each floor's room count" })
  getLayout(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): ReturnType<PropertyService['getLayout']> {
    return this.propertyService.getLayout(tenantId, branchId);
  }

  @Patch('buildings/:buildingId')
  @BranchOf('building', 'buildingId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Rename a building' })
  renameBuilding(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() dto: RenameBuildingDto,
  ): ReturnType<PropertyService['renameBuilding']> {
    return this.propertyService.renameBuilding(tenantId, buildingId, dto.name, user.sub);
  }

  @Patch('floors/:floorId')
  @BranchOf('floor', 'floorId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: "Change a floor's number or label" })
  updateFloor(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('floorId', ParseUUIDPipe) floorId: string,
    @Body() dto: UpdateFloorDto,
  ): ReturnType<PropertyService['updateFloor']> {
    return this.propertyService.updateFloor(tenantId, floorId, dto, user.sub);
  }

  @Post('branches/:branchId/buildings')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Create a building ("Full" onboarding mode)' })
  createBuilding(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateBuildingDto,
  ): ReturnType<PropertyService['createBuilding']> {
    return this.propertyService.createBuilding(tenantId, branchId, dto, user.sub);
  }

  @Post('buildings/:buildingId/floors')
  @BranchOf('building', 'buildingId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Create a floor in a building' })
  createFloor(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() dto: CreateFloorDto,
  ): ReturnType<PropertyService['createFloor']> {
    return this.propertyService.createFloor(tenantId, buildingId, dto, user.sub);
  }

  @Post('branches/:branchId/floors')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({
    summary:
      '"Floors Only" onboarding — create a floor under the branch’s hidden default building',
  })
  createBranchFloor(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateFloorDto,
  ): ReturnType<PropertyService['createBranchFloor']> {
    return this.propertyService.createBranchFloor(tenantId, branchId, dto, user.sub);
  }
}
