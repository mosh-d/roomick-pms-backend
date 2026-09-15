import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { toTrimmedLowerCase } from '../../../common/transforms/string.transforms';
import { CreateGuestDto } from '../../guests/dto/guest.dto';

export const SETUP_STYLES = ['theater', 'classroom', 'banquet', 'u_shape'] as const;
export type SetupStyle = (typeof SETUP_STYLES)[number];

// --- Group blocks ---------------------------------------------------------------

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

  @ApiProperty({ example: '2026-10-05', description: "The group's first night" })
  @IsISO8601({ strict: true })
  arrivalDate!: string;

  @ApiProperty({ example: '2026-10-08', description: 'Exclusive — the morning the group leaves' })
  @IsISO8601({ strict: true })
  departureDate!: string;

  @ApiProperty({
    example: '2026-09-21',
    description: 'Rooms stay held for the group through the end of this day (branch time); after it, unbooked rooms go back on sale. On or before arrival.',
  })
  @IsISO8601({ strict: true })
  cutoffDate!: string;

  @ApiPropertyOptional({ example: 'Jane Smith' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional({ example: 'jane@acme.com' })
  @IsOptional()
  @Transform(toTrimmedLowerCase)
  @IsEmail()
  @MaxLength(320)
  contactEmail?: string;

  @ApiPropertyOptional({ example: '0803 123 4567' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;
}

/** A reservation booked "into" a group block. Dates default to the block's own stay; the room type and rate are always the block's. */
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

  @ApiPropertyOptional({ example: '2026-10-05', description: "Defaults to the block's arrival" })
  @IsOptional()
  @IsISO8601({ strict: true })
  checkInDate?: string;

  @ApiPropertyOptional({ example: '2026-10-08', description: "Exclusive. Defaults to the block's departure" })
  @IsOptional()
  @IsISO8601({ strict: true })
  checkOutDate?: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  specialRequests?: string;
}

/** One guest on a rooming list. Blank columns are left out, not sent empty. */
export class RoomingListRowDto {
  @ApiProperty({ example: 'Ngozi Eze' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  guestName!: string;

  @ApiPropertyOptional({ example: 'ngozi@example.com' })
  @IsOptional()
  @Transform(toTrimmedLowerCase)
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ example: '0803 123 4567' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: "Defaults to the block's arrival" })
  @IsOptional()
  @IsISO8601({ strict: true })
  checkInDate?: string;

  @ApiPropertyOptional({ description: "Defaults to the block's departure" })
  @IsOptional()
  @IsISO8601({ strict: true })
  checkOutDate?: string;

  @ApiPropertyOptional({ example: 1, description: 'Defaults to 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  adults?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  children?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  specialRequests?: string;
}

export class RoomingListDto {
  @ApiProperty({ type: [RoomingListRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RoomingListRowDto)
  rows!: RoomingListRowDto[];
}

// --- Event spaces and bookings ------------------------------------------------------

/** Seats per layout. A layout left out falls back to the space's general capacity. */
export class SetupCapacitiesDto {
  @ApiPropertyOptional({ example: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  theater?: number;

  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  classroom?: number;

  @ApiPropertyOptional({ example: 150 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  banquet?: number;

  @ApiPropertyOptional({ example: 40 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  u_shape?: number;
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

  @ApiPropertyOptional({ type: SetupCapacitiesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SetupCapacitiesDto)
  setupCapacities?: SetupCapacitiesDto;
}

export class CateringLineDto {
  @ApiProperty({ example: 'Buffet lunch — jollof, fried rice, grilled chicken' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  description!: string;

  @ApiProperty({ example: 120 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  quantity!: number;

  @ApiProperty({ example: 8500, description: 'Before tax' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100000000)
  unitPrice!: number;
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

  @ApiPropertyOptional({ enum: SETUP_STYLES })
  @IsOptional()
  @IsIn(SETUP_STYLES)
  setupStyle?: SetupStyle;

  @ApiPropertyOptional({ example: 120, description: 'Guaranteed numbers — checked against the space’s capacity for the layout' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  headcount?: number;

  @ApiPropertyOptional({ example: 'jane@acme.com' })
  @IsOptional()
  @Transform(toTrimmedLowerCase)
  @IsEmail()
  @MaxLength(320)
  contactEmail?: string;

  @ApiPropertyOptional({ example: '0803 123 4567' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;

  @ApiPropertyOptional({ type: [CateringLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CateringLineDto)
  catering?: CateringLineDto[];

  @ApiPropertyOptional({ example: 'Projector, 2 wireless mics, stage lighting' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  avRequirements?: string;
}

export class UpdateEventBookingDto extends PartialType(CreateEventBookingDto) {}
