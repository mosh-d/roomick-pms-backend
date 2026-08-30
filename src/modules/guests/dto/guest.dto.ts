import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsEmail, IsIn, IsISO8601, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
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

/** Matches the architecture map's own PATCH payload shape exactly (`{bedType, floor, view, pillow, temp}` plus `dietaryRestrictions[]`) — `GuestProfile.preferences` is a free-form JSON blob, but the Guest Profile page always writes this specific shape. */
export class GuestPreferencesDto {
  @ApiPropertyOptional({ example: 'king' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  bedType?: string;

  @ApiPropertyOptional({ example: 'high' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  floor?: string;

  @ApiPropertyOptional({ example: 'ocean' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  view?: string;

  @ApiPropertyOptional({ example: 'firm' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  pillow?: string;

  @ApiPropertyOptional({ example: 'cool' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  temp?: string;

  @ApiPropertyOptional({ type: [String], example: ['vegetarian', 'no shellfish'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dietaryRestrictions?: string[];
}

/**
 * The CRM's own editor — every field optional, same "change just one
 * thing" shape this codebase already uses for `UpdateBranchDto`/
 * `UpdateRoomTypeDto`. Deliberately excludes the legacy `notes` column
 * (superseded by the append-only `GuestNote` feed, `AddGuestNoteDto`
 * below) and every ID-document field (still `RecordIdDocumentDto`'s own
 * job, captured at check-in).
 */
export class UpdateGuestDto {
  @ApiPropertyOptional({ example: 'John Doe' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

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

  @ApiPropertyOptional({ type: GuestPreferencesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GuestPreferencesDto)
  preferences?: GuestPreferencesDto;

  @ApiPropertyOptional({ example: 2, description: '0-5' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5)
  vipLevel?: number;

  @ApiPropertyOptional({ type: [String], example: ['corporate', 'repeat guest'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ example: 'Gold' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  loyaltyTier?: string;

  @ApiPropertyOptional({ example: 1500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  loyaltyPoints?: number;
}

export class AddGuestNoteDto {
  @ApiProperty({ example: 'Requested extra pillows for the third night in a row — worth flagging to housekeeping.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}
