import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';

const REPORT_TYPES = ['occupancy', 'adr', 'revpar', 'revenue'] as const;
export type CrossPropertyReportType = (typeof REPORT_TYPES)[number];

/** Mirrors `ReportQueryDto`'s own `to`-is-exclusive convention. `branchIds` defaults to every branch when omitted — "all or selected branches" per the reference. */
export class CrossPropertyReportQueryDto {
  @ApiProperty({ enum: REPORT_TYPES })
  @IsIn(REPORT_TYPES)
  type!: CrossPropertyReportType;

  @ApiProperty({ example: '2026-08-01' })
  @IsISO8601({ strict: true })
  from!: string;

  @ApiProperty({ example: '2026-09-01', description: 'Exclusive' })
  @IsISO8601({ strict: true })
  to!: string;

  @ApiPropertyOptional({ description: 'Comma-separated branch ids — every branch under the tenant when omitted' })
  @IsOptional()
  @IsString()
  branchIds?: string;
}
