import { TenantStatus } from '@prisma/client';

/** The organisation statuses whose people may sign in and work. `suspended` and `cancelled` are shut — for staff, API keys and the public booking page alike. */
export const OPEN_TENANT_STATUSES: readonly TenantStatus[] = ['trial', 'active'];

export function isTenantOpen(status: TenantStatus | null | undefined): boolean {
  return status !== null && status !== undefined && OPEN_TENANT_STATUSES.includes(status);
}

export const TENANT_SUSPENDED_MESSAGE = 'This organisation’s Roomick account is suspended — contact support to restore access';
