import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Permission } from '../../common/decorators/permission.decorator';
import { ALL_SYSTEM_ROLES, Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CalculateRateDto, CreateRatePlanDto, UpdateRatePlanDto } from './dto/rate-resolver.dto';
import { RateResolverService } from './rate-resolver.service';
import { CreatePackageDto, UpdatePackageDto } from './dto/package.dto';
import { PackagesQuote, PackagesService, PackageView } from './packages.service';
import { BranchOf } from '../../common/decorators/branch-of.decorator';

@ApiTags('rate-resolver')
@ApiBearerAuth()
@Controller()
@Permission('reservations')
export class RateResolverController {
  constructor(
    private readonly rateResolverService: RateResolverService,
    private readonly packagesService: PackagesService,
  ) {}

  @Get('branches/:branchId/packages')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'Packages sold with a stay at this property — breakfast, transfers — with what each costs and the room types it comes with' })
  listPackages(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string, @Query('roomTypeId') roomTypeId?: string): Promise<PackageView[]> {
    return this.packagesService.list(tenantId, branchId, { roomTypeId: roomTypeId || undefined });
  }

  @Post('branches/:branchId/packages')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Add a package — its price, whether by the night, by the stay or by guest by the night, and what it posts as' })
  createPackage(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreatePackageDto,
  ): Promise<PackageView> {
    return this.packagesService.create(tenantId, branchId, dto, user.sub);
  }

  @Patch('packages/:packageId')
  @BranchOf('package', 'packageId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Change a package, or take it off sale — stays that have it keep it as priced' })
  updatePackage(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('packageId', ParseUUIDPipe) packageId: string,
    @Body() dto: UpdatePackageDto,
  ): Promise<PackageView> {
    return this.packagesService.update(tenantId, packageId, dto, user.sub);
  }

  @Delete('packages/:packageId')
  @BranchOf('package', 'packageId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Remove a package from the list' })
  removePackage(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('packageId', ParseUUIDPipe) packageId: string): Promise<{ removed: true }> {
    return this.packagesService.remove(tenantId, packageId, user.sub);
  }

  @Post('branches/:branchId/rate-resolver/calculate')
  @Roles(...ALL_SYSTEM_ROLES)
  @Permission('reservations', 'read')
  @ApiOperation({ summary: 'Resolve a nightly rate for a stay through the plan cascade — the same logic every booking screen uses, never re-derived client-side' })
  async calculate(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CalculateRateDto,
  ): Promise<Awaited<ReturnType<RateResolverService['calculateQuote']>> & { packages: PackagesQuote | null; grandTotal: string }> {
    const quote = await this.rateResolverService.calculateQuote(tenantId, branchId, dto, user.sub);
    const packages = dto.packageIds?.length
      ? await this.packagesService.quoteForStay(tenantId, branchId, {
          roomTypeId: dto.roomTypeId,
          packageIds: dto.packageIds,
          nights: quote.perNight.length,
          guests: (dto.adults ?? 1) + (dto.children ?? 0),
        })
      : null;
    return { ...quote, packages, grandTotal: quote.totalWithTax.plus(packages?.total ?? 0).toFixed(2) };
  }

  @Get('rate-resolver/audit')
  // The trail names negotiated and corporate rates — for the people who
  // settle a rate dispute, not every role (a housekeeper could read it).
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'Full per-night rule-resolution trace for a reservation, for dispute handling' })
  getAudit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Query('reservationId', ParseUUIDPipe) reservationId: string,
  ): ReturnType<RateResolverService['getAuditTrail']> {
    return this.rateResolverService.getAuditTrail(tenantId, reservationId, user);
  }

  @Post('branches/:branchId/rate-plans')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Create a rate plan (cascade tier or override) — auto-registered with the resolver, no separate activation step' })
  createRatePlan(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateRatePlanDto,
  ): ReturnType<RateResolverService['createRatePlan']> {
    return this.rateResolverService.createRatePlan(tenantId, branchId, dto);
  }

  @Get('branches/:branchId/rate-plans')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'List a branch rate plans (active and retired)' })
  listRatePlans(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): ReturnType<RateResolverService['listRatePlans']> {
    return this.rateResolverService.listRatePlans(tenantId, branchId);
  }

  @Patch('rate-plans/:ratePlanId')
  @BranchOf('ratePlan', 'ratePlanId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Retire or reinstate a rate plan (isActive) — plans are never deleted' })
  updateRatePlan(
    @CurrentTenant() tenantId: string,
    @Param('ratePlanId', ParseUUIDPipe) ratePlanId: string,
    @Body() dto: UpdateRatePlanDto,
  ): ReturnType<RateResolverService['updateRatePlan']> {
    return this.rateResolverService.updateRatePlan(tenantId, ratePlanId, dto);
  }
}
