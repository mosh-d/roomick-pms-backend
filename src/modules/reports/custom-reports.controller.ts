import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Permission } from '../../common/decorators/permission.decorator';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { RunCustomReportDto, SaveReportTemplateDto } from './dto/custom-report.dto';
import { CustomReportsService } from './custom-reports.service';

/** Who builds reports — the same people Reports & Analytics is for. */
const REPORT_ROLES = [SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant];

@ApiTags('reports')
@ApiBearerAuth()
@Controller()
@Permission('reports')
export class CustomReportsController {
  constructor(private readonly customReportsService: CustomReportsService) {}

  @Get('reports/custom/catalogue')
  @Roles(...REPORT_ROLES)
  @ApiOperation({ summary: 'Custom Report Builder — the datasets, their columns, and the filter operators for each column type' })
  catalogue(): ReturnType<CustomReportsService['catalogue']> {
    return this.customReportsService.catalogue();
  }

  @Post('branches/:branchId/reports/custom/run')
  @HttpCode(200)
  @Permission('reports', 'read')
  @Roles(...REPORT_ROLES)
  @ApiOperation({ summary: 'Run a custom report for a range of dates — the first 500 rows, and how many there are' })
  run(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: RunCustomReportDto,
  ): ReturnType<CustomReportsService['run']> {
    return this.customReportsService.run(tenantId, branchId, dto);
  }

  @Post('branches/:branchId/reports/custom/csv')
  @HttpCode(200)
  @Permission('reports', 'read')
  @Roles(...REPORT_ROLES)
  @ApiOperation({ summary: 'The same report as a CSV file, every row' })
  async csv(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string, @Body() dto: RunCustomReportDto, @Res() res: Response): Promise<void> {
    const csv = await this.customReportsService.runCsv(tenantId, branchId, dto);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${dto.dataset}-${dto.from}-${dto.to}.csv"`);
    res.send(csv);
  }

  @Get('branches/:branchId/reports/custom/templates')
  @Roles(...REPORT_ROLES)
  @ApiOperation({ summary: 'Saved reports at the branch' })
  listTemplates(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): ReturnType<CustomReportsService['listTemplates']> {
    return this.customReportsService.listTemplates(tenantId, branchId);
  }

  @Post('branches/:branchId/reports/custom/templates')
  @Roles(...REPORT_ROLES)
  @ApiOperation({ summary: 'Save a report under a name — the same name replaces it' })
  saveTemplate(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: SaveReportTemplateDto,
  ): ReturnType<CustomReportsService['saveTemplate']> {
    return this.customReportsService.saveTemplate(tenantId, branchId, dto.name, dto.definition, user.sub);
  }

  @Delete('report-templates/:templateId')
  @HttpCode(204)
  @Roles(...REPORT_ROLES)
  @ApiOperation({ summary: 'Delete a saved report' })
  async deleteTemplate(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('templateId', ParseUUIDPipe) templateId: string): Promise<void> {
    await this.customReportsService.deleteTemplate(tenantId, templateId, user.sub);
  }
}
