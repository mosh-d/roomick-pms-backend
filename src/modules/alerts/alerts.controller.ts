import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators';
import { AlertsService } from './alerts.service';

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('branches/:branchId/alerts')
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
