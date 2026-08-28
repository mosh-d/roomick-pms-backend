import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsISO8601, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
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

export const ID_DOC_TYPES = ['passport', 'national_id', 'drivers_license'] as const;
export type IdDocType = (typeof ID_DOC_TYPES)[number];

/**
 * The dedicated pass `CreateGuestDto`'s own header comment named — captured
 * at check-in (`CheckInDto.idDocument` / `WalkInReservationDto.idDocument`),
 * not at guest creation, matching how a hotel actually collects it (a
 * reservation is booked with just name/email; the physical ID shows up when
 * the guest arrives). `idDocNumber` is encrypted (`EncryptionService`)
 * before it ever reaches the DB; `photoBase64` follows the same
 * base64-in-JSON convention `RegistrationCard.signatureData` already
 * established in this codebase, not a separate pre-signed-upload flow.
 */
export class RecordIdDocumentDto {
  @ApiProperty({ enum: ID_DOC_TYPES })
  @IsIn(ID_DOC_TYPES)
  idDocType!: IdDocType;

  @ApiProperty({ example: 'P1234567', description: 'Plaintext in transit; encrypted at rest by the service, never logged or stored as-is' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  idDocNumber!: string;

  @ApiPropertyOptional({ example: '2030-01-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  idDocExpiryDate?: string;

  @ApiPropertyOptional({ example: 'NG', description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  nationality?: string;

  @ApiPropertyOptional({ description: 'Base64-encoded photo of the document, no "data:" URI prefix' })
  @IsOptional()
  @IsString()
  @MaxLength(4_000_000)
  photoBase64?: string;
}
