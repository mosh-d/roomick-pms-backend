import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ReservationChannel } from '@prisma/client';
import { CreateGuestDto } from '../../guests/dto/guest.dto';

/**
 * `guestId` (existing guest) and `guest` (inline create) are both optional
 * at this layer — enforcing "exactly one" here would need a custom
 * class-validator decorator for one conditional pair, so the service does
 * it instead (same "DTO stays permissive, service enforces the real rule"
 * split `RoomsService.bulkCreateRooms`'s own `range`/`numbers` fields
 * already use), throwing `VALIDATION_FAILED` if neither or both are set.
 */
export class CreateReservationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  guestId?: string;

  @ApiPropertyOptional({ type: CreateGuestDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateGuestDto)
  guest?: CreateGuestDto;

  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsISO8601({ strict: true })
  checkInDate!: string;

  @ApiProperty({ example: '2026-09-04', description: 'Exclusive — the last night stayed is the day before this' })
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

  @ApiPropertyOptional({ example: 'Allergic to fish. Must stay on 1st floor.' })
  @IsOptional()
  @MaxLength(1000)
  specialRequests?: string;

  @ApiPropertyOptional({ enum: ReservationChannel, description: 'Defaults to "direct" when omitted' })
  @IsOptional()
  @IsIn(Object.values(ReservationChannel))
  channel?: ReservationChannel;
}

export class WalkInReservationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  guestId?: string;

  @ApiPropertyOptional({ type: CreateGuestDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateGuestDto)
  guest?: CreateGuestDto;

  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiProperty({
    example: '2c520f6e-1234-4abc-9def-000000000000',
    description: 'No auto-assign in this pass — an immediate check-in must be handed an exact room',
  })
  @IsUUID()
  roomId!: string;

  @ApiProperty({
    example: '2026-09-04',
    description: 'checkInDate is NOT accepted — the server forces it to today in the branch timezone',
  })
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

  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(1000)
  specialRequests?: string;
}

export class CheckInDto {
  @ApiPropertyOptional({ description: 'Required only if the reservation has no room assigned yet (always true this pass)' })
  @IsOptional()
  @IsUUID()
  roomId?: string;
}

export class CancelReservationDto {
  @ApiPropertyOptional({ example: 'Guest called to cancel' })
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

export class AvailabilityQueryDto {
  @ApiProperty({ example: '2026-09-01' })
  @IsISO8601({ strict: true })
  from!: string;

  @ApiProperty({ example: '2026-09-04', description: 'Exclusive' })
  @IsISO8601({ strict: true })
  to!: string;

  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;
}
