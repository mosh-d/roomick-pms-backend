import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Max, Min } from 'class-validator';

export class PublicAvailabilityQueryDto {
  @ApiProperty({ example: '2026-10-01' })
  @IsISO8601({ strict: true })
  from!: string;

  @ApiProperty({ example: '2026-10-04', description: 'Exclusive' })
  @IsISO8601({ strict: true })
  to!: string;

  @ApiPropertyOptional({ description: 'Narrow to a single room type; omit for every bookable type' })
  @IsOptional()
  @IsUUID()
  roomTypeId?: string;
}

export class PublicQuoteQueryDto {
  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiProperty({ example: '2026-10-01' })
  @IsISO8601({ strict: true })
  checkInDate!: string;

  @ApiProperty({ example: '2026-10-04', description: 'Exclusive' })
  @IsISO8601({ strict: true })
  checkOutDate!: string;

  @ApiPropertyOptional({ description: 'Matches a promotional RatePlan.promoCode' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  promoCode?: string;
}

/**
 * Deliberately NOT a reuse of `CreateReservationDto`. That DTO is a STAFF
 * input surface and accepts several fields a member of the public must never
 * be able to set:
 *
 *  - `guestId`        — would let anyone attach a booking to an existing
 *                       guest profile they don't own, by id.
 *  - `channel`        — would let a direct booking masquerade as an OTA one,
 *                       corrupting channel-mix reporting and (once the
 *                       channel manager lands) commission reconciliation.
 *  - `corporateAccountId` — would hand out negotiated corporate rates to
 *                       anyone who guesses an account id.
 *  - `joinWaitlist`   — would let the public bypass the availability check
 *                       entirely and create rows against a full house.
 *
 * The service maps this narrow shape onto the full internal DTO with those
 * four values forced server-side. `promoCode` IS accepted, because a public
 * promo code is exactly what it's for.
 *
 * `forbidNonWhitelisted: true` (main.ts) rejects any extra field outright, so
 * an attacker can't smuggle those keys through as unknown properties either.
 */
export class PublicCreateReservationDto {
  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiProperty({ example: '2026-10-01' })
  @IsISO8601({ strict: true })
  checkInDate!: string;

  @ApiProperty({ example: '2026-10-04', description: 'Exclusive' })
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

  @ApiProperty({ example: 'Ada Okafor' })
  @IsString()
  @MaxLength(200)
  guestName!: string;

  @ApiProperty({ example: 'ada@example.com', description: 'Required for a public booking — it is the only way the guest receives their confirmation' })
  @IsEmail()
  @MaxLength(320)
  guestEmail!: string;

  @ApiPropertyOptional({ example: '+2348012345678' })
  @IsOptional()
  @Matches(/^\+?[0-9\s-]{7,20}$/, { message: 'phone must be a valid phone number' })
  guestPhone?: string;

  @ApiPropertyOptional({ example: 'Late arrival, around 11pm.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  specialRequests?: string;

  @ApiPropertyOptional({ description: 'Matches a promotional RatePlan.promoCode' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  promoCode?: string;
}

export class PublishBookingEngineDto {
  @ApiProperty({ example: 'grand-hotel-ikeja', description: 'Lowercase letters, digits and hyphens only — this becomes the public booking URL' })
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug must be lowercase alphanumeric words separated by single hyphens' })
  @MaxLength(63)
  slug!: string;
}
