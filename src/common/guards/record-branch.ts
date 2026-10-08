import { TenantTx } from '../../prisma/prisma.service';
import { BranchRecord } from '../decorators/branch-of.decorator';

type Lookup = (tx: TenantTx, id: string) => Promise<string | null | undefined>;

/**
 * How each branch-owned record finds its branch, for `@BranchOf`. Every
 * lookup runs inside the caller's tenant (row-level security), so a record
 * from another tenant simply isn't found. A record that isn't found returns
 * nothing — the service behind the route answers 404 as it always did.
 */
export const RECORD_BRANCH: Record<BranchRecord, Lookup> = {
  reservation: async (tx, id) => (await tx.reservation.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  noShowRecord: async (tx, id) => (await tx.noShowRecord.findFirst({ where: { id }, select: { reservation: { select: { branchId: true } } } }))?.reservation.branchId,
  folio: async (tx, id) => (await tx.folio.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  folioTransfer: async (tx, id) => (await tx.folioTransfer.findFirst({ where: { id }, select: { sourceFolio: { select: { branchId: true } } } }))?.sourceFolio.branchId,
  floor: async (tx, id) => (await tx.floor.findFirst({ where: { id }, select: { building: { select: { branchId: true } } } }))?.building.branchId,
  groupBlock: async (tx, id) => (await tx.groupBlock.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  refund: async (tx, id) => (await tx.refund.findFirst({ where: { id }, select: { folio: { select: { branchId: true } } } }))?.folio.branchId,
  lineItem: async (tx, id) => (await tx.lineItem.findFirst({ where: { id }, select: { folio: { select: { branchId: true } } } }))?.folio.branchId,
  registrationCard: async (tx, id) => (await tx.registrationCard.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  maintenanceOrder: async (tx, id) => (await tx.maintenanceOrder.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  building: async (tx, id) => (await tx.building.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  room: async (tx, id) => (await tx.room.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  roomType: async (tx, id) => (await tx.roomType.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  roomBlock: async (tx, id) => (await tx.roomBlock.findFirst({ where: { id }, select: { room: { select: { branchId: true } } } }))?.room.branchId,
  ratePlan: async (tx, id) => (await tx.ratePlan.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  availabilityRestriction: async (tx, id) => (await tx.availabilityRestriction.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  shift: async (tx, id) => (await tx.shift.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  shiftIssue: async (tx, id) => (await tx.shiftIssue.findFirst({ where: { id }, select: { shift: { select: { branchId: true } } } }))?.shift.branchId,
  // Outlets, menus and orders, events, comp-set competitors, tax rules and
  // saved reports were reachable across branches by id — a manager at one
  // property could act on another's by guessing a UUID.
  outlet: async (tx, id) => (await tx.outlet.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  menuItem: async (tx, id) => (await tx.menuItem.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  posOrder: async (tx, id) => (await tx.posOrder.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  eventSpace: async (tx, id) => (await tx.eventSpace.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  eventBooking: async (tx, id) => (await tx.eventBooking.findFirst({ where: { id }, select: { eventSpace: { select: { branchId: true } } } }))?.eventSpace.branchId,
  competitor: async (tx, id) => (await tx.competitor.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  taxRule: async (tx, id) => (await tx.taxRule.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
  reportTemplate: async (tx, id) => (await tx.reportTemplate.findFirst({ where: { id }, select: { branchId: true } }))?.branchId,
};
