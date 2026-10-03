import { SetMetadata } from '@nestjs/common';
import { PermissionAction } from '../permissions/permission-catalogue';

export const PERMISSION_KEY = 'permission';

export interface PermissionMetadata {
  module: string;
  /** Left out, the action follows the HTTP method (see `actionForMethod`). */
  action?: PermissionAction;
}

/**
 * Says which part of the business a route belongs to, so a **custom** role's
 * permission map can be checked against it. The seeded roles are still
 * matched by name through `@Roles`, and this changes nothing for them.
 *
 * Usually on the controller, once — the action then follows the HTTP method.
 * Put it on a route with an explicit action where the method reads wrongly:
 * a POST that only previews something is a `read`, and a POST that acts on a
 * record that already exists (check-in, void, close) is an `update`.
 *
 * A controller with no `@Permission` at all can never be reached by a custom
 * role. That's deliberate for staff, roles, security, system administration,
 * backups, GDPR and integrations — see `permission-catalogue.ts`.
 */
export const Permission = (module: string, action?: PermissionAction): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, { module, action } satisfies PermissionMetadata);
