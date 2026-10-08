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
  ValidateNested,
} from 'class-validator';

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

  @ApiPropertyOptional({ type: [String], description: 'https addresses — shown to guests on the public booking page' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true, message: 'Each photo must be an https:// address' })
  @MaxLength(2048, { each: true })
  photoUrls?: string[];

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

/** Property Config's own room-type editor — every field optional, same "change just one thing" shape `UpdateBranchDto`/`UpdateBrandDto` already use. */
export class UpdateRoomTypeDto extends PartialType(CreateRoomTypeDto) {}
