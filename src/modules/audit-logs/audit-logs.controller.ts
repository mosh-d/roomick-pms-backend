import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { AuditLogsService } from './audit-logs.service';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

@ApiTags('audit-logs')
@ApiBearerAuth()
@Controller()
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get('audit-logs')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Security & Roles — searchable, paginated audit trail across every domain action this tenant has taken' })
  list(@CurrentTenant() tenantId: string, @Query() query: ListAuditLogsQueryDto): ReturnType<AuditLogsService['listAuditLogs']> {
    return this.auditLogsService.listAuditLogs(tenantId, query);
  }
}
