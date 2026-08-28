import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { HousekeepingStatus } from '@prisma/client';

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
