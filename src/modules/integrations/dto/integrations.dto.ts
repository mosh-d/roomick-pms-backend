import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayNotEmpty, IsArray, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class CreateApiKeyDto {
  @ApiProperty({ example: 'Zapier Integration' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;
}

export class CreateWebhookDto {
  @ApiProperty({ example: 'https://partner.example.com/webhooks/roomick' })
  // require_tld: false — a local/dev partner endpoint (e.g. http://localhost:4000/hook)
  // is a legitimate target during integration testing. require_protocol: true is load-
  // bearing, not decorative: validator.js's own `require_protocol` defaults to false,
  // and combined with `require_tld: false` a bare word like "not-a-url" would otherwise
  // validate as a "host-only" URL — caught live, not by inspection, when a deliberately
  // malformed URL in a verification script returned 201 instead of 400.
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(500)
  url!: string;

  @ApiProperty({ example: ['reservations.post', 'reservations.patch'], description: 'Matched against the same action strings this tenant\'s own audit log already records' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @IsString({ each: true })
  eventTypes!: string[];
}
