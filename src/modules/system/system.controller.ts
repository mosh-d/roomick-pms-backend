import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { SystemService, HealthReport } from './system.service';

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
}
