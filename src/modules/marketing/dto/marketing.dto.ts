import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Deliberately loose here and strict in `segment-rules.parseCriteria`: the
 * criteria are stored as JSON and read back by the sender, so the rule that
 * decides who receives a campaign has to hold for a row written by an older
 * client too, not only for one that just passed this DTO. One validator, at
 * the point of use.
 */
export class SaveSegmentDto {
  @ApiProperty({ example: 'Lapsed guests — no stay in 6 months' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Guests who stayed at least once but not since March.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({
    description: 'AND-ed rules. See segment-rules.ts — vipLevelMin, loyaltyTiers, tags, nationalities, branchIds, minStays, minTotalSpend, lastStayWithinDays, notStayedForDays',
    example: { minStays: 1, notStayedForDays: 180 },
  })
  @IsObject()
  criteria!: Record<string, unknown>;
}

export class PreviewSegmentDto {
  @ApiProperty({ example: { vipLevelMin: 3 } })
  @IsObject()
  criteria!: Record<string, unknown>;
}

export class SaveTemplateDto {
  @ApiProperty({ example: 'Come back — 15% off' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: '{{guest_first_name}}, your room is waiting' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string;

  @ApiProperty({
    example: 'Hello {{guest_name}},\n\nIt has been a while. Book direct at https://example.com and take 15% off.\n\n{{hotel_name}}',
    description: 'Plain text with {{merge_field}} placeholders. The HTML part of the email is generated from it.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(20_000)
  body!: string;
}

export class AbTestDto {
  @ApiProperty({ description: "Variant B's template. Must differ from the campaign's own template." })
  @IsUUID()
  variantTemplateId!: string;

  @ApiProperty({ example: 0.5, description: 'Share of recipients who get variant A. Strictly between 0 and 1.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.05)
  @Max(0.95)
  splitRatio!: number;
}

export class CreateCampaignDto {
  @ApiProperty({ example: 'March win-back' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @ApiProperty({ enum: ['email', 'sms', 'push'], description: 'Only email can be sent today — see MarketingService.assertSendableChannel' })
  @IsIn(['email', 'sms', 'push'])
  channel!: 'email' | 'sms' | 'push';

  @ApiProperty()
  @IsUUID()
  segmentId!: string;

  @ApiProperty()
  @IsUUID()
  templateId!: string;

  @ApiPropertyOptional({ description: "Overrides the template's own subject for this send" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string;

  @ApiPropertyOptional({ example: '2026-09-20T09:00:00Z', description: 'Leave unset to keep the campaign a draft and send it by hand' })
  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledAt?: string;

  @ApiPropertyOptional({ type: AbTestDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AbTestDto)
  abTest?: AbTestDto;
}

export class UpdateCampaignDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  segmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string;

  @ApiPropertyOptional({ description: 'Null clears the schedule and returns the campaign to a draft' })
  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledAt?: string | null;

  @ApiPropertyOptional({ type: AbTestDto, description: 'Null removes the A/B test' })
  @IsOptional()
  @ValidateNested()
  @Type(() => AbTestDto)
  abTest?: AbTestDto | null;
}

export class SendTestDto {
  @ApiProperty({ example: 'manager@hotel.com', description: 'A staff address. A test never touches a guest, and is never recorded against one.' })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class ClickQueryDto {
  @ApiProperty({ description: 'The destination, as it was written into the email' })
  @IsString()
  @MaxLength(2000)
  u!: string;

  @ApiProperty({ description: 'Its signature — an unsigned or edited destination is refused, so this is not an open redirect' })
  @IsString()
  @Matches(/^[0-9a-f]{32}$/)
  s!: string;
}

export class CampaignListQueryDto {
  @ApiPropertyOptional({ enum: ['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'] })
  @IsOptional()
  @IsIn(['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'])
  status?: 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed';
}

export class PreviewTemplateDto {
  @ApiProperty()
  @IsString()
  @MaxLength(20_000)
  body!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string;
}

/** Marketing consent on the guest profile — its own DTO so the front desk can set it without touching anything else. */
export class SetMarketingConsentDto {
  @ApiProperty({ description: 'False records an opt-out and keeps the date it happened' })
  @IsIn([true, false])
  optIn!: boolean;
}
