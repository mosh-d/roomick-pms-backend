import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsStrongPassword, MaxLength, MinLength } from 'class-validator';

export class AcceptInviteDto {
  @ApiProperty({ example: 'Chidi Eze' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'Str0ngPass!', minLength: 8 })
  @IsStrongPassword(
    { minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 0 },
    { message: 'password must be ≥8 chars with upper, lower and a number' },
  )
  password!: string;

  @ApiPropertyOptional({ example: '+2348012345678' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
