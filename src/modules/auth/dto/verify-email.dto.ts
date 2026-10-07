import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsJWT, IsOptional, IsString, MaxLength } from 'class-validator';
import { toTrimmedLowerCase } from '../../../common/transforms/string.transforms';

export class VerifyEmailDto {
  @ApiProperty({ description: 'The token from the confirmation link' })
  @IsJWT()
  token!: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'owner@lekki.example' })
  @Transform(toTrimmedLowerCase)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiPropertyOptional({ description: 'Only used while no email provider is set up: the account’s password gets the token back instead of an email' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;
}
