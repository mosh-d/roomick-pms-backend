import { ApiProperty } from '@nestjs/swagger';
import { IsJWT } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ description: 'Verification token from the signup email (stubbed in MVP)' })
  @IsJWT()
  token!: string;
}
