import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Deleting an organisation is the one action with no way back, so the owner proves it's them — password, and the second step when they have one. */
export class DeleteOrganizationDto {
  @ApiProperty({ description: 'The owner’s own password' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;

  @ApiPropertyOptional({ description: 'Required when two-step sign-in is on: the six-digit code, or a recovery code' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{6,20}$/, { message: 'mfaCode must be the six-digit code or a recovery code' })
  mfaCode?: string;
}
