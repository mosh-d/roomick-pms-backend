import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { toTrimmedLowerCase } from '../../../common/transforms/string.transforms';

/**
 * Plain email+password — no subdomain/tenant-header disambiguation needed
 * anymore. `AuthService.login()` resolves the owning tenant via
 * `UserEmailIndex` (see that model's own comment in schema.prisma for
 * why a separate, non-RLS-scoped lookup exists for this) now that
 * `User.email` is globally unique.
 */
export class LoginDto {
  @ApiProperty({ example: 'owner@demo.local' })
  @Transform(toTrimmedLowerCase)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'Demo!Password1' })
  @IsString()
  password!: string;
}
