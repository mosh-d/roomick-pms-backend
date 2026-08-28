import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class SignRegistrationCardDto {
  @ApiProperty({ description: 'base64 PNG/SVG from the signature pad canvas' })
  @IsString()
  @MinLength(1)
  signatureData!: string;
}
