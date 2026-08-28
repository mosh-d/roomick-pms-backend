import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RegistrationCard } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { SignRegistrationCardDto } from './dto/registration-card.dto';

/** Fields `generateCardInTx` needs off a reservation — a subset of `RESERVATION_INCLUDE`'s own shape, not the full thing, so callers with a narrower fetch (this module's own standalone `generateCard`) don't have to over-fetch to match it. */
interface ReservationForCard {
  id: string;
  tenantId: string;
  branchId: string;
  guestId: string;
  confirmationNumber: string;
  confirmedRate: Prisma.Decimal;
  checkInDate: Date;
  checkOutDate: Date;
  adults: number;
  children: number;
  guest: { name: string; email: string | null; phone: string | null };
  roomType: { name: string };
  room: { number: string } | null;
  branch: { currency: string; regCardTemplate: Prisma.JsonValue };
}

const CARD_INCLUDE = {
  guest: { select: { name: true, email: true, phone: true } },
  roomType: { select: { name: true } },
  room: { select: { number: true } },
  branch: { select: { currency: true, regCardTemplate: true } },
} as const;

@Injectable()
export class RegistrationCardsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Called from `ReservationsService.checkIn`/`walkIn`, inside their own
   * transaction — "auto-generated when check-in is triggered" (ref). Idem-
   * potent on `reservationId` (mirrors `ensurePrimaryFolio`'s own "covers
   * reservations that predate this module" reasoning): re-checking in
   * never happens, but the standalone `generateCard` below exists
   * specifically for a reservation that was checked in before this module
   * existed, and it must be safe to call more than once.
   *
   * ID-document fields (nationality, doc type/number) are deliberately
   * absent from the snapshot — `CreateGuestDto` doesn't collect them yet
   * (ID capture + its required encryption are still unbuilt, named
   * elsewhere), so there is nothing real to snapshot. `RoomType`/`Room`
   * are already display data; no PII beyond what the guest record itself
   * already holds.
   */
  async generateCardInTx(tx: TenantTx, tenantId: string, reservation: ReservationForCard, actorId: string): Promise<RegistrationCard> {
    const existing = await tx.registrationCard.findFirst({ where: { reservationId: reservation.id } });
    if (existing) return existing;

    const template = (reservation.branch.regCardTemplate ?? {}) as { houseRules?: string; logoUrl?: string; language?: string };
    const fields = {
      guestName: reservation.guest.name,
      guestEmail: reservation.guest.email,
      guestPhone: reservation.guest.phone,
      roomNumber: reservation.room?.number ?? null,
      roomType: reservation.roomType.name,
      checkInDate: reservation.checkInDate.toISOString().slice(0, 10),
      checkOutDate: reservation.checkOutDate.toISOString().slice(0, 10),
      adults: reservation.adults,
      children: reservation.children,
      rate: reservation.confirmedRate.toFixed(2),
      currency: reservation.branch.currency,
      confirmationNumber: reservation.confirmationNumber,
      houseRules: template.houseRules ?? null,
      logoUrl: template.logoUrl ?? null,
    };

    const card = await tx.registrationCard.create({
      data: {
        tenantId,
        branchId: reservation.branchId,
        reservationId: reservation.id,
        guestId: reservation.guestId,
        fields,
      },
    });
    await this.audit(tx, tenantId, reservation.branchId, actorId, 'registration_card.generated', card.id, { reservationId: reservation.id });
    return card;
  }

  /** The manual trigger — a reservation checked in before this module existed, or check-in via a path that predates the hook. Same idempotency guard as the in-transaction version. */
  async generateCard(tenantId: string, reservationId: string, actorId: string): Promise<RegistrationCard> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await tx.reservation.findFirst({ where: { id: reservationId, deletedAt: null }, include: CARD_INCLUDE });
      if (!reservation) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Reservation not found' });
      }
      if (reservation.status !== 'checked_in') {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot generate a registration card for a reservation with status "${reservation.status}" — only a checked-in stay has a room and arrival to record`,
        });
      }
      return this.generateCardInTx(tx, tenantId, reservation, actorId);
    });
  }

  async getCard(tenantId: string, cardId: string): Promise<RegistrationCard> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const card = await tx.registrationCard.findFirst({ where: { id: cardId } });
      if (!card) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Registration card not found' });
      }
      return card;
    });
  }

  async getCardForReservation(tenantId: string, reservationId: string): Promise<RegistrationCard | null> {
    return this.prisma.withTenant(tenantId, (tx) => tx.registrationCard.findFirst({ where: { reservationId } }));
  }

  /**
   * A legal document, signed once — re-signing isn't an edit path (see
   * the reference's own framing, "not an afterthought"). A genuine
   * mistake needs a fresh card, not a silently overwritten signature.
   */
  async signCard(tenantId: string, cardId: string, dto: SignRegistrationCardDto, actorId: string): Promise<RegistrationCard> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const card = await tx.registrationCard.findFirst({ where: { id: cardId } });
      if (!card) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Registration card not found' });
      }
      if (card.signedAt) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This card is already signed' });
      }
      const updated = await tx.registrationCard.update({
        where: { id: cardId },
        data: { signatureData: dto.signatureData, signedAt: new Date(), witnessedBy: actorId },
      });
      await this.audit(tx, tenantId, card.branchId, actorId, 'registration_card.signed', cardId, { reservationId: card.reservationId });
      return updated;
    });
  }

  private async audit(tx: TenantTx, tenantId: string, branchId: string, userId: string, action: string, entityId: string, after?: Prisma.InputJsonValue): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId, userId, action, entityType: 'registration_card', entityId, after } });
  }
}
