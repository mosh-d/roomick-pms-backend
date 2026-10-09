import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { HousekeepingStatus } from '@prisma/client';
import { IsDateOnly } from '../../../common/validation/is-date-only.decorator';

export class CreateTaskDto {
  @ApiProperty()
  @IsUUID()
  roomId!: string;

  @ApiPropertyOptional({ example: 1, description: '1 = urgent, 3 = normal (default)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  priority?: number;

  @ApiPropertyOptional({ example: 'Guest requested extra towels while cleaning' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ enum: ['clean', 'turndown'], description: 'A clean (the default), or an evening turndown — which leaves the room as clean as it is' })
  @IsOptional()
  @IsIn(['clean', 'turndown'])
  kind?: 'clean' | 'turndown';
}

export class ListTasksQueryDto {
  @ApiPropertyOptional({ enum: HousekeepingStatus })
  @IsOptional()
  @IsIn(Object.values(HousekeepingStatus))
  status?: HousekeepingStatus;

  @ApiPropertyOptional({ description: 'Pass the caller\'s own id to see "my assigned rooms" — Task Board\'s own filter, not enforced server-side beyond a valid UUID' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'Tasks dated from this day' })
  @IsOptional()
  @IsDateOnly()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-08', description: 'Tasks dated up to and including this day' })
  @IsOptional()
  @IsDateOnly()
  to?: string;

  @ApiPropertyOptional({ example: 500, description: 'At most 1000, newest first — the board used to load every task since opening day' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

export class AssignTaskDto {
  @ApiProperty()
  @IsUUID()
  assigneeId!: string;
}

export class ReportIssueDto {
  @ApiProperty({ example: 'Bathroom', description: 'Free-text area of the room the issue is in — no fixed enum in the reference beyond example values' })
  @IsString()
  @MaxLength(100)
  areaOfIssue!: string;

  @ApiProperty({ example: 'Leaking tap, needs a plumber' })
  @IsString()
  @MaxLength(1000)
  description!: string;
}
