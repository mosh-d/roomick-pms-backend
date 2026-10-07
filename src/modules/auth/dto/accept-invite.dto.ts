import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Someone new sets their name and a password here. Someone who already has a
 * Roomick account at this organisation (invited to another branch) gives
 * their existing password instead — accepting never signs anyone in without
 * the account's own password. The strength rule for a new password is
 * checked in `AuthService.acceptInvite`, since an existing password isn't
 * being chosen here.
 */
export class AcceptInviteDto {
  @ApiPropertyOptional({ example: 'Chidi Eze', description: 'Required for someone new' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @ApiProperty({ example: 'Str0ngPass!', description: 'A new password (≥8, upper, lower, number), or the existing account’s own' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;

  @ApiPropertyOptional({ example: '+2348012345678' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
