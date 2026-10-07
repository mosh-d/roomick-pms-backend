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
  /**
   * Set when the request signed in with an API key instead of a person's
   * token. `sub` is then the key's id, `roles` is empty, and `RolesGuard`
   * lets it read only what the key's scopes cover.
   */
  apiKey?: ApiKeyPrincipal;
}

/** Who a request is when it signs in with an API key rather than as a person. */
export interface ApiKeyPrincipal {
  id: string;
  name: string;
  /** Permission modules the key can read (`permission-catalogue.ts`). */
  scopes: string[];
  /** Only this branch's records, when set. */
  branchId: string | null;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  /** validated tenant id — set by TenantGuard after header/claim match */
  tenantId?: string;
}
