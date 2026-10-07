import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { PageAccessMatrix, PageAccessService, RolePageAccess } from '../../common/permissions/page-access.service';
import { JwtPayload } from '../../common/types/request-context';
import { SetPageAccessDto } from './dto/page-access.dto';

/**
 * Staff Management → Page Access: a branch's owner or manager decides which
 * pages each staff role opens there. No `@Permission` module: no custom role
 * can be given this, and no API key can reach it.
 */
@ApiTags('staff')
@ApiBearerAuth()
@Controller()
export class PageAccessController {
  constructor(private readonly pageAccess: PageAccessService) {}

  @Get('branches/:branchId/page-access')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Every staff role’s pages at this branch — what each could be given, and what it opens now' })
  matrix(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): Promise<PageAccessMatrix> {
    return this.pageAccess.matrix(tenantId, branchId);
  }

  @Put('branches/:branchId/page-access/:roleId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Set the pages a staff role opens at this branch; the server also refuses it the areas none of them use' })
  setPages(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: SetPageAccessDto,
  ): Promise<RolePageAccess> {
    return this.pageAccess.setPages(tenantId, branchId, roleId, dto.pages, user.sub);
  }

  @Delete('branches/:branchId/page-access/:roleId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Put a staff role back on its default at this branch — every page its role can open' })
  reset(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ): Promise<RolePageAccess> {
    return this.pageAccess.reset(tenantId, branchId, roleId, user.sub);
  }

  /** Open to everyone signed in: it only ever answers about the person asking. */
  @Get('branches/:branchId/my-pages')
  @ApiOperation({ summary: 'The pages I open at this branch — `restricted: false` for an owner or the branch’s manager, who see everything' })
  async myPages(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): Promise<{ restricted: boolean; pages: string[] }> {
    const pages = await this.pageAccess.pagesForUser(tenantId, user, branchId);
    return pages === null ? { restricted: false, pages: [] } : { restricted: true, pages };
  }
}
