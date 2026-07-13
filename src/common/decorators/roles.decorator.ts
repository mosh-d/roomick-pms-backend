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

/** Restricts a route to users holding one of the given roles at the target branch. */
export const Roles = (...roles: SystemRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
