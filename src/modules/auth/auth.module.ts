import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { SessionCleanupScheduler } from './session-cleanup.scheduler';

@Module({
  // Secrets are passed per-sign (access vs refresh differ) — no global secret here.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, MfaService, PasswordService, SessionCleanupScheduler],
  exports: [AuthService, MfaService, PasswordService],
})
export class AuthModule {}
