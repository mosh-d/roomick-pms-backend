import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayUnique, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdjustmentType, ChargeType } from '@prisma/client';

export class CreateTaxRuleDto {
  @ApiProperty({ example: 'VAT' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 0.075, description: '0.075 = 7.5%. Stored as Decimal(6,4).' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  rate!: number;

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

/** `AdjustmentType` is imported so the enum stays referenced here — `type` is fixed to `percentage` this pass (a fixed-amount tax rule has no meaningful "taxable base" to report on, and the reference only shows percentages). */
export const DEFAULT_TAX_RULE_TYPE: AdjustmentType = 'percentage';
