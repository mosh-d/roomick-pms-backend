import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ChargeType } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PACKAGE_BASES, PackageBasis } from '../package-pricing';

/** What a package can post as — never tax, a correction or a room night. */
const PACKAGE_CHARGE_TYPES: ChargeType[] = ['fnb', 'spa', 'laundry', 'minibar', 'transport', 'misc'];

export class CreatePackageDto {
  @ApiProperty({ example: 'Breakfast for two' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: 'Full English or local breakfast in the restaurant, 7–10am' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: 12000, description: 'Before tax, per the basis' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000)
  price!: number;

  @ApiProperty({ enum: PACKAGE_BASES, description: 'A night, the whole stay once, or each guest each night' })
  @IsIn(PACKAGE_BASES)
  basis!: PackageBasis;

  @ApiProperty({ enum: PACKAGE_CHARGE_TYPES, description: 'What it posts as on the bill — and so how it is taxed and reported' })
  @IsIn(PACKAGE_CHARGE_TYPES)
  chargeType!: ChargeType;

  @ApiPropertyOptional({ type: [String], description: 'The room types it comes with. Empty or left out = all.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  roomTypeIds?: string[];

  @ApiPropertyOptional({ description: 'Offered on the booking page. Defaults to yes.' })
  @IsOptional()
  @IsBoolean()
  showOnline?: boolean;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class UpdatePackageDto extends PartialType(CreatePackageDto) {
  @ApiPropertyOptional({ description: 'False takes it off sale; stays that have it keep it' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** The packages a stay has — sent whole: these, and only these. */
export class SetStayPackagesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  packageIds!: string[];
}
