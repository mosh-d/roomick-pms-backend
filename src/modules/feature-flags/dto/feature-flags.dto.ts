import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class ToggleFeatureFlagDto {
  @ApiProperty({ description: 'Opt this tenant in (true) or out (false) of the flag' })
  @IsBoolean()
  enabled!: boolean;
}
