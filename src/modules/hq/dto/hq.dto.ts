import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';
import { IsDateOnly } from '../../../common/validation/is-date-only.decorator';

const REPORT_TYPES = ['occupancy', 'adr', 'revpar', 'revenue'] as const;
export type CrossPropertyReportType = (typeof REPORT_TYPES)[number];

/** Mirrors `ReportQueryDto`'s own `to`-is-exclusive convention. `branchIds` defaults to every branch when omitted — "all or selected branches" per the reference. */
export class CrossPropertyReportQueryDto {
  @ApiProperty({ enum: REPORT_TYPES })
  @IsIn(REPORT_TYPES)
  type!: CrossPropertyReportType;

  @ApiProperty({ example: '2026-08-01' })
  @IsDateOnly()
  from!: string;

  @ApiProperty({ example: '2026-09-01', description: 'Exclusive' })
  @IsDateOnly()
  to!: string;

  @ApiPropertyOptional({ type: String, description: 'Comma-separated branch ids — every branch under the tenant when omitted' })
  @IsOptional()
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value))
  @IsArray()
  @IsUUID('all', { each: true })
  branchIds?: string[];
}
