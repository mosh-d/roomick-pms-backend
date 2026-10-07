import { ForbiddenException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';
import { JwtPayload } from '../types/request-context';

/**
 * Who may hand out which role, and whose account a manager may manage.
 *
 * The owner runs everything except their own account. A manager runs the
 * staff of the branches they manage and nobody above that: they can't make
 * anyone a manager or an owner, can't touch a manager's or the owner's
 * account, and can't give a role across every branch. Without these rules a
 * manager could invite someone as owner, or simply change their own role to
 * owner — the staff routes only ever checked that the caller was a manager
 * somewhere.
 */

/** Roles only the owner hands out, and accounts only the owner manages. */
const SENIOR_ROLES: readonly string[] = ['owner', 'manager'];

export function isOwner(actor: JwtPayload): boolean {
  return actor.roles.some((r) => r.role === 'owner');
}

/** The owner manages every branch; a manager the branches they're manager of (an all-branch manager, all of them). */
export function managesBranch(actor: JwtPayload, branchId: string | null): boolean {
  if (isOwner(actor)) return true;
  if (branchId === null) return false;
  return actor.roles.some((r) => r.role === 'manager' && (r.branchId === null || r.branchId === branchId));
}

/** Why this actor can't give this role at this branch (`null` = every branch), or null when they can. */
export function whyCannotGrant(actor: JwtPayload, roleName: string, branchId: string | null): string | null {
  if (roleName === 'owner') return 'There’s one owner per organisation — the owner role can’t be given to anyone else';
  if (isOwner(actor)) return null;
  if (SENIOR_ROLES.includes(roleName)) return 'Only the owner can make someone a manager';
  if (branchId === null) return 'Only the owner can give someone a role across every branch';
  if (!managesBranch(actor, branchId)) return 'You can only manage staff at a branch you manage';
  return null;
}

export function assertMayGrant(actor: JwtPayload, roleName: string, branchId: string | null): void {
  const reason = whyCannotGrant(actor, roleName, branchId);
  if (reason) throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: reason });
}

export interface HeldRole {
  branchId: string | null;
  role: string;
}

/**
 * Why this actor can't change this person's role at one branch, or null.
 * The change touches that branch only, so it's the branch that has to be theirs.
 */
export function whyCannotChangeRoleAt(actor: JwtPayload, targetUserId: string, held: readonly HeldRole[], branchId: string | null): string | null {
  if (targetUserId === actor.sub) return 'You can’t change your own role — ask the owner';
  if (held.some((r) => r.role === 'owner')) return 'The owner’s role can’t be changed';
  if (!isOwner(actor) && held.some((r) => SENIOR_ROLES.includes(r.role))) return 'Only the owner can change a manager’s account';
  if (!managesBranch(actor, branchId)) {
    return branchId === null ? 'Only the owner can give someone a role across every branch' : 'You can only manage staff at a branch you manage';
  }
  return null;
}

/**
 * Why this actor can't act on this person's whole account — deactivate or
 * reactivate it, or make a password-reset link for it — or null. Account-wide
 * means every branch they work at: a manager may do it only when all of this
 * person's roles are at branches that manager runs.
 */
export function whyCannotManageAccount(actor: JwtPayload, targetUserId: string, held: readonly HeldRole[]): string | null {
  if (targetUserId === actor.sub) return 'You can’t do this to your own account';
  if (held.some((r) => r.role === 'owner')) return 'The owner’s account can’t be changed here';
  if (isOwner(actor)) return null;
  if (held.some((r) => SENIOR_ROLES.includes(r.role))) return 'Only the owner can change a manager’s account';
  if (held.length === 0 || held.some((r) => !managesBranch(actor, r.branchId))) {
    return 'This person also works somewhere you don’t manage — ask the owner';
  }
  return null;
}

export function assertMayManageAccount(actor: JwtPayload, targetUserId: string, held: readonly HeldRole[]): void {
  const reason = whyCannotManageAccount(actor, targetUserId, held);
  if (reason) throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: reason });
}
