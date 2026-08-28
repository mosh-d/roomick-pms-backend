import { Injectable, NotFoundException } from '@nestjs/common';
import { CommsChannel, CommunicationLog } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { SendCommunicationDto } from './dto/comms-log.dto';

/**
 * "Every automated and manual message logged per reservation and guest
 * profile" (MVP timeline Month 5). `CommunicationLog.deliveryStatus`
 * stays `queued` for every row this pass writes — the schema's own comment
 * says the sending adapter is stubbed for MVP, and that's still true here:
 * this module is the LOG, not a mailer. The log itself is the real
 * deliverable (dispute resolution needs a record that a message was meant
 * to go out and what it said, independent of whether delivery is wired up
 * yet).
 */
@Injectable()
export class CommsLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Called from inside an already-open reservation-lifecycle transaction
   * (booking, check-in, check-out, no-show, cancel) — never opens its own,
   * so a comms-log write can never desync from the event that triggered it.
   */
  async logAutomatedInTx(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
    params: { reservationId?: string; guestId: string; channel: CommsChannel; subject?: string; body: string; trigger: string },
  ): Promise<CommunicationLog> {
    return tx.communicationLog.create({
      data: {
        tenantId,
        branchId,
        reservationId: params.reservationId,
        guestId: params.guestId,
        channel: params.channel,
        subject: params.subject,
        body: params.body,
        trigger: params.trigger,
        deliveryStatus: 'queued',
        sentBy: null,
      },
    });
  }

  async sendManual(tenantId: string, reservationId: string, dto: SendCommunicationDto, actorId: string): Promise<CommunicationLog> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await tx.reservation.findFirst({ where: { id: reservationId } });
      if (!reservation) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Reservation not found' });
      }
      return tx.communicationLog.create({
        data: {
          tenantId,
          branchId: reservation.branchId,
          reservationId,
          guestId: reservation.guestId,
          channel: dto.channel,
          subject: dto.subject,
          body: dto.body,
          trigger: 'manual',
          deliveryStatus: 'queued',
          sentBy: actorId,
        },
      });
    });
  }

  async listForReservation(tenantId: string, reservationId: string): Promise<CommunicationLog[]> {
    return this.prisma.withTenant(tenantId, (tx) => tx.communicationLog.findMany({ where: { reservationId }, orderBy: { sentAt: 'desc' } }));
  }

  async listForGuest(tenantId: string, guestId: string, from?: string, to?: string): Promise<CommunicationLog[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.communicationLog.findMany({
        where: {
          guestId,
          ...(from || to ? { sentAt: { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined } } : {}),
        },
        orderBy: { sentAt: 'desc' },
      }),
    );
  }
}
