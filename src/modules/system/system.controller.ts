import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { SystemService, HealthReport, DetailedHealthReport } from './system.service';

@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness + database connectivity check' })
  health(): Promise<HealthReport> {
    return this.systemService.health();
  }

  @Get('health/detailed')
  @Roles(SystemRole.Owner)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'System Admin — DB latency, process memory/uptime, and rolling request/error-rate metrics' })
  detailedHealth(): Promise<DetailedHealthReport> {
    return this.systemService.detailedHealth();
  }
}
