import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsISO8601, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class UpdateOverbookingConfigDto {
  @ApiPropertyOptional({ description: 'Scope to one room type; omit = all types' })
  @IsOptional()
  @IsUUID()
  roomTypeId?: string;

  @ApiPropertyOptional({ description: 'Branch master switch (spec §4.2 allowOverbooking)' })
  @IsOptional()
  @IsBoolean()
  globalEnabled?: boolean;

  @ApiPropertyOptional({ example: 10.0, description: '10.00 = allow 10% over capacity' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  maxOverbookPct?: number;

  @ApiPropertyOptional({ example: 80.0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  alertAtPct?: number;

  @ApiPropertyOptional({ example: '2026-12-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  validFrom?: string;

  @ApiPropertyOptional({ example: '2027-01-15' })
  @IsOptional()
  @IsISO8601({ strict: true })
  validTo?: string;
}
