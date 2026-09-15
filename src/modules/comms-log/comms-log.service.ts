import { Injectable, NotFoundException } from '@nestjs/common';
import { CommsChannel, CommsDirection, CommunicationLog } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { InboxReplyDto, SendCommunicationDto } from './dto/comms-log.dto';

/** What a guest can tag a message as, and how staff see it. Anything untagged is an ordinary message. */
export const GUEST_REQUEST_LABELS = {
  late_checkout: 'Late check-out request',
  housekeeping: 'Housekeeping request',
} as const;
export type GuestRequestType = keyof typeof GUEST_REQUEST_LABELS;

const INBOX_LIMIT = 100;
const THREAD_LIMIT = 200;
const GUEST_THREAD_LIMIT = 100;
const PREVIEW_LENGTH = 160;

const RESERVATION_SUMMARY = {
  id: true,
  confirmationNumber: true,
  status: true,
  checkInDate: true,
  checkOutDate: true,
  room: { select: { number: true } },
} as const;

export interface InboxConversation {
  guest: { id: string; name: string; email: string | null; phone: string | null };
  /** The guest's most recent booking at this branch — what a reply attaches to when there's no more specific one. */
  reservation: { id: string; confirmationNumber: string; status: string; checkInDate: Date; checkOutDate: Date; room: { number: string } | null } | null;
  lastMessage: { direction: CommsDirection; channel: CommsChannel; trigger: string; preview: string; sentAt: Date };
  unreadCount: number;
}

/**
 * "Every automated and manual message logged per reservation and guest
 * profile" (MVP timeline Month 5) — and, since Month 9, what guests send back
 * (`direction: 'inbound'`), so one inbox can thread both directions.
 *
 * This module is the LOG, not the mailer: rows are written here and delivery
 * is `CommsDispatcherService`'s job, on a scheduled pass strictly after the
 * surrounding transaction commits. `logAutomatedInTx` runs inside an open
 * reservation transaction, and sending from there would mean network I/O
 * under row locks plus real email already delivered for a booking that then
 * rolled back. See that service's own header for the full reasoning.
 *
 * Channels today: email has a (log) transport; `in_app_chat` is the guest's
 * own "Manage your booking" page, where a staff reply is readable the moment
 * it's written; sms/push have no transport and stay `queued`.
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

  // -------------------------------------------------------------------------
  // Unified inbox (growth plan Month 9)
  // -------------------------------------------------------------------------

  /**
   * One conversation per guest who has written in, whatever channel they used
   * — "grouped by guest, newest first". A guest the property has only ever
   * sent automated notices to isn't a conversation, so they don't appear;
   * once they write, their thread includes those notices too.
   */
  async listInbox(tenantId: string, branchId: string, filter: 'all' | 'unread' = 'all'): Promise<InboxConversation[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const writers = await tx.communicationLog.findMany({
        where: { branchId, direction: 'inbound', ...(filter === 'unread' ? { readAt: null } : {}) },
        orderBy: { sentAt: 'desc' },
        distinct: ['guestId'],
        select: { guestId: true },
        take: INBOX_LIMIT,
      });

      const conversations: InboxConversation[] = [];
      for (const { guestId } of writers) {
        const guest = await tx.guestProfile.findFirst({ where: { id: guestId }, select: { id: true, name: true, email: true, phone: true } });
        const last = await tx.communicationLog.findFirst({ where: { branchId, guestId }, orderBy: { sentAt: 'desc' } });
        if (!guest || !last) continue;
        const unreadCount = await tx.communicationLog.count({ where: { branchId, guestId, direction: 'inbound', readAt: null } });
        const reservation = await tx.reservation.findFirst({
          where: { branchId, guestId, deletedAt: null },
          orderBy: { checkInDate: 'desc' },
          select: RESERVATION_SUMMARY,
        });
        conversations.push({
          guest,
          reservation,
          lastMessage: {
            direction: last.direction,
            channel: last.channel,
            trigger: last.trigger,
            preview: last.body.length > PREVIEW_LENGTH ? `${last.body.slice(0, PREVIEW_LENGTH)}…` : last.body,
            sentAt: last.sentAt,
          },
          unreadCount,
        });
      }
      return conversations.sort((a, b) => b.lastMessage.sentAt.getTime() - a.lastMessage.sentAt.getTime());
    });
  }

  /** Everything between the property and this guest at this branch, both directions, automated notices included — oldest first. */
  async getThread(tenantId: string, branchId: string, guestId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const guest = await tx.guestProfile.findFirst({ where: { id: guestId }, select: { id: true, name: true, email: true, phone: true } });
      if (!guest) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      }
      const reservations = await tx.reservation.findMany({
        where: { branchId, guestId, deletedAt: null },
        orderBy: { checkInDate: 'desc' },
        select: RESERVATION_SUMMARY,
        take: 20,
      });
      // Newest THREAD_LIMIT, then back into reading order.
      const messages = await tx.communicationLog.findMany({ where: { branchId, guestId }, orderBy: { sentAt: 'desc' }, take: THREAD_LIMIT });
      return { guest, reservations, messages: messages.reverse() };
    });
  }

  async markThreadRead(tenantId: string, branchId: string, guestId: string): Promise<{ marked: number }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const { count } = await tx.communicationLog.updateMany({
        where: { branchId, guestId, direction: 'inbound', readAt: null },
        data: { readAt: new Date() },
      });
      return { marked: count };
    });
  }

  /**
   * A staff reply from the inbox. It attaches to the booking the guest last
   * wrote about (or, failing that, their most recent booking here), and
   * replying marks the thread read.
   *
   * `in_app_chat` is 'sent' the moment it's written: the guest's own portal
   * page is its transport, and it's readable there immediately. Email waits
   * for the dispatcher like any other outbound email; SMS has no transport
   * yet and stays `queued`, honestly.
   */
  async replyInThread(tenantId: string, branchId: string, guestId: string, dto: InboxReplyDto, actorId: string): Promise<CommunicationLog> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const lastInbound = await tx.communicationLog.findFirst({
        where: { branchId, guestId, direction: 'inbound', reservationId: { not: null } },
        orderBy: { sentAt: 'desc' },
        select: { reservationId: true },
      });
      const reservationId =
        lastInbound?.reservationId ??
        (await tx.reservation.findFirst({ where: { branchId, guestId, deletedAt: null }, orderBy: { checkInDate: 'desc' }, select: { id: true } }))?.id;
      if (!reservationId) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'This guest has no booking at this property to reply on' });
      }

      const reply = await tx.communicationLog.create({
        data: {
          tenantId,
          branchId,
          reservationId,
          guestId,
          channel: dto.channel,
          subject: dto.channel === 'email' ? dto.subject : undefined,
          body: dto.body,
          trigger: 'manual',
          direction: 'outbound',
          deliveryStatus: dto.channel === 'in_app_chat' ? 'sent' : 'queued',
          sentBy: actorId,
        },
      });
      await tx.communicationLog.updateMany({ where: { branchId, guestId, direction: 'inbound', readAt: null }, data: { readAt: new Date() } });
      return reply;
    });
  }

  /**
   * A guest writing in. Today that's the "Manage your booking" page
   * (`in_app_chat`); a provider webhook for SMS/WhatsApp/email would land here
   * too, with its own channel. `delivered` because it has arrived — the
   * delivery-status vocabulary is outbound-shaped, and "received" is the
   * honest reading of it for a message coming in.
   */
  async logGuestMessageInTx(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
    params: { reservationId: string; guestId: string; body: string; requestType?: GuestRequestType },
  ): Promise<CommunicationLog> {
    return tx.communicationLog.create({
      data: {
        tenantId,
        branchId,
        reservationId: params.reservationId,
        guestId: params.guestId,
        channel: 'in_app_chat',
        direction: 'inbound',
        subject: params.requestType ? GUEST_REQUEST_LABELS[params.requestType] : null,
        body: params.body,
        trigger: params.requestType ? 'guest_request' : 'guest_message',
        deliveryStatus: 'delivered',
        sentBy: null,
      },
    });
  }

  /**
   * What a guest sees of their conversation about one booking: what they
   * wrote and what staff wrote back. The automated notices are the property's
   * record, not the conversation, so they're left out.
   */
  async guestThreadInTx(tx: TenantTx, reservationId: string): Promise<CommunicationLog[]> {
    const rows = await tx.communicationLog.findMany({
      where: { reservationId, OR: [{ direction: 'inbound' }, { direction: 'outbound', trigger: 'manual' }] },
      orderBy: { sentAt: 'desc' },
      take: GUEST_THREAD_LIMIT,
    });
    return rows.reverse();
  }
}
