import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { toTrimmedLowerCase } from '../../../common/transforms/string.transforms';

/**
 * `GuestProfile` has ID-document capture (`idDocType`/`idDocNumber`/
 * `idDocUrl`/`idDocExpiryDate`), nationality, loyalty, and preference
 * fields — all deliberately excluded here. That's a compliance-sensitive
 * feature (`idDocNumber` is meant to be app-layer AES-256-GCM encrypted per
 * the schema's own comment) that deserves its own dedicated pass, not
 * something bolted onto a reservations MVP. Every response shape in this
 * module also excludes those fields, not just the write side, so nothing
 * here needs to change once that pass lands.
 */
export class CreateGuestDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: 'john@doe.com' })
  @IsOptional()
  @Transform(toTrimmedLowerCase)
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ example: '090 345 6794' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ example: 'Allergic to fish. Must stay on 1st floor.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
