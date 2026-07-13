import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './context/tenant-context.service';

@Global()
@Module({
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class CommonModule {}
