import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { toTrimmedLowerCase } from '../../../common/transforms/string.transforms';

export class LoginDto {
  @ApiProperty({ example: 'owner@demo.local' })
  @Transform(toTrimmedLowerCase)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'Demo!Password1' })
  @IsString()
  password!: string;

  @ApiPropertyOptional({
    example: 'demo',
    description:
      'Tenant subdomain. Optional if the request carries an X-Tenant-ID header instead.',
  })
  @IsOptional()
  @Transform(toTrimmedLowerCase)
  @IsString()
  @MaxLength(63)
  subdomain?: string;
}
