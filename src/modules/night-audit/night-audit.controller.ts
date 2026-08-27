import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { NightAuditService } from './night-audit.service';

export class RunNightAuditDto {
  @ApiPropertyOptional({ example: '2026-08-26', description: 'Date to close. Defaults to yesterday in the branch timezone.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  auditDate?: string;
}

@ApiTags('night-audit')
@ApiBearerAuth()
@Controller()
export class NightAuditController {
  constructor(private readonly nightAuditService: NightAuditService) {}

  @Get('branches/:branchId/night-audit/preflight')
  @ApiOperation({ summary: 'Pre-audit checks: which date would close, whether it already ran, due-outs, open folios, unresolved no-shows' })
  getPreflight(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<NightAuditService['getPreflight']> {
    return this.nightAuditService.getPreflight(tenantId, branchId);
  }

  @Get('branches/:branchId/night-audit')
  @ApiOperation({ summary: 'Recent night audit runs for a branch' })
  listRuns(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<NightAuditService['listRuns']> {
    return this.nightAuditService.listRuns(tenantId, branchId);
  }

  @Post('branches/:branchId/night-audit/run')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({
    summary:
      'Manually trigger the night audit. Same service path as the scheduled sweep; triggeredBy records the user (NULL = automatic).',
  })
  async runAudit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: RunNightAuditDto,
  ): ReturnType<NightAuditService['runAudit']> {
    const auditDate = dto.auditDate ?? (await this.nightAuditService.getPreflight(tenantId, branchId)).auditDate;
    return this.nightAuditService.runAudit(tenantId, branchId, auditDate, user.sub);
  }
}
