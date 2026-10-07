import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsStrongPassword, MaxLength, MinLength } from 'class-validator';
import { toTrimmedLowerCase } from '../../../common/transforms/string.transforms';

/** The same rule as choosing a password at sign-up. */
const STRONG = { minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 0 } as const;
const STRONG_MESSAGE = { message: 'The password needs at least 8 characters, with an upper-case letter, a lower-case letter and a number' };

export class EmailOnlyDto {
  @ApiProperty({ example: 'owner@lekki.example' })
  @Transform(toTrimmedLowerCase)
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'The token from the reset link' })
  @IsString()
  @MinLength(40)
  @MaxLength(200)
  token!: string;

  @ApiProperty({ example: 'N3wPassword' })
  @IsStrongPassword(STRONG, STRONG_MESSAGE)
  @MaxLength(200)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string;

  @ApiProperty({ example: 'N3wPassword' })
  @IsStrongPassword(STRONG, STRONG_MESSAGE)
  @MaxLength(200)
  newPassword!: string;
}
