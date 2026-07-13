import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO31661Alpha2,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // "14:00"

export class AddressDto {
  @ApiProperty({ example: '1 Marina Road' })
  @IsString()
  @MaxLength(300)
  street!: string;

  @ApiProperty({ example: 'Lagos' })
  @IsString()
  @MaxLength(100)
  city!: string;

  @ApiPropertyOptional({ example: 'Lagos' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @ApiProperty({ example: 'NG', description: 'ISO 3166-1 alpha-2' })
  @IsISO31661Alpha2()
  country!: string;

  @ApiPropertyOptional({ example: '101001' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  zip?: string;
}

export class CreateBranchDto {
  @ApiProperty({ example: 'Acme Hotel Lagos' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ type: AddressDto })
  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;

  @ApiProperty({ example: 'Africa/Lagos', description: 'IANA timezone — night audit depends on it' })
  @IsString()
  @MaxLength(50)
  timezone!: string;

  @ApiProperty({ example: 'NGN', description: 'ISO 4217' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO 4217 code' })
  currency!: string;

  @ApiPropertyOptional({ example: '14:00', description: 'HH:mm — defaults to 14:00' })
  @IsOptional()
  @Matches(TIME_RE, { message: 'checkInTime must be HH:mm' })
  checkInTime?: string;

  @ApiPropertyOptional({ example: '11:00', description: 'HH:mm — defaults to 11:00' })
  @IsOptional()
  @Matches(TIME_RE, { message: 'checkOutTime must be HH:mm' })
  checkOutTime?: string;

  @ApiPropertyOptional({ enum: ['hotel', 'resort', 'motel', 'boutique', 'hostel'] })
  @IsOptional()
  @IsIn(['hotel', 'resort', 'motel', 'boutique', 'hostel'])
  category?: string;

  @ApiPropertyOptional({ description: 'Branch policies (overrides brand defaults; merged at read)' })
  @IsOptional()
  @IsObject()
  policies?: Record<string, unknown>;
}

export class UpdateBranchDto extends PartialType(CreateBranchDto) {}

export class NoShowPolicyDto {
  @ApiPropertyOptional({ example: '18:00', description: 'HH:mm cutoff in branch timezone' })
  @IsOptional()
  @Matches(TIME_RE)
  cutoffTime?: string;

  @ApiPropertyOptional({ enum: ['first_night', 'full_stay', 'flat_fee', 'none'] })
  @IsOptional()
  @IsIn(['first_night', 'full_stay', 'flat_fee', 'none'])
  defaultPenalty?: string;

  @ApiPropertyOptional({ description: 'Auto-mark no-shows during night audit' })
  @IsOptional()
  autoMark?: boolean;

  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  notifyMinutesBefore?: number;
}

export class RegCardTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @ApiPropertyOptional({ example: 'No smoking. Checkout 11:00.' })
  @IsOptional()
  @IsString()
  houseRules?: string;

  @ApiPropertyOptional({ type: [String], example: ['name', 'idNumber', 'signature'] })
  @IsOptional()
  requiredFields?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  showRate?: boolean;

  @ApiPropertyOptional({ example: 'en' })
  @IsOptional()
  @IsString()
  language?: string;
}
