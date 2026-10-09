import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsISO4217CurrencyCode, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Max, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsDateOnly } from '../../../common/validation/is-date-only.decorator';
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
  @Max(1_000_000_000)
  amount!: number;

  @ApiProperty({ enum: MANUALLY_POSTABLE_CHARGE_TYPES })
  @IsIn(MANUALLY_POSTABLE_CHARGE_TYPES)
  chargeType!: ChargeType;

  @ApiPropertyOptional({ example: '2026-08-27', description: 'Date the service occurred. Defaults to today in the branch timezone.' })
  @IsOptional()
  @IsDateOnly()
  serviceDate?: string;
}

export class RecordPaymentDto {
  @ApiProperty({ example: 20000.0 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
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

  @ApiPropertyOptional({
    example: 'USD',
    description: "Paid in another currency: `amount` is then in this currency, turned into the branch's own at the rate set under Property Config → Currencies.",
  })
  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;
}

/** A deposit before arrival — always a `deposit`, on the stay's own bill. */
export class RecordDepositDto {
  @ApiProperty({ example: 25000.0 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
  amount!: number;

  @ApiProperty({ enum: PaymentMethod, example: 'bank_transfer' })
  @IsIn(Object.values(PaymentMethod))
  method!: PaymentMethod;

  @ApiPropertyOptional({ example: 'TRF-55120' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional({ example: 'USD', description: 'Paid in another currency — see RecordPaymentDto.currency.' })
  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;
}

/** Taking back a payment recorded in error. */
export class VoidPaymentDto {
  @ApiProperty({ example: 'Recorded on the wrong guest’s bill' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/** What one unit of another currency is worth in the branch's own. */
export class SetExchangeRateDto {
  @ApiProperty({ example: 1550.5, description: 'Branch currency per one unit of this currency' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @IsPositive()
  @Max(1_000_000_000)
  rate!: number;
}

export class CreateFolioDto {
  @ApiProperty({ example: 'Company account', description: 'Names this folio apart from the primary one (which has no label).' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label!: string;

  @ApiPropertyOptional({ example: 'Dangote Group travel desk', description: 'Who pays this bill, when it is not the guest.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  payerName?: string;

  @ApiPropertyOptional({ description: "The company this bill goes to — an active corporate account." })
  @IsOptional()
  @IsUUID()
  corporateAccountId?: string;
}

/** Split Billing and Folio Transfer: the charges picked, or every charge on the bill. */
export class SplitFolioDto {
  @ApiProperty({ description: 'Folio to move the charges into. A split stays within one reservation; a transfer can go to any open bill at the property.' })
  @IsUUID()
  targetFolioId!: string;

  @ApiPropertyOptional({
    type: [String],
    description: "Charges to move. Each one's tax lines and correction move with it; a tax line or correction can't be picked without its charge.",
  })
  @ValidateIf((dto: SplitFolioDto) => !dto.transferAll)
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  lineItemIds?: string[];

  @ApiPropertyOptional({ description: 'Move every charge on the bill (its whole balance of charges) instead of picking them.' })
  @IsOptional()
  @IsBoolean()
  transferAll?: boolean;

  @ApiProperty({ example: 'Room charges billed to the company account', description: 'Mandatory — a folio transfer without a stated reason is unauditable.' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}

export class ListTransfersQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateOnly()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsDateOnly()
  to?: string;
}

export class CorrectLineItemDto {
  @ApiProperty({ example: 'Charged in error — guest disputed minibar item', description: 'Mandatory: a correction without a stated reason is unauditable.' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}

/** Opening a settled bill again — a supervisor's call, with the reason on record. */
export class ReopenFolioDto {
  @ApiProperty({ example: 'Minibar found after check-out' })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}
