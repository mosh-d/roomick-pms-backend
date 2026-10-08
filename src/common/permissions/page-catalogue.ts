import { SystemRole } from '../decorators/roles.decorator';

/**
 * The dashboard pages a branch manager can give or take away from a staff
 * role (Staff Management → Page Access).
 *
 * A page's `key` is its path in the web app — `/dashboard/arrivals` — which is
 * what the app's own navigation map (`roomick-pms-frontend/lib/navigation.ts`)
 * lists, so the two need no translation table. A page added to the app that a
 * manager should be able to switch needs an entry here too.
 *
 * - `module` — the permission module the page is about. A custom role can be
 *   given the page when its permission map lets it read that module.
 * - `roles` — the built-in staff roles that can open it today (the server lets
 *   them load what it shows). These are the role's pages until a manager
 *   changes them, and the only ones a manager can give it.
 * - `actRoles` — of those, the ones that can also do the page's work; for the
 *   rest it's view only, and Page Access says so. Left out on a page that is
 *   only ever looked at.
 * - `uses` — every permission module the page calls — its record page, the
 *   shared pieces on it, and the hub it's reached from included (worked out
 *   from the web app's code, not by hand). Once a manager has set a role's
 *   pages at a branch, the server refuses that role any module none of its
 *   pages uses, so hiding Reports also closes the reports API to it.
 *
 * Owners and managers are never restricted, and the pages only they can use
 * (`MANAGER_ONLY_PAGES`) aren't offered.
 */
export interface PageDefinition {
  key: string;
  label: string;
  group: 'Operations' | 'Management' | 'Admin';
  /** The sidebar row it sits under — the page's own label when it is the row. */
  feature: string;
  module: string | null;
  roles: readonly StaffRole[];
  actRoles?: readonly StaffRole[];
  uses: readonly string[];
}

export type StaffRole = SystemRole.FrontDesk | SystemRole.Housekeeper | SystemRole.Accountant | SystemRole.PosStaff;

/** The built-in roles Page Access applies to. Owners and managers always see everything. */
export const STAFF_ROLES: readonly StaffRole[] = [SystemRole.FrontDesk, SystemRole.Housekeeper, SystemRole.Accountant, SystemRole.PosStaff];

/** Never restricted: they set the access, and the pages below are theirs. */
export const UNRESTRICTED_ROLES: readonly string[] = [SystemRole.Owner, SystemRole.Manager];

const { FrontDesk: FD, Housekeeper: HK, Accountant: AC, PosStaff: POS } = SystemRole;
const EVERY_STAFF_ROLE = [FD, HK, AC, POS] as const;

export const PAGE_CATALOGUE: readonly PageDefinition[] = [
  // --- Operations -------------------------------------------------------------------------------------------------
  { key: '/dashboard/alerts', label: 'Alerts', group: 'Operations', feature: 'Alerts', module: 'alerts', roles: [FD, AC], uses: ['alerts'] },

  { key: '/dashboard/arrivals', label: 'Arrivals Dashboard', group: 'Operations', feature: 'Front Desk', module: 'reservations', roles: EVERY_STAFF_ROLE, uses: ['reservations', 'property'] },
  { key: '/dashboard/check-in', label: 'Check-In Flow', group: 'Operations', feature: 'Front Desk', module: 'reservations', roles: EVERY_STAFF_ROLE, actRoles: [FD], uses: ['reservations', 'guests', 'property'] },
  { key: '/dashboard/group-check-in', label: 'Group Check-In', group: 'Operations', feature: 'Front Desk', module: 'reservations', roles: EVERY_STAFF_ROLE, actRoles: [FD], uses: ['reservations', 'property'] },
  { key: '/dashboard/walk-in-booking', label: 'Walk-In Booking', group: 'Operations', feature: 'Front Desk', module: 'reservations', roles: [FD, AC], actRoles: [FD], uses: ['reservations', 'guests', 'property'] },
  { key: '/dashboard/departures', label: 'Departures Dashboard', group: 'Operations', feature: 'Front Desk', module: 'reservations', roles: EVERY_STAFF_ROLE, actRoles: [FD], uses: ['reservations', 'folios', 'property'] },
  { key: '/dashboard/check-out', label: 'Check-Out Flow', group: 'Operations', feature: 'Front Desk', module: 'reservations', roles: EVERY_STAFF_ROLE, actRoles: [FD], uses: ['reservations', 'folios', 'property'] },
  { key: '/dashboard/room-move', label: 'Room Move & Upgrade', group: 'Operations', feature: 'Front Desk', module: 'reservations', roles: [FD], actRoles: [FD], uses: ['reservations', 'property'] },
  { key: '/dashboard/in-house-guest-list', label: 'In-House Guest List', group: 'Operations', feature: 'Front Desk', module: 'reservations', roles: EVERY_STAFF_ROLE, actRoles: [FD], uses: ['reservations', 'folios', 'property'] },
  { key: '/dashboard/room-status-board', label: 'Room Status Board', group: 'Operations', feature: 'Front Desk', module: 'property', roles: EVERY_STAFF_ROLE, actRoles: EVERY_STAFF_ROLE, uses: ['property', 'reservations'] },

  { key: '/dashboard/reservations/availability-calendar', label: 'Availability Calendar', group: 'Operations', feature: 'Reservations', module: 'reservations', roles: EVERY_STAFF_ROLE, uses: ['reservations'] },
  { key: '/dashboard/reservations/create', label: 'Create Reservation', group: 'Operations', feature: 'Reservations', module: 'reservations', roles: [FD, AC], actRoles: [FD], uses: ['reservations', 'guests', 'property'] },
  { key: '/dashboard/reservations/modify', label: 'Modify Reservation', group: 'Operations', feature: 'Reservations', module: 'reservations', roles: EVERY_STAFF_ROLE, actRoles: [FD], uses: ['reservations', 'property'] },
  { key: '/dashboard/reservations/cancel', label: 'Cancel Reservation', group: 'Operations', feature: 'Reservations', module: 'reservations', roles: [FD], actRoles: [FD], uses: ['reservations'] },
  { key: '/dashboard/reservations/waitlist', label: 'Waitlist Management', group: 'Operations', feature: 'Reservations', module: 'reservations', roles: EVERY_STAFF_ROLE, actRoles: [FD], uses: ['reservations'] },

  { key: '/dashboard/housekeeping/task-board', label: 'Task Board', group: 'Operations', feature: 'Housekeeping', module: 'housekeeping', roles: [FD, HK], actRoles: [FD, HK], uses: ['housekeeping', 'property'] },
  // Assigning rooms and passing inspection are a supervisor's (owner or manager) — staff can watch.
  { key: '/dashboard/housekeeping/staff-assignment', label: 'Staff Assignment', group: 'Operations', feature: 'Housekeeping', module: 'housekeeping', roles: [FD, HK], actRoles: [], uses: ['housekeeping', 'property'] },
  { key: '/dashboard/housekeeping/inspection-workflow', label: 'Inspection Workflow', group: 'Operations', feature: 'Housekeeping', module: 'property', roles: EVERY_STAFF_ROLE, actRoles: [], uses: ['housekeeping', 'property'] },
  { key: '/dashboard/housekeeping/room-blocking', label: 'Room Blocking / OOO', group: 'Operations', feature: 'Housekeeping', module: 'property', roles: EVERY_STAFF_ROLE, actRoles: [], uses: ['housekeeping', 'property'] },

  { key: '/dashboard/billing/folios', label: 'Guest Folios', group: 'Operations', feature: 'Billing & Payments', module: 'folios', roles: EVERY_STAFF_ROLE, actRoles: [FD, AC], uses: ['folios', 'loyalty'] },
  { key: '/dashboard/split-billing', label: 'Split Billing', group: 'Operations', feature: 'Billing & Payments', module: 'folios', roles: EVERY_STAFF_ROLE, actRoles: [FD, AC], uses: ['folios'] },
  { key: '/dashboard/night-audit', label: 'Night Audit', group: 'Operations', feature: 'Billing & Payments', module: 'night_audit', roles: EVERY_STAFF_ROLE, actRoles: [], uses: ['night_audit'] },
  { key: '/dashboard/billing/refunds', label: 'Refunds & Corrections', group: 'Operations', feature: 'Billing & Payments', module: 'folios', roles: [FD, AC], actRoles: [FD, AC], uses: ['folios'] },

  { key: '/dashboard/folio-transfer/transfer', label: 'Transfer Charges', group: 'Operations', feature: 'Folio Transfer', module: 'folios', roles: EVERY_STAFF_ROLE, actRoles: [FD, AC], uses: ['folios', 'loyalty'] },
  { key: '/dashboard/folio-transfer/secondary-folio', label: 'Create Secondary Folio', group: 'Operations', feature: 'Folio Transfer', module: 'folios', roles: [FD, AC], actRoles: [FD, AC], uses: ['folios', 'guests', 'reservations'] },
  { key: '/dashboard/folio-transfer/history', label: 'Transfer History', group: 'Operations', feature: 'Folio Transfer', module: 'folios', roles: [FD, AC], actRoles: [], uses: ['folios'] },

  { key: '/dashboard/pos/terminal', label: 'POS Terminal', group: 'Operations', feature: 'Point of Sale', module: 'pos', roles: [FD, POS], actRoles: [FD, POS], uses: ['pos'] },
  // Staff mark items unavailable; building the menu is a manager's.
  { key: '/dashboard/pos/menu', label: 'Menu Management', group: 'Operations', feature: 'Point of Sale', module: 'pos', roles: [FD, POS], actRoles: [FD, POS], uses: ['pos'] },

  { key: '/dashboard/shifts', label: 'Shift Management', group: 'Operations', feature: 'Shift Management', module: 'shifts', roles: EVERY_STAFF_ROLE, actRoles: [FD, POS], uses: ['shifts'] },
  { key: '/dashboard/no-shows', label: 'No-Show Handling', group: 'Operations', feature: 'No-Show Handling', module: 'reservations', roles: EVERY_STAFF_ROLE, actRoles: [FD], uses: ['reservations'] },
  { key: '/dashboard/registration-cards', label: 'Guest Reg. Card', group: 'Operations', feature: 'Guest Reg. Card', module: 'guests', roles: [FD], actRoles: [FD], uses: ['guests', 'property', 'reservations'] },
  { key: '/dashboard/comms-log', label: 'Comms Log', group: 'Operations', feature: 'Comms Log', module: 'comms', roles: [FD], actRoles: [FD], uses: ['comms', 'reservations'] },

  // --- Management -------------------------------------------------------------------------------------------------
  { key: '/dashboard/reservations/rate-plans', label: 'Rate Resolver', group: 'Management', feature: 'Rate Resolver', module: 'reservations', roles: EVERY_STAFF_ROLE, actRoles: [], uses: ['reservations', 'property'] },
  { key: '/dashboard/guests/profiles', label: 'Guest Profiles', group: 'Management', feature: 'Guest Profiles & CRM', module: 'guests', roles: [FD], actRoles: [FD], uses: ['guests', 'loyalty'] },
  { key: '/dashboard/guests/corporate', label: 'Corporate Accounts', group: 'Management', feature: 'Guest Profiles & CRM', module: 'guests', roles: [FD, AC], actRoles: [], uses: ['guests', 'reservations'] },
  { key: '/dashboard/sales-events', label: 'Sales & Events', group: 'Management', feature: 'Sales & Events', module: 'sales_events', roles: [FD], actRoles: [FD], uses: ['sales_events', 'property'] },
  { key: '/dashboard/maintenance', label: 'Maintenance', group: 'Management', feature: 'Maintenance', module: 'maintenance', roles: EVERY_STAFF_ROLE, actRoles: EVERY_STAFF_ROLE, uses: ['maintenance', 'property'] },
  { key: '/dashboard/reports/operational', label: 'Operational Reports', group: 'Management', feature: 'Reports & Analytics', module: 'reports', roles: [FD, AC], uses: ['reports', 'property'] },
  { key: '/dashboard/reports/financial', label: 'Financial Reports', group: 'Management', feature: 'Reports & Analytics', module: 'reports', roles: [AC], uses: ['reports'] },
  { key: '/dashboard/reports/custom', label: 'Custom Report Builder', group: 'Management', feature: 'Reports & Analytics', module: 'reports', roles: [AC], actRoles: [AC], uses: ['reports'] },

  // --- Admin --------------------------------------------------------------------------------------------------------
  // Accounting exports live here; no permission module covers it, so no custom role can be given it.
  { key: '/dashboard/integrations/marketplace', label: 'Integrations Marketplace', group: 'Admin', feature: 'Integrations & APIs', module: null, roles: [AC], actRoles: [AC], uses: [] },
];

/** Pages only owners and managers can use — listed on Page Access so a manager knows why they aren't offered. */
export const MANAGER_ONLY_PAGES: readonly string[] = [
  'Manager Dashboard',
  'Staff Management',
  'Overbooking Mgmt',
  'Revenue Management',
  'Loyalty & Marketing',
  'Email Campaigns',
  'Property Config',
  'Integrations & APIs',
  'Security & Roles',
  'System Admin',
  'Enterprise / HQ',
];

export const PAGE_KEYS: ReadonlySet<string> = new Set(PAGE_CATALOGUE.map((page) => page.key));
