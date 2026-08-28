import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators';
import { ReportQueryDto } from './dto/report-query.dto';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('branches/:branchId/reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('occupancy')
  @ApiOperation({ summary: 'Occupancy % by day/week/month, with a room-type breakdown' })
  getOccupancy(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: ReportQueryDto,
  ): ReturnType<ReportsService['getOccupancy']> {
    return this.reportsService.getOccupancy(tenantId, branchId, query);
  }

  @Get('adr')
  @ApiOperation({ summary: 'Average Daily Rate, with a room-type breakdown and a day-level trend' })
  getAdr(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: ReportQueryDto,
  ): ReturnType<ReportsService['getAdr']> {
    return this.reportsService.getAdr(tenantId, branchId, query);
  }

  @Get('revpar')
  @ApiOperation({ summary: 'Revenue Per Available Room, with a room-type breakdown and a day-level trend' })
  getRevpar(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: ReportQueryDto,
  ): ReturnType<ReportsService['getRevpar']> {
    return this.reportsService.getRevpar(tenantId, branchId, query);
  }

  @Get('revenue')
  @ApiOperation({ summary: 'Revenue by department and payment method, with a day-level trend' })
  getRevenue(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: ReportQueryDto,
  ): ReturnType<ReportsService['getRevenue']> {
    return this.reportsService.getRevenue(tenantId, branchId, query);
  }
}
