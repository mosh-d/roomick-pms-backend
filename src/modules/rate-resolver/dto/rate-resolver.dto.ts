import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdjustmentType, RateType } from '@prisma/client';

export class CalculateRateDto {
  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsISO8601({ strict: true })
  checkInDate!: string;

  @ApiProperty({ example: '2026-09-04', description: 'Exclusive' })
  @IsISO8601({ strict: true })
  checkOutDate!: string;

  @ApiPropertyOptional({ description: 'Matches a promotional RatePlan.promoCode' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  promoCode?: string;

  @ApiPropertyOptional({ description: "Matches the guest's corporate account, which may point to a negotiated RatePlan" })
  @IsOptional()
  @IsUUID()
  corporateAccountId?: string;
}

/**
 * `cascadeTier` is NOT client-supplied — it's fully determined by `type`
 * (see `CASCADE_TIER_BY_TYPE` in the service), matching the schema's own
 * comment ("1=base 2=seasonal 3=weekend 4=corporate; ignored when
 * isOverride"). `adjustmentType` is required for the four cascade types
 * (they adjust a running total) and forbidden for negotiated/promotional
 * (they replace it outright — `amount` is an absolute nightly rate for
 * those two, not a delta), enforced in the service rather than here, same
 * "DTO stays permissive" split `ReservationsService.resolveGuestInput` uses.
 */
export class CreateRatePlanDto {
  @ApiPropertyOptional({ description: 'Omit to apply to every room type at the branch' })
  @IsOptional()
  @IsUUID()
  roomTypeId?: string;

  @ApiProperty({ example: 'Summer Weekend' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiProperty({ enum: RateType })
  @IsIn(Object.values(RateType))
  type!: RateType;

  @ApiProperty({ example: 15, description: 'Cascade types: a delta (fixed amount or %). Override types (negotiated/promotional): the absolute nightly rate.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  amount!: number;

  @ApiPropertyOptional({ enum: AdjustmentType, description: 'Required for base/seasonal/weekend/corporate; omit for negotiated/promotional' })
  @IsOptional()
  @IsIn(Object.values(AdjustmentType))
  adjustmentType?: AdjustmentType;

  @ApiPropertyOptional({ example: '2026-12-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  validFrom?: string;

  @ApiPropertyOptional({ example: '2027-01-15' })
  @IsOptional()
  @IsISO8601({ strict: true })
  validTo?: string;

  @ApiPropertyOptional({ example: 2, description: 'Minimum length of stay (nights) for this plan to apply' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  minLOS?: number;

  @ApiPropertyOptional({ description: 'Required when type = promotional; ignored otherwise' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  promoCode?: string;
}

export class UpdateRatePlanDto {
  @ApiPropertyOptional({ description: 'Set false to retire a plan — never deleted, so historical RateAuditLog rows keep resolving their plan name' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
