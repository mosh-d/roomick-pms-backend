import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CommsChannel } from '@prisma/client';

/** Manual sends only — automated triggers (booking_confirmation, checkin_receipt, post_stay, no_show_notice, cancellation) always go through email; push/in_app_chat have no manual UI yet. */
const MANUAL_CHANNELS: CommsChannel[] = ['email', 'sms'];

export class SendCommunicationDto {
  @ApiProperty({ enum: MANUAL_CHANNELS })
  @IsIn(MANUAL_CHANNELS)
  channel!: CommsChannel;

  @ApiPropertyOptional({ example: 'A note about your upcoming stay', description: 'Email only' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string;

  @ApiProperty({ example: 'Hi John, just confirming your late check-in tonight — the front desk will be expecting you.' })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;
}
