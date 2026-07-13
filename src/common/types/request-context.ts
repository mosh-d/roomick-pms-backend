import { Request } from 'express';

/** JWT payload shape — established in P0 so guards can be written; issued by the auth module (P1). */
export interface JwtPayload {
  /** users.id */
  sub: string;
  /** tenants.id — must match the X-Tenant-ID header on every request */
  tenantId: string;
  email: string;
  /** branch-scoped roles: [{branchId: uuid|null, role: string}] — null branchId = all branches */
  roles: Array<{ branchId: string | null; role: string }>;
  tokenType: 'access' | 'refresh';
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  /** validated tenant id — set by TenantGuard after header/claim match */
  tenantId?: string;
}
