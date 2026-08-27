import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsNumber, IsOptional, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';
import { ChargeType, PaymentMethod, PaymentPurpose } from '@prisma/client';

/** `tax` and `correction` are excluded: tax rows are written by the engine, corrections by `POST /line-items/:id/correct`. Neither is a thing a human posts directly. */
const MANUALLY_POSTABLE_CHARGE_TYPES: ChargeType[] = ['room', 'fnb', 'spa', 'laundry', 'minibar', 'transport', 'penalty', 'misc'];

export class PostChargeDto {
  @ApiProperty({ example: 'Heineken x2 (Bar)' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  description!: string;

  @ApiProperty({ example: 5000.0, description: 'Must be > 0 — a credit is posted via /line-items/:id/correct, never as a negative charge.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({ enum: MANUALLY_POSTABLE_CHARGE_TYPES })
  @IsIn(MANUALLY_POSTABLE_CHARGE_TYPES)
  chargeType!: ChargeType;

  @ApiPropertyOptional({ example: '2026-08-27', description: 'Date the service occurred. Defaults to today in the branch timezone.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  serviceDate?: string;
}

export class RecordPaymentDto {
  @ApiProperty({ example: 20000.0 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({ enum: PaymentMethod, example: 'card' })
  @IsIn(Object.values(PaymentMethod))
  method!: PaymentMethod;

  @ApiPropertyOptional({ enum: PaymentPurpose, description: 'Defaults to "payment". Deposits never appear as line items (spec §4.5).' })
  @IsOptional()
  @IsIn(Object.values(PaymentPurpose))
  paymentPurpose?: PaymentPurpose;

  @ApiPropertyOptional({ example: '6543180', description: 'Card auth code, bank ref, etc.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;
}

export class CorrectLineItemDto {
  @ApiProperty({ example: 'Charged in error — guest disputed minibar item', description: 'Mandatory: a correction without a stated reason is unauditable.' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}
