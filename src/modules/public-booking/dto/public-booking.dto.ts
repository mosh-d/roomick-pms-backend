import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Max, Min, MinLength } from 'class-validator';

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

/**
 * Guest booking lookup (Month 9, Guest Self-Service Portal — first slice).
 *
 * Both fields are required together and that's the whole security model, so
 * it's worth being explicit about its limits: `confirmationNumber` is
 * SEQUENTIAL (`RES-2026-00001`, see `generateConfirmationNumber`), so it is
 * guessable on its own and can never be the only credential. Pairing it with
 * the exact email on the booking means an attacker needs to already know the
 * guest's address for a specific property, and the route is throttled hard on
 * top of that.
 *
 * This is the same trade-off airline and hotel "manage my booking" lookups
 * make. A magic-link/OTP flow is strictly better and is what the growth plan
 * actually calls for — it needs working outbound email, which this app does
 * not have yet (only a log transport). Structured so that becomes an
 * additional entry path, not a rewrite.
 */
export class LookupBookingDto {
  @ApiProperty({ example: 'RES-2026-00001' })
  @IsString()
  @MaxLength(40)
  confirmationNumber!: string;

  @ApiProperty({ example: 'ada@example.com', description: 'Must match the email on the booking exactly' })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

/**
 * Guest pre-arrival check-in. Carries the same confirmation-number + email
 * credentials as the lookup, because it's the same guest proving the same
 * thing — there's no session to hold between the two calls.
 *
 * Deliberately absent: ID document type, number and photo. The growth plan
 * lists them, and `GuestProfile` has encrypted columns ready for them, but
 * accepting identity documents over an anonymous public endpoint is a
 * materially different security surface (file upload, encryption-at-rest from
 * an unauthenticated context, and a much higher cost to getting it wrong). It
 * belongs in its own pass, not folded in here.
 */
export class PreArrivalCheckInDto {
  @ApiProperty({ example: 'RES-2026-00001' })
  @IsString()
  @MaxLength(40)
  confirmationNumber!: string;

  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiPropertyOptional({ example: '+2348012345678', description: "Corrects the guest's own stored phone number" })
  @IsOptional()
  @Matches(/^\+?[0-9\s-]{7,20}$/, { message: 'phone must be a valid phone number' })
  phone?: string;

  @ApiPropertyOptional({ example: 'NG', description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/, { message: 'nationality must be a 2-letter country code' })
  nationality?: string;

  @ApiPropertyOptional({ example: '15:30', description: "Expected arrival time (HH:mm) in the property's own timezone" })
  @IsOptional()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { message: 'estimatedArrivalTime must be HH:mm' })
  estimatedArrivalTime?: string;

  @ApiProperty({ description: "Must be true — the guest confirming they've read the property's house rules" })
  @IsBoolean()
  acceptHouseRules!: boolean;
}

/**
 * Guest self-cancellation. Same credentials as the lookup. The guest also
 * confirms the exact charge they were shown (`0.00` when it's free): if the
 * terms have moved since — the free window closed while the page sat open —
 * the cancel is refused rather than charging them something they never saw.
 */
export class CancelBookingDto {
  @ApiProperty({ example: 'RES-2026-00001' })
  @IsString()
  @MaxLength(40)
  confirmationNumber!: string;

  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: '0.00', description: 'The cancellation charge, tax included, from the quote the guest was shown' })
  @Matches(/^\d{1,10}(\.\d{1,2})?$/, { message: 'acknowledgedPenaltyTotal must be an amount such as 0.00' })
  acknowledgedPenaltyTotal!: string;

  @ApiPropertyOptional({ example: 'Travel plans changed' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** A guest messaging the property about their booking. Same credentials as the lookup. */
export class GuestMessageDto {
  @ApiProperty({ example: 'RES-2026-00001' })
  @IsString()
  @MaxLength(40)
  confirmationNumber!: string;

  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'Could we have two extra towels, please?' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;

  @ApiPropertyOptional({ enum: ['late_checkout', 'housekeeping'], description: 'Tags the message as a request; omit for an ordinary message' })
  @IsOptional()
  @IsIn(['late_checkout', 'housekeeping'])
  requestType?: 'late_checkout' | 'housekeeping';
}

export class PublishBookingEngineDto {
  @ApiProperty({ example: 'grand-hotel-ikeja', description: 'Lowercase letters, digits and hyphens only — this becomes the public booking URL' })
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug must be lowercase alphanumeric words separated by single hyphens' })
  @MaxLength(63)
  slug!: string;
}
