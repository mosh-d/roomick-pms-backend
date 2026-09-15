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

/** Staff replies from the inbox. `in_app_chat` shows on the guest's "Manage your booking" page — today the one channel that actually reaches a guest. */
const REPLY_CHANNELS: CommsChannel[] = ['in_app_chat', 'email', 'sms'];

export class InboxReplyDto {
  @ApiProperty({ enum: REPLY_CHANNELS })
  @IsIn(REPLY_CHANNELS)
  channel!: CommsChannel;

  @ApiPropertyOptional({ description: 'Email only' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string;

  @ApiProperty({ example: 'Of course — late check-out until 1pm is fine, at no charge.' })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;
}

export class InboxQueryDto {
  @ApiPropertyOptional({ enum: ['all', 'unread'] })
  @IsOptional()
  @IsIn(['all', 'unread'])
  filter?: 'all' | 'unread';
}
