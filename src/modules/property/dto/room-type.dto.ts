import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { uploadedPhotoKey } from '../room-photos';

/** The most photos a room type shows. */
export const MAX_ROOM_PHOTOS = 20;

export class CapacityDto {
  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  adults!: number;

  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  children!: number;
}

export class CreateRoomTypeDto {
  @ApiProperty({ example: 'Deluxe King' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    example: '72000.00',
    description:
      'Base nightly rate — the Rate Resolver cascade starting point. Lives HERE, not in rate_plans (spec §3.2). Always > 0.',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  @Max(1_000_000_000)
  baseRate!: number;

  @ApiProperty({ type: CapacityDto })
  @ValidateNested()
  @Type(() => CapacityDto)
  capacity!: CapacityDto;

  @ApiPropertyOptional({ example: 'king' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  bedType?: string;

  @ApiPropertyOptional({ example: 32.5 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @IsPositive()
  sizeM2?: number;

  @ApiPropertyOptional({ type: [String], example: ['wifi', 'ac', 'minibar'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  amenities?: string[];

  @ApiPropertyOptional({ type: [String], description: 'https addresses, or photos uploaded here — shown to guests on the public booking page' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ROOM_PHOTOS)
  // A pasted link must be https; a photo uploaded here is this API's own address, http in local development.
  @ValidateIf((_o, value: unknown) => !(Array.isArray(value) && value.every((url) => typeof url === 'string' && uploadedPhotoKey(url) !== null)))
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true, message: 'Each photo must be an https:// address' })
  @MaxLength(2048, { each: true })
  photoUrls?: string[];

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({ example: 2, nullable: true, description: 'Adults the nightly rate covers. Null = every adult the room holds (no extra-adult charge).' })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  adultsIncluded?: number | null;

  @ApiPropertyOptional({ example: 10000, nullable: true, description: 'Added a night for each adult beyond those included' })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000)
  extraAdultRate?: number | null;

  @ApiPropertyOptional({ example: 1, description: 'Children who stay free' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  childrenIncluded?: number;

  @ApiPropertyOptional({ example: 5000, nullable: true, description: 'Added a night for each child beyond those who stay free. Null = children stay free.' })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000)
  childRate?: number | null;

  @ApiPropertyOptional({ example: 30000, nullable: true, description: 'The price of the room for the day (no night). Null = not sold for day use.' })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
  dayUseRate?: number | null;
}

/** Property Config's own room-type editor — every field optional, same "change just one thing" shape `UpdateBranchDto`/`UpdateBrandDto` already use. */
export class UpdateRoomTypeDto extends PartialType(CreateRoomTypeDto) {}
