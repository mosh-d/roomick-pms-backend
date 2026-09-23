import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { AccountingExportService, JournalPreview } from './accounting-export.service';
import { AccountingProvider } from './connectors/accounting-export';
import { ExportRangeQueryDto, SaveConnectionDto } from './dto/marketplace.dto';
import { ListingDetail, MarketplaceService, MarketplaceView, isAccountingProvider } from './marketplace.service';
import { ReviewRequestsService } from './review-requests.service';

function accountingProvider(provider: string): AccountingProvider {
  if (!isAccountingProvider(provider)) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'No accounting export by that name' });
  return provider;
}

@ApiTags('integrations-marketplace')
@ApiBearerAuth()
@Controller()
export class MarketplaceController {
  constructor(
    private readonly marketplaceService: MarketplaceService,
    private readonly accountingExportService: AccountingExportService,
    private readonly reviewRequestsService: ReviewRequestsService,
  ) {}

  @Get('integrations/marketplace')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'The catalogue by category, with whether each integration is switched on' })
  catalog(@CurrentTenant() tenantId: string): Promise<MarketplaceView> {
    return this.marketplaceService.listCatalog(tenantId);
  }

  @Get('integrations/marketplace/:provider')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'One integration: what it does, its settings (or suggested ones), and what setting it up needs' })
  listing(@CurrentTenant() tenantId: string, @Param('provider') provider: string): Promise<ListingDetail> {
    return this.marketplaceService.getListing(tenantId, provider);
  }

  @Put('integrations/marketplace/:provider')
  // Accountants may set up the accounting exports; the service narrows review requests to owners and managers.
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'Switch an integration on, or save new settings for one that is on' })
  save(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('provider') provider: string, @Body() dto: SaveConnectionDto): Promise<ListingDetail> {
    return this.marketplaceService.saveConnection(tenantId, provider, dto.config, user);
  }

  @Delete('integrations/marketplace/:provider')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'Switch an integration off — its settings are kept' })
  disable(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('provider') provider: string): Promise<ListingDetail> {
    return this.marketplaceService.disable(tenantId, provider, user);
  }

  @Get('branches/:branchId/integrations/accounting/:provider/preview')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'The daily journals a date range would export, with their totals — to check before downloading' })
  previewJournals(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('provider') provider: string,
    @Query() query: ExportRangeQueryDto,
  ): Promise<JournalPreview> {
    return this.accountingExportService.preview(tenantId, branchId, accountingProvider(provider), query.from, query.to);
  }

  @Get('branches/:branchId/integrations/accounting/:provider/export')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'Download the journals as the accounting product’s own import file (CSV)' })
  async exportJournals(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('provider') provider: string,
    @Query() query: ExportRangeQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, csv } = await this.accountingExportService.exportCsv(tenantId, branchId, accountingProvider(provider), query.from, query.to);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  @Get('branches/:branchId/integrations/review-requests/preview')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'The review request as a guest of this property would receive it' })
  previewReviewRequest(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): ReturnType<ReviewRequestsService['preview']> {
    return this.reviewRequestsService.preview(tenantId, branchId);
  }
}
