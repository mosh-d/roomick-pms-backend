import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { BranchOf } from '../../common/decorators/branch-of.decorator';
import { Permission } from '../../common/decorators/permission.decorator';
import { ALL_SYSTEM_ROLES, Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CreateTaxRuleDto, ReplaceTaxRuleDto, UpdateTaxRuleDto } from './dto/tax-rule.dto';
import { TaxesService } from './taxes.service';

@ApiTags('taxes')
@ApiBearerAuth()
@Controller()
@Permission('taxes')
export class TaxesController {
  constructor(private readonly taxesService: TaxesService) {}

  @Post('branches/:branchId/tax-rules')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'Create a tax rule for a branch — a percentage of each charge, or a fixed amount per charge (per night on rooms); empty appliesToChargeTypes = all' })
  createTaxRule(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateTaxRuleDto,
  ): ReturnType<TaxesService['createTaxRule']> {
    return this.taxesService.createTaxRule(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/tax-rules')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'List a branch tax rules (active and retired)' })
  listTaxRules(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<TaxesService['listTaxRules']> {
    return this.taxesService.listTaxRules(tenantId, branchId);
  }

  @Patch('tax-rules/:taxRuleId')

  @BranchOf('taxRule', 'taxRuleId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'Retire or reinstate a tax rule (isActive) — rules are never deleted' })
  updateTaxRule(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('taxRuleId', ParseUUIDPipe) taxRuleId: string,
    @Body() dto: UpdateTaxRuleDto,
  ): ReturnType<TaxesService['updateTaxRule']> {
    return this.taxesService.updateTaxRule(tenantId, taxRuleId, dto, user);
  }

  @Post('tax-rules/:taxRuleId/replace')

  @BranchOf('taxRule', 'taxRuleId')
  @Permission('taxes', 'update')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'Change a rule’s rate, amount or scope: retires it and creates its replacement in one step, leaving posted bills untouched' })
  replaceTaxRule(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('taxRuleId', ParseUUIDPipe) taxRuleId: string,
    @Body() dto: ReplaceTaxRuleDto,
  ): ReturnType<TaxesService['replaceTaxRule']> {
    return this.taxesService.replaceTaxRule(tenantId, taxRuleId, dto, user);
  }
}
