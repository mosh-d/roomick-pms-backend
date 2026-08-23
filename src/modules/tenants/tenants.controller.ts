import { Body, Controller, Delete, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
    summary: 'Signup step 2 — fix single/multi-brand mode; always creates the head brand',
  })
  configureMode(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfigureModeDto,
  ): ReturnType<TenantsService['configureMode']> {
    return this.tenantsService.configureMode(tenantId, dto, user.sub);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(SystemRole.Owner)
  @ApiOperation({
    summary:
      'Delete the caller\'s own organization — manual counterpart to the demo-tenant auto-expiry sweep. ' +
      'The manual "Delete Organization" action (no path param: always the caller\'s own tenant, derived ' +
      'the same way every other endpoint derives it, never trusted from a client-supplied ID).',
  })
  deleteOrganization(@CurrentTenant() tenantId: string): ReturnType<TenantsService['deleteOrganization']> {
    return this.tenantsService.deleteOrganization(tenantId);
  }
}
