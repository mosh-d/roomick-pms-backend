import { SetMetadata } from '@nestjs/common';

export const BRANCH_OF_KEY = 'branchOf';

/** The records a route can be addressed by that belong to one branch — see `RECORD_BRANCH` for how each finds its branch. */
export type BranchRecord =
  | 'reservation'
  | 'noShowRecord'
  | 'folio'
  | 'floor'
  | 'folioTransfer'
  | 'groupBlock'
  | 'refund'
  | 'lineItem'
  | 'registrationCard'
  | 'maintenanceOrder'
  | 'building'
  | 'room'
  | 'roomType'
  | 'roomBlock'
  | 'ratePlan'
  | 'availabilityRestriction'
  | 'shift'
  | 'shiftIssue';

export interface BranchOfMetadata {
  record: BranchRecord;
  /** The route param holding the record's id. */
  param: string;
}

/**
 * Says which branch a route addressed by a record's own id acts in, so
 * `RolesGuard` checks the role THERE. Without it, a route like
 * `POST /folios/:folioId/payments` names no branch, and the guard accepted a
 * role held at any branch of the tenant — a front-desk agent at one property
 * could post to another property's bills.
 *
 * Usage: `@BranchOf('folio', 'folioId')` beside the route's `@Roles`.
 */
export const BranchOf = (record: BranchRecord, param: string): MethodDecorator => SetMetadata(BRANCH_OF_KEY, { record, param } satisfies BranchOfMetadata);
