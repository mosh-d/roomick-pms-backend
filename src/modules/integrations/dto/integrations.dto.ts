import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PERMISSION_MODULES } from '../../../common/permissions/permission-catalogue';
import { WEBHOOK_EVENT_TYPES } from '../webhook-events';

const SCOPE_KEYS = PERMISSION_MODULES.map((module) => module.key);

export class CreateApiKeyDto {
  @ApiProperty({ example: 'Accounting sync' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: ['reservations', 'folios'], description: 'What the key can read — permission modules. Read only, always.' })
  @IsArray()
  @ArrayNotEmpty({ message: 'Choose at least one thing this key can read' })
  @IsIn(SCOPE_KEYS, { each: true, message: 'That isn’t something a key can be given' })
  scopes!: string[];

  @ApiPropertyOptional({ description: 'Only this branch’s records. Left out, every branch.' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

export class UpdateApiKeyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'Choose at least one thing this key can read' })
  @IsIn(SCOPE_KEYS, { each: true, message: 'That isn’t something a key can be given' })
  scopes?: string[];

  @ApiPropertyOptional({ nullable: true, description: 'A branch to keep the key to, or null for every branch' })
  @IsOptional()
  @IsUUID()
  branchId?: string | null;
}

export class CreateWebhookDto {
  @ApiProperty({ example: 'https://partner.example.com/webhooks/roomick' })
  // require_tld: false — a receiver on localhost is how an integration is tested
  // in development (production is held to https and a public address by
  // `webhookUrlProblem`). require_protocol: true is load-bearing: with
  // require_tld off, validator.js would otherwise pass a bare word as a host.
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  url!: string;

  @ApiProperty({ example: ['reservation.created', 'reservation.cancelled'], description: 'Event names from GET /webhooks/events' })
  @IsArray()
  @ArrayNotEmpty({ message: 'Choose at least one event' })
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true, message: 'That isn’t an event Roomick sends' })
  eventTypes!: string[];

  @ApiPropertyOptional({ description: 'Only this branch’s events. Left out, every branch.' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

export class UpdateWebhookDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'Choose at least one event' })
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true, message: 'That isn’t an event Roomick sends' })
  eventTypes?: string[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  branchId?: string | null;

  @ApiPropertyOptional({ description: 'Switch it off (nothing more is sent, waiting deliveries are dropped) or back on' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
