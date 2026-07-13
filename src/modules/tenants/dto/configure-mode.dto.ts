import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export enum BrandModeInput {
  single = 'single',
  multi = 'multi',
}

export class ConfigureModeDto {
  @ApiProperty({ enum: BrandModeInput, example: 'single' })
  @IsEnum(BrandModeInput)
  mode!: BrandModeInput;

  @ApiPropertyOptional({
    example: 'Acme Hotels',
    description:
      'Single mode only: name for the auto-created (UI-hidden) brand. Defaults to the tenant groupName.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  brandName?: string;
}
