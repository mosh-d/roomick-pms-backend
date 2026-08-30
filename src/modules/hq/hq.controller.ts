import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { CrossPropertyReportQueryDto } from './dto/hq.dto';
import { HqService, PortfolioOverview, CrossPropertyReport } from './hq.service';

/**
 * Owner-only across this whole controller, matching `listBranches`'s own
 * reasoning — every route here has no `:branchId` param, so a branch-scoped
 * Manager would see every branch in the tenant if this allowed Manager too.
 */
@ApiTags('hq')
@ApiBearerAuth()
@Controller('hq')
@Roles(SystemRole.Owner)
export class HqController {
  constructor(private readonly hqService: HqService) {}

  @Get('portfolio')
  @ApiOperation({ summary: 'Enterprise / HQ — every brand and branch at a glance' })
  portfolio(@CurrentTenant() tenantId: string): Promise<PortfolioOverview> {
    return this.hqService.getPortfolio(tenantId);
  }

  @Get('reports')
  @ApiOperation({ summary: 'Enterprise / HQ — one report type, broken down per branch plus a blended total where currencies allow it' })
  crossPropertyReport(@CurrentTenant() tenantId: string, @Query() query: CrossPropertyReportQueryDto): Promise<CrossPropertyReport> {
    const branchIds = query.branchIds ? query.branchIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return this.hqService.getCrossPropertyReport(tenantId, query.type, { from: query.from, to: query.to }, branchIds);
  }
}
