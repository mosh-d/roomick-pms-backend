import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsDateOnly } from '../../../common/validation/is-date-only.decorator';

export class CreateAvailabilityRestrictionDto {
  @ApiPropertyOptional({ description: 'Omit to apply to every room type at the branch' })
  @IsOptional()
  @IsUUID()
  roomTypeId?: string;

  @ApiProperty({ example: '2026-12-24' })
  @IsDateOnly()
  startDate!: string;

  @ApiProperty({ example: '2027-01-02', description: 'Exclusive' })
  @IsDateOnly()
  endDate!: string;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  minLOS?: number;

  @ApiPropertyOptional({ example: 14 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  maxLOS?: number;

  @ApiPropertyOptional({ description: 'No arrivals allowed on any date in this range' })
  @IsOptional()
  @IsBoolean()
  closedToArrival?: boolean;

  @ApiPropertyOptional({ description: 'No bookings at all for any date in this range' })
  @IsOptional()
  @IsBoolean()
  stopSell?: boolean;
}

export class ApproveRateRecommendationDto {
  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiProperty({ example: '2026-10-15' })
  @IsDateOnly()
  date!: string;

  @ApiProperty({ example: 15, description: 'Signed percentage — positive raises the rate, negative discounts it' })
  @Type(() => Number)
  @IsInt()
  @Min(-90)
  @Max(200)
  adjustmentPct!: number;
}

// --- Comp set ---------------------------------------------------------------------

export class CreateCompetitorDto {
  @ApiProperty({ example: 'Eko Signature Hotel' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;
}

export class UpdateCompetitorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ description: 'false takes the hotel out of the comp set; its rates are kept' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** One competitor's nightly rate across a run of dates, for one of our room types. */
export class SetCompetitorRatesDto {
  @ApiProperty()
  @IsUUID()
  competitorId!: string;

  @ApiProperty({ description: 'Our room type this competitor room is compared against' })
  @IsUUID()
  roomTypeId!: string;

  @ApiProperty({ example: '2026-10-01' })
  @IsDateOnly()
  fromDate!: string;

  @ApiProperty({ example: '2026-10-07', description: 'Inclusive — the last night the rate applies to' })
  @IsDateOnly()
  throughDate!: string;

  @ApiPropertyOptional({ example: 52000, description: 'Their nightly rate. Required unless clearing.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100000000)
  rate?: number;

  @ApiPropertyOptional({ description: 'true removes their rates for these dates instead' })
  @IsOptional()
  @IsBoolean()
  clear?: boolean;
}

export class CompSetQueryDto {
  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'First night shown; defaults to today at the branch' })
  @IsOptional()
  @IsDateOnly()
  from?: string;

  @ApiPropertyOptional({ example: 14 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  days?: number;

  @ApiPropertyOptional({ example: 10, description: 'How far from the market median, in percent, before a night is flagged' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  thresholdPct?: number;
}
