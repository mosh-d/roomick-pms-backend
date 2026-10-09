import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsJWT, IsOptional } from 'class-validator';

export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      'Only for a caller without the session cookie. The web app sends nothing: its session is in an httpOnly cookie. ' +
      'A browser still holding a token from before the cookie sends it once, and gets the cookie back.',
  })
  @IsOptional()
  @IsJWT()
  refreshToken?: string;
}
