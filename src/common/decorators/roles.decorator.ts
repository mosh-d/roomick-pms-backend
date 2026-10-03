import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * Seeded system role names (spec §3.1). Custom roles are allowed per tenant;
 * these constants cover the seeded defaults used in guards.
 */
export enum SystemRole {
  Owner = 'owner',
  Manager = 'manager',
  FrontDesk = 'front_desk',
  Housekeeper = 'housekeeper',
  Accountant = 'accountant',
  PosStaff = 'pos_staff',
}

/**
 * Every seeded role. Used by routes that any member of staff may reach —
 * naming them explicitly keeps that access exactly as it was, while bringing
 * the route under the permission matrix for the custom roles a tenant
 * invents (see `RolesGuard`): a route with no `@Roles` at all is open to
 * anyone signed in, matrix or no matrix.
 */
export const ALL_SYSTEM_ROLES = [
  SystemRole.Owner,
  SystemRole.Manager,
  SystemRole.FrontDesk,
  SystemRole.Housekeeper,
  SystemRole.Accountant,
  SystemRole.PosStaff,
] as const;

/** Restricts a route to users holding one of the given roles at the target branch. */
export const Roles = (...roles: SystemRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
