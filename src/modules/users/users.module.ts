import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PageAccessController } from './page-access.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule], // invite secret generation lives on AuthService
  controllers: [UsersController, PageAccessController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
