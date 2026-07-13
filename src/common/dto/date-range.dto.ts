import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601 } from 'class-validator';

/**
 * Calendar-date range (YYYY-MM-DD). Interpretation is always in the branch
 * timezone — never server time (spec §6).
 */
export class DateRangeDto {
  @ApiProperty({ example: '2026-07-01', description: 'Inclusive start date (YYYY-MM-DD)' })
  @IsISO8601({ strict: true })
  from!: string;

  @ApiProperty({ example: '2026-07-31', description: 'Inclusive end date (YYYY-MM-DD)' })
  @IsISO8601({ strict: true })
  to!: string;
}
