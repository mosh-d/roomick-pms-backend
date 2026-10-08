import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators';
import { Permission } from '../../common/decorators/permission.decorator';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { AlertsService } from './alerts.service';

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('branches/:branchId/alerts')
@Permission('alerts')
// Alerts name who owes what and who hasn't arrived — the desk's and the books' business.
@Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'Live operational alerts for this branch — missed check-ins, overdue checkouts, overdue balances. Computed on every call, nothing persisted; an alert clears itself the moment the underlying reservation/folio actually changes.' })
  getAlerts(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<AlertsService['getAlerts']> {
    return this.alertsService.getAlerts(tenantId, branchId);
  }
}
