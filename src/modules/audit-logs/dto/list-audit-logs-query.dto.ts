import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { IsDateOnly } from '../../../common/validation/is-date-only.decorator';

/**
 * Backs the Security & Roles "Audit Log Viewer" (architecture map's own
 * `GET /audit-logs?branchId=&userId=&action=&from=&to=&page=&limit=`).
 * Every field optional — the reference's own default view is "everything,
 * newest first," filters narrow from there.
 */
export class ListAuditLogsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ example: 'reservation.check_in', description: 'Substring match, case-insensitive' })
  @IsOptional()
  @MaxLength(100)
  action?: string;

  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsDateOnly() // a full timestamp passed, became an Invalid Date in the query and a 500
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @IsDateOnly()
  to?: string;

  @ApiPropertyOptional({ example: 'reservation', description: 'The kind of record — everything that happened to reservations, folios, guests…' })
  @IsOptional()
  @MaxLength(50)
  entityType?: string;

  @ApiPropertyOptional({ description: 'One record’s whole history' })
  @IsOptional()
  @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}
