import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { AdjustPointsDto, RedeemPointsDto, SaveLoyaltyProgramDto } from './dto/loyalty.dto';
import { GuestLoyaltyView, LoyaltyProgramView, LoyaltyService, LoyaltySummary, RedemptionResult } from './loyalty.service';

@ApiTags('loyalty')
@ApiBearerAuth()
@Controller()
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @Get('loyalty/summary')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Loyalty & Marketing — every member, plus per-tier totals' })
  summary(@CurrentTenant() tenantId: string): Promise<LoyaltySummary> {
    return this.loyaltyService.getSummary(tenantId);
  }

  @Get('loyalty/program')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'The loyalty programme — earning rate, point value, tiers and benefits (a suggestion until saved)' })
  getProgram(@CurrentTenant() tenantId: string): Promise<LoyaltyProgramView> {
    return this.loyaltyService.getProgram(tenantId);
  }

  @Put('loyalty/program')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: "Save the loyalty programme — every member's tier follows the new thresholds" })
  saveProgram(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: SaveLoyaltyProgramDto): Promise<LoyaltyProgramView> {
    return this.loyaltyService.saveProgram(tenantId, dto, user.sub);
  }

  @Get('guests/:guestId/loyalty')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: "A guest's points, tier, progress to the next tier, and points history" })
  getGuestLoyalty(@CurrentTenant() tenantId: string, @Param('guestId', ParseUUIDPipe) guestId: string): Promise<GuestLoyaltyView> {
    return this.loyaltyService.getGuestLoyalty(tenantId, guestId);
  }

  @Post('guests/:guestId/loyalty/enroll')
  @HttpCode(200)
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Enrol a guest in the loyalty programme (a stay enrols them on its own at check-out)' })
  enroll(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('guestId', ParseUUIDPipe) guestId: string): Promise<GuestLoyaltyView> {
    return this.loyaltyService.enroll(tenantId, guestId, user.sub);
  }

  @Post('guests/:guestId/loyalty/adjustments')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: "Add or take off points, with a reason — never below zero" })
  adjust(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('guestId', ParseUUIDPipe) guestId: string,
    @Body() dto: AdjustPointsDto,
  ): Promise<GuestLoyaltyView> {
    return this.loyaltyService.adjust(tenantId, guestId, dto, user.sub);
  }

  @Post('folios/:folioId/loyalty-redemptions')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: "Pay part of a bill with the guest's points — capped at what the bill owes" })
  redeem(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('folioId', ParseUUIDPipe) folioId: string,
    @Body() dto: RedeemPointsDto,
  ): Promise<RedemptionResult> {
    return this.loyaltyService.redeem(tenantId, folioId, dto.points, user);
  }
}
