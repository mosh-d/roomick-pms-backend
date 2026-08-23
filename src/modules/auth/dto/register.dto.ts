import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  IsStrongPassword,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { toTrimmedLowerCase } from '../../../common/transforms/string.transforms';

export class RegisterDto {
  @ApiProperty({
    example: 'acme',
    description:
      'Short, unique account id — used to resolve which tenant a login belongs to (see LoginDto). ' +
      'Not currently a real subdomain/URL; no per-tenant routing is wired up.',
  })
  @Transform(toTrimmedLowerCase)
  @IsString()
  @MinLength(3)
  @MaxLength(63)
  @Matches(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    message: 'subdomain must be lowercase alphanumeric with inner hyphens only',
  })
  subdomain!: string;

  @ApiProperty({ example: 'Acme Hotels Group' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  groupName!: string;

  @ApiProperty({ example: 'Ada Obi', description: 'Owner account full name' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'owner@acmehotels.com' })
  @Transform(toTrimmedLowerCase)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'Str0ngPass!', minLength: 8 })
  @IsStrongPassword(
    { minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 0 },
    { message: 'password must be ≥8 chars with upper, lower and a number' },
  )
  password!: string;

  @ApiPropertyOptional({ example: '+2348012345678' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({
    example: 'NG',
    description:
      'ISO 3166-1 alpha-2. Reporting only for now (which countries are onboarding) — not consumed by ' +
      'any business logic yet.',
  })
  @IsOptional()
  @IsISO31661Alpha2()
  country?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Self-serve "try it" signup, not a sales-assisted trial — the resulting tenant auto-expires ' +
      '30 days from creation (see AuthService.register) and can also be deleted early via ' +
      'DELETE /tenants/me. Real signups must never set this.',
  })
  @IsOptional()
  @IsBoolean()
  isDemo?: boolean;
}
