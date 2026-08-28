import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';

const GROUP_BY_VALUES = ['day', 'week', 'month'] as const;
export type ReportGroupBy = (typeof GROUP_BY_VALUES)[number];

/** Shared by every report — `to` is exclusive, matching this codebase's date-range convention everywhere else (availability, exposure). */
export class ReportQueryDto {
  @ApiProperty({ example: '2026-08-01' })
  @IsISO8601({ strict: true })
  from!: string;

  @ApiProperty({ example: '2026-09-01', description: 'Exclusive' })
  @IsISO8601({ strict: true })
  to!: string;

  @ApiPropertyOptional({ enum: GROUP_BY_VALUES, description: 'Occupancy report only — defaults to "day"' })
  @IsOptional()
  @IsIn(GROUP_BY_VALUES)
  groupBy?: ReportGroupBy;

  @ApiPropertyOptional({ description: 'Restrict to one room type — all room types otherwise' })
  @IsOptional()
  @IsUUID()
  roomTypeId?: string;
}
