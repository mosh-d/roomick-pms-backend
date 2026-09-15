import { ForbiddenException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';
import { JwtPayload } from '../types/request-context';

export function hasRoleAtBranch(actor: JwtPayload, branchId: string, roles: readonly string[]): boolean {
  return actor.roles.some((r) => roles.includes(r.role) && (r.branchId === null || r.branchId === branchId));
}

/**
 * `RolesGuard` checks a role at the branch named in the URL. A route addressed
 * by a record's own id names no branch, so the guard passes a role held at ANY
 * branch — services behind such routes check the record's own branch here.
 */
export function assertRoleAtBranch(actor: JwtPayload, branchId: string, roles: readonly string[]): void {
  if (!hasRoleAtBranch(actor, branchId, roles)) {
    throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Insufficient role for this action' });
  }
}
