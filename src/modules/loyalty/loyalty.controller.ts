import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { LoyaltyService, LoyaltySummary } from './loyalty.service';

@ApiTags('loyalty')
@ApiBearerAuth()
@Controller('loyalty')
@Roles(SystemRole.Owner, SystemRole.Manager)
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Loyalty & Marketing — every guest with a tier or points, plus per-tier totals' })
  summary(@CurrentTenant() tenantId: string): Promise<LoyaltySummary> {
    return this.loyaltyService.getSummary(tenantId);
  }
}
