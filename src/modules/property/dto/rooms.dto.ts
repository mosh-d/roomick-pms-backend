import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { BlockReason, CleanlinessStatus, HeldStatus, OccupancyStatus } from '@prisma/client';

export class RoomRangeDto {
  @ApiProperty({ example: 301 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from!: number;

  @ApiProperty({ example: 320 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99999)
  to!: number;

  @ApiPropertyOptional({ example: 'A-', description: 'Optional prefix: A-301 … A-320' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  prefix?: string;
}

export class BulkCreateRoomsDto {
  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiPropertyOptional({
    description:
      'Floor to attach rooms to. Omit in "Rooms Only" onboarding — a hidden default building+floor is auto-created (spec §1.1).',
  })
  @IsOptional()
  @IsUUID()
  floorId?: string;

  @ApiPropertyOptional({ type: RoomRangeDto, description: 'Numeric range, e.g. 301–320' })
  @IsOptional()
  @ValidateNested()
  @Type(() => RoomRangeDto)
  range?: RoomRangeDto;

  @ApiPropertyOptional({ type: [String], example: ['PH-A', 'PH-B'], description: 'Explicit numbers' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  numbers?: string[];

  @ApiPropertyOptional({ example: 'sea' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  view?: string;
}

export class ChangeRoomStatusDto {
  @ApiPropertyOptional({ enum: OccupancyStatus, description: 'Manual correction — manager only' })
  @IsOptional()
  @IsIn(Object.values(OccupancyStatus))
  occupancyStatus?: OccupancyStatus;

  @ApiPropertyOptional({
    enum: CleanlinessStatus,
    description: 'dirty → cleaning → clean → inspected (inspected: supervisor only)',
  })
  @IsOptional()
  @IsIn(Object.values(CleanlinessStatus))
  cleanlinessStatus?: CleanlinessStatus;

  @ApiPropertyOptional({
    enum: [...Object.values(HeldStatus), null],
    description: 'out_of_order | blocked | null (null releases the hold) — manager only',
  })
  @ValidateIf((o: ChangeRoomStatusDto) => o.heldStatus !== undefined && o.heldStatus !== null)
  @IsIn(Object.values(HeldStatus))
  heldStatus?: HeldStatus | null;

  @ApiPropertyOptional({ example: 'Deep clean after water leak' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class CreateRoomBlockDto {
  @ApiProperty({ enum: BlockReason, example: 'maintenance' })
  @IsIn(Object.values(BlockReason))
  reason!: BlockReason;

  @ApiProperty({ example: '2026-08-01' })
  @IsISO8601({ strict: true })
  fromDate!: string;

  @ApiProperty({ example: '2026-08-05' })
  @IsISO8601({ strict: true })
  toDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
