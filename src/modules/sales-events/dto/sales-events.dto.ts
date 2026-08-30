import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { CreateGuestDto } from '../../guests/dto/guest.dto';

export class CreateGroupBlockDto {
  @ApiProperty({ example: 'Acme Corp Annual Conference' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiProperty({ example: 20, description: 'Rooms allotted to this block' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  blockSize!: number;

  @ApiProperty({ example: 45000, description: 'Absolute nightly rate applied to every reservation booked into this block' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  blockRate!: number;

  @ApiProperty({ example: '2026-10-01', description: 'After this date the block should no longer be booked into — enforced by front-desk judgment, not an automatic release job' })
  @IsISO8601({ strict: true })
  cutoffDate!: string;
}

/** A reservation booked "into" a group block — mirrors `CreateReservationDto`'s own guest/date/party-size fields exactly, minus `roomTypeId` (the block's own) and any rate input (the block's own `blockRate` always wins). */
export class BookIntoGroupBlockDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  guestId?: string;

  @ApiPropertyOptional({ type: CreateGuestDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateGuestDto)
  guest?: CreateGuestDto;

  @ApiProperty({ example: '2026-10-05' })
  @IsISO8601({ strict: true })
  checkInDate!: string;

  @ApiProperty({ example: '2026-10-08', description: 'Exclusive' })
  @IsISO8601({ strict: true })
  checkOutDate!: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  adults!: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  children?: number;
}

export class CreateEventSpaceDto {
  @ApiProperty({ example: 'Grand Ballroom' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ enum: ['meeting_room', 'ballroom', 'outdoor'] })
  @IsIn(['meeting_room', 'ballroom', 'outdoor'])
  category!: string;

  @ApiProperty({ example: 150 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  capacity!: number;
}

export class CreateEventBookingDto {
  @ApiProperty({ example: 'Acme Corp Product Launch' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ example: '2026-10-05T09:00:00.000Z' })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({ example: '2026-10-05T17:00:00.000Z' })
  @IsISO8601()
  endsAt!: string;

  @ApiPropertyOptional({ example: 'Jane Smith, Acme Corp' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
