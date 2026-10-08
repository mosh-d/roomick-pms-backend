import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** How far ahead a forecast or a set of recommendations looks — the page shows a fortnight; three months is the most that is useful. */
export class HorizonQueryDto {
  @ApiPropertyOptional({ example: 14, description: '1 to 90 days' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  horizonDays?: number;
}

/** Rate recommendations are per room type: the horizon plus the type they are for. */
export class RateRecommendationsQueryDto extends HorizonQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  roomTypeId!: string;
}
