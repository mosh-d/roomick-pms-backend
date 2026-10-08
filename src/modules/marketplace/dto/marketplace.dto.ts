import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import { IsDateOnly } from '../../../common/validation/is-date-only.decorator';

/**
 * Loose on purpose, strict at the point of use: each connector parses its own
 * settings (`parseAccountingConfig`, `parseReviewRequestConfig`) on every
 * write and every read, so one validator decides what's acceptable whether
 * the settings arrived just now or were stored months ago.
 */
export class SaveConnectionDto {
  @ApiProperty({ description: 'The connector’s own settings — an account map for accounting, review links and a message for review requests' })
  @IsObject()
  config!: Record<string, unknown>;
}

export class ExportRangeQueryDto {
  @ApiProperty({ example: '2026-09-01', description: 'First day, inclusive (the property’s own calendar)' })
  @IsDateOnly()
  from!: string;

  @ApiProperty({ example: '2026-09-15', description: 'Last day, inclusive' })
  @IsDateOnly()
  to!: string;
}
