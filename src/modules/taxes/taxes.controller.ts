import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { CreateTaxRuleDto, UpdateTaxRuleDto } from './dto/tax-rule.dto';
import { TaxesService } from './taxes.service';

@ApiTags('taxes')
@ApiBearerAuth()
@Controller()
export class TaxesController {
  constructor(private readonly taxesService: TaxesService) {}

  @Post('branches/:branchId/tax-rules')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'Create a tax rule for a branch (percentage of charge; empty appliesToChargeTypes = all)' })
  createTaxRule(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateTaxRuleDto,
  ): ReturnType<TaxesService['createTaxRule']> {
    return this.taxesService.createTaxRule(tenantId, branchId, dto);
  }

  @Get('branches/:branchId/tax-rules')
  @ApiOperation({ summary: 'List a branch tax rules (active and retired)' })
  listTaxRules(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<TaxesService['listTaxRules']> {
    return this.taxesService.listTaxRules(tenantId, branchId);
  }

  @Patch('tax-rules/:taxRuleId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'Retire or reinstate a tax rule (isActive) — rules are never deleted' })
  updateTaxRule(
    @CurrentTenant() tenantId: string,
    @Param('taxRuleId', ParseUUIDPipe) taxRuleId: string,
    @Body() dto: UpdateTaxRuleDto,
  ): ReturnType<TaxesService['updateTaxRule']> {
    return this.taxesService.updateTaxRule(tenantId, taxRuleId, dto);
  }
}
