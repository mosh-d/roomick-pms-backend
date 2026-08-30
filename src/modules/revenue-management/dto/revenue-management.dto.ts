import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsISO8601, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class CreateAvailabilityRestrictionDto {
  @ApiPropertyOptional({ description: 'Omit to apply to every room type at the branch' })
  @IsOptional()
  @IsUUID()
  roomTypeId?: string;

  @ApiProperty({ example: '2026-12-24' })
  @IsISO8601({ strict: true })
  startDate!: string;

  @ApiProperty({ example: '2027-01-02', description: 'Exclusive' })
  @IsISO8601({ strict: true })
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
  @IsISO8601({ strict: true })
  date!: string;

  @ApiProperty({ example: 15, description: 'Signed percentage — positive raises the rate, negative discounts it' })
  @Type(() => Number)
  @IsInt()
  @Min(-90)
  @Max(200)
  adjustmentPct!: number;
}
