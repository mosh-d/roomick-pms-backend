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
      'Name for the head brand this call always creates (single or multi mode alike). Defaults to the ' +
      'tenant groupName — most callers omit this and let it default, since the owner already named the ' +
      'organization at signup.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  brandName?: string;
}
