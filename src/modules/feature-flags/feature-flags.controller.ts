import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { ToggleFeatureFlagDto } from './dto/feature-flags.dto';
import { FeatureFlagsService } from './feature-flags.service';

@ApiTags('feature-flags')
@ApiBearerAuth()
@Controller('feature-flags')
@Roles(SystemRole.Owner)
export class FeatureFlagsController {
  constructor(private readonly featureFlagsService: FeatureFlagsService) {}

  @Get()
  @ApiOperation({ summary: "System Admin — every feature flag and whether it's on for this tenant" })
  list(@CurrentTenant() tenantId: string): ReturnType<FeatureFlagsService['listFlags']> {
    return this.featureFlagsService.listFlags(tenantId);
  }

  @Patch(':flagId/toggle-for-tenant')
  @ApiOperation({ summary: "Opt this tenant in or out of a flag — never touches global rollout or any other tenant's membership" })
  toggle(
    @CurrentTenant() tenantId: string,
    @Param('flagId', ParseUUIDPipe) flagId: string,
    @Body() dto: ToggleFeatureFlagDto,
  ): ReturnType<FeatureFlagsService['setEnabledForTenant']> {
    return this.featureFlagsService.setEnabledForTenant(tenantId, flagId, dto.enabled);
  }
}
