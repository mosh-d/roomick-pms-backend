import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CreateBrandDto, UpdateBrandDto } from './dto/brand.dto';
import {
  CreateBranchDto,
  NoShowPolicyDto,
  RegCardTemplateDto,
  UpdateBranchDto,
} from './dto/branch.dto';
import { UpdateOverbookingConfigDto } from './dto/overbooking-config.dto';
import { CreateBuildingDto, CreateFloorDto } from './dto/structure.dto';
import { PropertyService } from './property.service';

@ApiTags('property')
@ApiBearerAuth()
@Controller()
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
