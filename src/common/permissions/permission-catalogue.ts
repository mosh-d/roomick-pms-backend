import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';

/**
 * What a custom role can be given permission to do.
 *
 * The six seeded roles are checked by name, as they always have been
 * (`RolesGuard`). This vocabulary exists for roles a tenant invents: a
 * custom role holds no name the routes know, so it reaches a route only when
 * its own permissions cover that route's module and action.
 *
 * **What is deliberately absent matters as much as what's here.** There is no
 * module for staff, roles and permissions, security, system administration,
 * backups, GDPR or integrations. A custom role therefore cannot reach any of
 * them, however it is configured — so no custom role can grant itself more
 * access, invite a colleague, or export the guest data the GDPR flow guards.
 * Those stay with the seeded owner and manager roles.
 */

export const PERMISSION_ACTIONS = ['read', 'create', 'update', 'delete'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export interface PermissionModule {
  key: string;
  label: string;
  /** What holding this module covers, in the words the matrix shows. */
  description: string;
}

export const PERMISSION_MODULES: readonly PermissionModule[] = [
  { key: 'reservations', label: 'Reservations', description: 'Bookings, availability, check-in and check-out, the waitlist and rate plans' },
  { key: 'guests', label: 'Guests', description: 'Guest profiles, notes, preferences and registration cards' },
  { key: 'folios', label: 'Bills & Payments', description: 'Folios, charges, payments and refunds' },
  { key: 'housekeeping', label: 'Housekeeping', description: 'Room status, cleaning tasks and the room board' },
  { key: 'maintenance', label: 'Maintenance', description: 'Work orders and the asset registry' },
  { key: 'pos', label: 'Point of Sale', description: 'Outlets, menus and orders' },
  { key: 'shifts', label: 'Shifts', description: 'Opening, closing and counting a cash drawer' },
  { key: 'comms', label: 'Guest Messages', description: 'The inbox, replies and the communication log' },
  { key: 'reports', label: 'Reports', description: 'Occupancy, ADR, RevPAR and revenue reports' },
  { key: 'night_audit', label: 'Night Audit', description: 'Running and reviewing the night audit' },
  { key: 'property', label: 'Property Setup', description: 'Brands, branches, room types, rooms and house rules' },
  { key: 'taxes', label: 'Taxes', description: 'Tax rules and how charges are taxed' },
  { key: 'alerts', label: 'Alerts', description: 'Missed check-ins, overdue check-outs and overdue balances' },
  { key: 'sales_events', label: 'Sales & Events', description: 'Group blocks, event spaces and banquet orders' },
  { key: 'revenue', label: 'Revenue Management', description: 'Forecasts, rate recommendations, restrictions and the comp set' },
  { key: 'loyalty', label: 'Loyalty', description: 'The loyalty programme, members’ points and redemptions' },
  { key: 'marketing', label: 'Marketing', description: 'Audiences, templates and email campaigns' },
];

const MODULE_KEYS = new Set(PERMISSION_MODULES.map((module) => module.key));

export type PermissionMap = Record<string, PermissionAction[]>;

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

/**
 * Read back strictly, on every write and every read. A permission map is the
 * thing that decides what somebody can do, so an unrecognised module or
 * action is an error rather than a silently ignored key — and a key nobody
 * notices being ignored is how a role ends up with access nobody granted, or
 * without access somebody thinks they granted.
 */
export function parsePermissions(value: unknown): PermissionMap {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('Permissions must be an object of module to actions');

  const parsed: PermissionMap = {};
  for (const [moduleKey, rawActions] of Object.entries(value as Record<string, unknown>)) {
    if (!MODULE_KEYS.has(moduleKey)) throw invalid(`“${moduleKey}” isn’t something a role can be given`);
    if (!Array.isArray(rawActions)) throw invalid(`The actions for ${moduleKey} must be a list`);
    const actions = rawActions as unknown[];
    const unrecognised = actions.find((action) => typeof action !== 'string' || !(PERMISSION_ACTIONS as readonly string[]).includes(action));
    // The offending value isn't echoed back: it came from a request body, and
    // naming the field is more use to whoever sent it anyway.
    if (unrecognised !== undefined) throw invalid(`That isn’t an action for ${moduleKey} — use ${PERMISSION_ACTIONS.join(', ')}`);
    const unique = [...new Set(actions as PermissionAction[])];
    if (unique.length > 0) parsed[moduleKey] = unique;
  }
  return parsed;
}

export function permits(permissions: PermissionMap, module: string, action: PermissionAction): boolean {
  return (permissions[module] ?? []).includes(action);
}

/**
 * The action a route performs, from its HTTP method. Routes where that reads
 * wrongly — a POST that only previews something, or one that acts on a record
 * that already exists — say so themselves with `@Permission(module, action)`.
 */
export function actionForMethod(method: string): PermissionAction {
  switch (method.toUpperCase()) {
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return 'read';
  }
}
