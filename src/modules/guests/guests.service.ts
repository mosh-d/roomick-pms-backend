import { Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateGuestDto } from './dto/guest.dto';

/** Deliberately excludes ID-document/loyalty/preference fields — see `CreateGuestDto`'s own header comment. */
const GUEST_SUMMARY_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type GuestSummary = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class GuestsService {
  constructor(private readonly prisma: PrismaService) {}

  async createGuest(tenantId: string, dto: CreateGuestDto): Promise<GuestSummary> {
    return this.prisma.withTenant(tenantId, (tx) => this.createGuestInTx(tx, tenantId, dto));
  }

  async getGuestById(tenantId: string, guestId: string): Promise<GuestSummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const guest = await tx.guestProfile.findFirst({
        where: { id: guestId, deletedAt: null },
        select: GUEST_SUMMARY_SELECT,
      });
      if (!guest) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      }
      return guest;
    });
  }

  async searchGuests(tenantId: string, q: string): Promise<GuestSummary[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.guestProfile.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: GUEST_SUMMARY_SELECT,
        orderBy: { name: 'asc' },
        take: 20,
      }),
    );
  }

  /**
   * Resolves a guest inside an ALREADY-OPEN transaction — the shape
   * `PropertyService.assertBranch`/`findOrCreateDefaultFloor` already
   * establish for cross-service calls within one `withTenant` block, so
   * `ReservationsService` can resolve a guest without a second round trip.
   */
  async findOrCreateGuestInTx(
    tx: TenantTx,
    tenantId: string,
    input: { guestId: string } | { guest: CreateGuestDto },
  ): Promise<GuestSummary> {
    if ('guestId' in input) {
      const guest = await tx.guestProfile.findFirst({
        where: { id: input.guestId, deletedAt: null },
        select: GUEST_SUMMARY_SELECT,
      });
      if (!guest) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      }
      return guest;
    }
    return this.createGuestInTx(tx, tenantId, input.guest);
  }

  private async createGuestInTx(tx: TenantTx, tenantId: string, dto: CreateGuestDto): Promise<GuestSummary> {
    return tx.guestProfile.create({
      data: { tenantId, name: dto.name, email: dto.email, phone: dto.phone, notes: dto.notes },
      select: GUEST_SUMMARY_SELECT,
    });
  }
}
