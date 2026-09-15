import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Competitor, RatePlan } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import {
  ApproveRateRecommendationDto,
  CompSetQueryDto,
  CreateAvailabilityRestrictionDto,
  CreateCompetitorDto,
  SetCompetitorRatesDto,
  UpdateCompetitorDto,
} from './dto/revenue-management.dto';
import { RestrictionsService, AvailabilityRestrictionSummary } from './restrictions.service';
import { DemandForecastService, ForecastDay } from './demand-forecast.service';
import { RateRecommendationsService, RateRecommendation } from './rate-recommendations.service';
import { CompSetAnalysis, CompSetService } from './comp-set.service';

@ApiTags('revenue-management')
@ApiBearerAuth()
@Controller()
@Roles(SystemRole.Owner, SystemRole.Manager)
export class RevenueManagementController {
  constructor(
    private readonly restrictionsService: RestrictionsService,
    private readonly demandForecastService: DemandForecastService,
    private readonly rateRecommendationsService: RateRecommendationsService,
    private readonly compSetService: CompSetService,
  ) {}

  // --- Restrictions Management --------------------------------------------------

  @Post('branches/:branchId/availability-restrictions')
  @ApiOperation({ summary: 'Revenue Management — set a MinLOS/MaxLOS/closed-to-arrival/stop-sell restriction for a date range' })
  createRestriction(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateAvailabilityRestrictionDto,
  ): Promise<AvailabilityRestrictionSummary> {
    return this.restrictionsService.createRestriction(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/availability-restrictions')
  @ApiOperation({ summary: 'List availability restrictions for the branch' })
  listRestrictions(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): Promise<AvailabilityRestrictionSummary[]> {
    return this.restrictionsService.listRestrictions(tenantId, branchId);
  }

  @Delete('availability-restrictions/:restrictionId')
  @ApiOperation({ summary: 'Remove a restriction' })
  async deleteRestriction(@CurrentTenant() tenantId: string, @Param('restrictionId', ParseUUIDPipe) restrictionId: string): Promise<{ ok: true }> {
    await this.restrictionsService.deleteRestriction(tenantId, restrictionId);
    return { ok: true };
  }

  // --- Demand Forecast -----------------------------------------------------------

  @Get('branches/:branchId/demand-forecast')
  @ApiOperation({ summary: 'Revenue Management — same-weekday historical occupancy average, projected forward. Not a predictive model.' })
  getForecast(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query('horizonDays') horizonDays?: string,
  ): Promise<ForecastDay[]> {
    return this.demandForecastService.getForecast(tenantId, branchId, horizonDays ? Number(horizonDays) : undefined);
  }

  // --- Rate Recommendations -------------------------------------------------------

  @Get('branches/:branchId/rate-recommendations')
  @ApiOperation({ summary: 'Revenue Management — fixed-threshold, rule-based rate suggestions off the demand forecast. Not AI.' })
  getRecommendations(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query('roomTypeId', ParseUUIDPipe) roomTypeId: string,
    @Query('horizonDays') horizonDays?: string,
  ): Promise<RateRecommendation[]> {
    return this.rateRecommendationsService.getRecommendations(tenantId, branchId, roomTypeId, horizonDays ? Number(horizonDays) : undefined);
  }

  @Post('branches/:branchId/rate-recommendations/approve')
  @ApiOperation({ summary: 'Approve a rate recommendation — creates a real seasonal RatePlan for that single date, applied through the normal rate cascade' })
  approveRecommendation(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string, @Body() dto: ApproveRateRecommendationDto): Promise<RatePlan> {
    return this.rateRecommendationsService.approveRecommendation(tenantId, branchId, dto);
  }

  // --- Comp Set Analysis ------------------------------------------------------------

  @Get('branches/:branchId/competitors')
  @ApiOperation({ summary: 'The hotels in the comp set, inactive ones last' })
  listCompetitors(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): Promise<Competitor[]> {
    return this.compSetService.listCompetitors(tenantId, branchId);
  }

  @Post('branches/:branchId/competitors')
  @ApiOperation({ summary: 'Add a hotel to the comp set' })
  createCompetitor(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateCompetitorDto,
  ): Promise<Competitor> {
    return this.compSetService.createCompetitor(tenantId, branchId, dto.name, user.sub);
  }

  @Patch('competitors/:competitorId')
  @ApiOperation({ summary: 'Rename a competitor, or take it out of the comp set' })
  updateCompetitor(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('competitorId', ParseUUIDPipe) competitorId: string,
    @Body() dto: UpdateCompetitorDto,
  ): Promise<Competitor> {
    return this.compSetService.updateCompetitor(tenantId, competitorId, dto, user);
  }

  @Put('branches/:branchId/competitor-rates')
  @ApiOperation({ summary: "Enter a competitor's nightly rate across a run of nights, for one of our room types — or clear it" })
  setCompetitorRates(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: SetCompetitorRatesDto,
  ): Promise<{ nights: number }> {
    return this.compSetService.setRates(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/comp-set')
  @ApiOperation({ summary: 'Comp set analysis — our published rate against the competitors’, night by night, with the market position flagged' })
  getCompSet(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: CompSetQueryDto,
  ): Promise<CompSetAnalysis> {
    return this.compSetService.getCompSet(tenantId, branchId, query);
  }
}
