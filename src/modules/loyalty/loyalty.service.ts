import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface LoyaltyMember {
  id: string;
  name: string;
  email: string | null;
  loyaltyTier: string;
  loyaltyPoints: number;
}

export interface LoyaltyTierSummary {
  tier: string;
  memberCount: number;
  totalPoints: number;
}

export interface LoyaltySummary {
  members: LoyaltyMember[];
  byTier: LoyaltyTierSummary[];
  totalMembers: number;
  totalPointsIssued: number;
}

/**
 * Loyalty & Marketing's own "display-only slice" — scoped that way from the
 * start of this Management/Admin sequence (see the sequence's own memory
 * note): `GuestProfile.loyaltyTier`/`loyaltyPoints` have existed since the
 * Guest Profiles & CRM pass, editable per-guest, but nothing anywhere
 * surfaced them in aggregate. This reads that same data across every guest
 * — no points-earning rules, no tier-benefit definitions, no redemption —
 * none of that exists as a real system anywhere in this schema (`loyaltyTier`
 * is a free-text column, not a foreign key into a tiers table), so this
 * service doesn't invent one. Program config and campaign sending (the
 * reference's other two cards) stay genuinely unbuilt.
 */
@Injectable()
export class LoyaltyService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(tenantId: string): Promise<LoyaltySummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const guests = await tx.guestProfile.findMany({
        where: { deletedAt: null, OR: [{ loyaltyTier: { not: null } }, { loyaltyPoints: { gt: 0 } }] },
        select: { id: true, name: true, email: true, loyaltyTier: true, loyaltyPoints: true },
        orderBy: { loyaltyPoints: 'desc' },
      });

      const members: LoyaltyMember[] = guests.map((g) => ({
        id: g.id,
        name: g.name,
        email: g.email,
        loyaltyTier: g.loyaltyTier ?? 'Untiered',
        loyaltyPoints: g.loyaltyPoints ?? 0,
      }));

      const byTierMap = new Map<string, { memberCount: number; totalPoints: number }>();
      for (const m of members) {
        const entry = byTierMap.get(m.loyaltyTier) ?? { memberCount: 0, totalPoints: 0 };
        entry.memberCount += 1;
        entry.totalPoints += m.loyaltyPoints;
        byTierMap.set(m.loyaltyTier, entry);
      }
      const byTier: LoyaltyTierSummary[] = [...byTierMap.entries()]
        .map(([tier, v]) => ({ tier, ...v }))
        .sort((a, b) => b.totalPoints - a.totalPoints);

      return {
        members,
        byTier,
        totalMembers: members.length,
        totalPointsIssued: members.reduce((sum, m) => sum + m.loyaltyPoints, 0),
      };
    });
  }
}
