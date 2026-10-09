import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReservationChannel } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { IsDateOnly } from '../../../common/validation/is-date-only.decorator';

export class CreateChannelAllotmentDto {
  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiProperty({ enum: ReservationChannel, example: 'website' })
  @IsIn(Object.values(ReservationChannel))
  channel!: ReservationChannel;

  @ApiProperty({ example: '2026-12-01', description: 'The first night it covers' })
  @IsDateOnly()
  fromDate!: string;

  @ApiProperty({ example: '2026-12-31', description: 'The last night it covers (included)' })
  @IsDateOnly()
  toDate!: string;

  @ApiProperty({ example: 3, description: 'Most rooms of the type the channel may sell a night — 0 closes it' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  rooms!: number;
}

export class UpdateChannelAllotmentDto {
  @ApiPropertyOptional({ example: '2026-12-01' })
  @IsOptional()
  @IsDateOnly()
  fromDate?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsDateOnly()
  toDate?: string;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  rooms?: number;
}
