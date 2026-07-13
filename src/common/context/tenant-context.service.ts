import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextStore {
  tenantId?: string;
  userId?: string;
  branchId?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * AsyncLocalStorage-backed request context so deep service code (and the
 * AuditInterceptor) can read tenant/user identity without parameter threading.
 * Populated by TenantContextInterceptor.
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<RequestContextStore>();

  run<T>(store: RequestContextStore, fn: () => T): T {
    return this.als.run(store, fn);
  }

  get store(): RequestContextStore | undefined {
    return this.als.getStore();
  }

  get tenantId(): string | undefined {
    return this.als.getStore()?.tenantId;
  }

  get userId(): string | undefined {
    return this.als.getStore()?.userId;
  }
}
