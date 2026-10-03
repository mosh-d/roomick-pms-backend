import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';

@Module({
  // Secrets are passed per-sign (access vs refresh differ) — no global secret here.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, MfaService],
  exports: [AuthService, MfaService],
})
export class AuthModule {}
