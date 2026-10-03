import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsString, MaxLength, MinLength } from 'class-validator';

/** A six-digit authenticator code, or a recovery code (`xxxxx-xxxxx`). */
export class MfaCodeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code!: string;
}

export class MfaDisableDto extends MfaCodeDto {
  @ApiProperty({ description: 'The account password, as well as a code: an open session alone can’t switch the second step off' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}

export class MfaVerifyDto extends MfaCodeDto {
  @ApiProperty({ description: 'The ticket `POST /auth/login` returned with `mfaRequired: true`' })
  @IsJWT()
  challengeToken!: string;
}
