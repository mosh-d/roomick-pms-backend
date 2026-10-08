import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, IsUrl, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateBrandDto {
  @ApiProperty({ example: 'Acme Resorts' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/logo.png', description: 'An https address, like the registration card logo' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'logoUrl must be an https:// address' })
  @MaxLength(2048)
  logoUrl?: string;

  @ApiPropertyOptional({ example: '#2d4a6e' })
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'primaryColor must be a #rrggbb hex value' })
  primaryColor?: string;

  @ApiPropertyOptional({ description: 'Default policies inherited by branches' })
  @IsOptional()
  @IsObject()
  defaultPolicies?: Record<string, unknown>;
}

export class UpdateBrandDto extends PartialType(CreateBrandDto) {}
