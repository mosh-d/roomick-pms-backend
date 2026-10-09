import { NotFoundException } from '@nestjs/common';
import { GuestProfile, LoyaltyTxType, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { TenantTx } from '../../prisma/prisma.service';
import { LoyaltyTier, parseTiers, tierFor } from './loyalty-rules';

/**
 * The points ledger's own writes, shared by the loyalty programme and by
 * whatever else has to move points in the same transaction as its own work —
 * voiding a payment made with points puts them back. Plain functions over a
 * transaction rather than a service, so the bills module can use them
 * without depending on the loyalty module (which depends on it).
 */

export type LoyaltyEntry = {
  type: LoyaltyTxType;
  points: number;
  description: string;
  branchId?: string;
  earnReservationId?: string;
  paymentId?: string;
  /** Earned points only: when they lapse, if the programme lets points expire. */
  expiresAt?: Date | null;
  actorId: string | null;
};

/**
 * What lifetime points count: everything earned or added. Never what was
 * spent, and never a spend put back (a voided points payment's points come
 * back as a `reversal` row) — that isn't an earning, and counting it would
 * lift a member's tier for nothing.
 */
export const LIFETIME_POINTS_WHERE = { points: { gt: 0 }, type: { in: ['earn', 'adjust'] as LoyaltyTxType[] } } satisfies Prisma.LoyaltyTransactionWhereInput;

export async function findLoyaltyGuest(tx: TenantTx, guestId: string): Promise<GuestProfile> {
  const guest = await tx.guestProfile.findFirst({ where: { id: guestId, deletedAt: null } });
  if (!guest) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
  return guest;
}

/** Serialises everything that moves one guest's points: two redemptions at once can't both spend the same balance. */
export async function lockLoyaltyGuest(tx: TenantTx, guestId: string): Promise<GuestProfile> {
  await tx.$queryRaw`SELECT id FROM guest_profiles WHERE id = ${guestId}::uuid FOR UPDATE`;
  return findLoyaltyGuest(tx, guestId);
}

/** Everything ever earned or added — what tiers go by. Never falls when points are spent. */
export async function lifetimeLoyaltyPoints(tx: TenantTx, guestId: string): Promise<number> {
  const sum = await tx.loyaltyTransaction.aggregate({ _sum: { points: true }, where: { guestId, ...LIFETIME_POINTS_WHERE } });
  return sum._sum.points ?? 0;
}

/** Writes one ledger row and moves the balance and tier with it. Callers hold the guest row lock (`lockLoyaltyGuest`). */
export async function applyLoyaltyPoints(tx: TenantTx, tenantId: string, guest: GuestProfile, entry: LoyaltyEntry): Promise<{ upgradedTo: LoyaltyTier | null }> {
  await tx.loyaltyTransaction.create({
    data: {
      tenantId,
      guestId: guest.id,
      branchId: entry.branchId,
      type: entry.type,
      points: entry.points,
      description: entry.description.slice(0, 300),
      earnReservationId: entry.earnReservationId,
      paymentId: entry.paymentId,
      expiresAt: entry.expiresAt ?? null,
      createdBy: entry.actorId,
    },
  });

  const program = await tx.loyaltyProgram.findUnique({ where: { tenantId } });
  const tiers = parseTiers(program?.tiers);
  const lifetime = await lifetimeLoyaltyPoints(tx, guest.id);
  const reached = program ? tierFor(tiers, lifetime) : null;
  const before = tiers.findIndex((tier) => tier.name === guest.loyaltyTier);
  const after = reached ? tiers.indexOf(reached) : -1;

  await tx.guestProfile.update({
    where: { id: guest.id },
    data: {
      loyaltyPoints: { increment: entry.points },
      loyaltyTier: program ? (reached?.name ?? null) : guest.loyaltyTier,
      loyaltyEnrolledAt: guest.loyaltyEnrolledAt ?? new Date(),
    },
  });
  return { upgradedTo: reached && after > before ? reached : null };
}
