import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Permission } from '../../common/decorators/permission.decorator';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CorporateAccountsService } from './corporate-accounts.service';
import { CreateCorporateAccountDto, UpdateCorporateAccountDto } from './dto/corporate-account.dto';

@ApiTags('corporate-accounts')
@ApiBearerAuth()
@Controller('corporate-accounts')
@Permission('guests')
export class CorporateAccountsController {
  constructor(private readonly corporateAccountsService: CorporateAccountsService) {}

  // Front desk reads the list to book a guest under their company.
  @Get()
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
  @ApiOperation({ summary: 'Company accounts, active first — with their contracted rate plan and how many stays each has' })
  list(@CurrentTenant() tenantId: string): ReturnType<CorporateAccountsService['list']> {
    return this.corporateAccountsService.list(tenantId);
  }

  @Get(':accountId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
  @ApiOperation({ summary: 'A company account with its travelers (everyone who has stayed under it) and latest stays' })
  detail(@CurrentTenant() tenantId: string, @Param('accountId', ParseUUIDPipe) accountId: string): ReturnType<CorporateAccountsService['detail']> {
    return this.corporateAccountsService.detail(tenantId, accountId);
  }

  @Post()
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Add a company account — staff email domains and an optional contracted (negotiated) rate plan' })
  create(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: CreateCorporateAccountDto): ReturnType<CorporateAccountsService['create']> {
    return this.corporateAccountsService.create(tenantId, dto, user.sub);
  }

  @Patch(':accountId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Change a company account, or switch it off (isActive) — its past stays keep it' })
  update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: UpdateCorporateAccountDto,
  ): ReturnType<CorporateAccountsService['update']> {
    return this.corporateAccountsService.update(tenantId, accountId, dto, user.sub);
  }
}
