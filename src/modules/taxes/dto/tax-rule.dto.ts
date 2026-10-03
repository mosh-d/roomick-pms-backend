import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayUnique, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ChargeType } from '@prisma/client';

export const TAX_RULE_TYPES = ['percentage', 'fixed'] as const;
export type TaxRuleType = (typeof TAX_RULE_TYPES)[number];

/**
 * A rule is either a percentage of the charge (`rate`, 0.075 = 7.5%) or a
 * fixed amount once per charge (`fixedAmount`, in the branch's currency), and
 * either added on top of the price or already included in it (`inclusive`).
 * Which fields are required depends on `type`, so that check lives in
 * `TaxesService.assertShape` rather than in decorators.
 */
export class CreateTaxRuleDto {
  @ApiProperty({ example: 'VAT' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ enum: TAX_RULE_TYPES, default: 'percentage' })
  @IsOptional()
  @IsIn(TAX_RULE_TYPES)
  type?: TaxRuleType;

  @ApiPropertyOptional({ example: 0.075, description: 'Percentage rules: 0.075 = 7.5%. Leave out for a fixed rule.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  rate?: number;

  @ApiPropertyOptional({ example: 500, description: 'Fixed rules: the amount added to each charge — each night, on rooms.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(10_000_000)
  fixedAmount?: number;

  @ApiPropertyOptional({
    default: false,
    description: 'true: the tax is already inside the price (VAT-inclusive rates) and is taken out of it; false: it is added on top.',
  })
  @IsOptional()
  @IsBoolean()
  inclusive?: boolean;

  @ApiPropertyOptional({
    enum: ChargeType,
    isArray: true,
    description: 'Charge types this rule taxes. Omit or pass [] to apply to ALL charge types.',
  })
  @IsOptional()
  @ArrayUnique()
  @IsIn(Object.values(ChargeType), { each: true })
  appliesToChargeTypes?: ChargeType[];

  @ApiPropertyOptional({ example: 'Lagos State' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jurisdiction?: string;
}

export class UpdateTaxRuleDto {
  @ApiPropertyOptional({ description: 'Set false to retire a rule — rules are never deleted, so historical line items keep resolving their rule name.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Changing a rule's rate, amount or scope. The old rule is retired and a new
 * one takes its place in one transaction — bills already posted keep pointing
 * at the old rule, so their tax breakdown still shows the rate they were
 * actually charged at.
 */
export class ReplaceTaxRuleDto extends CreateTaxRuleDto {}
