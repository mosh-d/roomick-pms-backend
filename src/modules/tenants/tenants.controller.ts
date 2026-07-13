import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { ConfigureModeDto } from './dto/configure-mode.dto';
import { TenantsService } from './tenants.service';

@ApiTags('tenants')
@ApiBearerAuth()
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post('configure-mode')
  @Roles(SystemRole.Owner)
  @ApiOperation({
    summary: 'Signup step 2 — fix single/multi-brand mode (single auto-creates the hidden brand)',
  })
  configureMode(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfigureModeDto,
  ): ReturnType<TenantsService['configureMode']> {
    return this.tenantsService.configureMode(tenantId, dto, user.sub);
  }
}
