import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { TenantTx } from '../../prisma/prisma.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { RESERVATION_ACTION_EVENTS, WebhookEventType, WebhookPayload } from './webhook-events';

const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);
const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** A booking as a receiver sees it — the same shape in every reservation event. */
async function reservationView(tx: TenantTx, reservationId: string): Promise<Record<string, unknown>> {
  const r = await tx.reservation.findFirstOrThrow({
    where: { id: reservationId },
    include: {
      guest: { select: { id: true, name: true, email: true, phone: true } },
      roomType: { select: { id: true, name: true } },
      room: { select: { id: true, number: true } },
      branch: { select: { currency: true } },
    },
  });
  return {
    id: r.id,
    confirmationNumber: r.confirmationNumber,
    status: r.status,
    channel: r.channel,
    branchId: r.branchId,
    checkInDate: dateOnly(r.checkInDate),
    checkOutDate: dateOnly(r.checkOutDate),
    nights: Math.round((r.checkOutDate.getTime() - r.checkInDate.getTime()) / 86_400_000),
    adults: r.adults,
    children: r.children,
    roomType: r.roomType,
    room: r.room,
    guest: r.guest,
    roomTotal: r.confirmedRate.toFixed(2),
    nightlyRateOverride: r.overrideRate?.toFixed(2) ?? null,
    currency: r.branch.currency,
    specialRequests: r.specialRequests,
    groupBlockId: r.groupBlockId,
    corporateAccountId: r.corporateAccountId,
    actualCheckIn: iso(r.actualCheckIn),
    actualCheckOut: iso(r.actualCheckOut),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Money in or back out, with the bill, booking and guest it belongs to. */
async function paymentView(tx: TenantTx, paymentId: string): Promise<Record<string, unknown>> {
  const p = await tx.payment.findFirstOrThrow({
    where: { id: paymentId },
    include: {
      folio: {
        select: {
          id: true,
          label: true,
          payerName: true,
          reservation: { select: { id: true, confirmationNumber: true } },
          guest: { select: { id: true, name: true } },
        },
      },
    },
  });
  return {
    payment: {
      id: p.id,
      amount: p.amount.toFixed(2),
      currency: p.currency,
      method: p.method,
      purpose: p.paymentPurpose,
      reference: p.reference,
      recordedAt: p.recordedAt.toISOString(),
    },
    folio: { id: p.folio.id, label: p.folio.label, payerName: p.folio.payerName },
    reservation: p.folio.reservation,
    guest: p.folio.guest,
  };
}

/**
 * Raises webhook events — called inside the transaction that made the change,
 * so an event exists exactly when the change does.
 *
 * Finding who's listening is one indexed read; a tenant with no webhooks pays
 * nothing more. When somebody is, the payload is built there and then, so it
 * shows the booking or payment as it was at that moment, and one delivery is
 * queued per webhook for `WebhookDispatcherService` to send after commit.
 */
@Injectable()
export class WebhookEventsService {
  constructor(private readonly dispatcher: WebhookDispatcherService) {}

  async emit(
    tx: TenantTx,
    input: { tenantId: string; branchId: string; types: readonly WebhookEventType[]; build: () => Promise<Record<string, unknown>> },
  ): Promise<void> {
    const webhooks = await tx.webhook.findMany({
      where: { isActive: true, eventTypes: { hasSome: [...input.types] }, OR: [{ branchId: null }, { branchId: input.branchId }] },
      select: { id: true, eventTypes: true },
    });
    if (webhooks.length === 0) return;

    const data = await input.build();
    const createdAt = new Date().toISOString();
    const rows: Prisma.WebhookDeliveryCreateManyInput[] = [];
    for (const type of input.types) {
      const payload: WebhookPayload = { id: randomUUID(), type, createdAt, tenantId: input.tenantId, branchId: input.branchId, data };
      for (const webhook of webhooks) {
        if (!webhook.eventTypes.includes(type)) continue;
        rows.push({ tenantId: input.tenantId, webhookId: webhook.id, eventId: payload.id, eventType: type, payload: payload as unknown as Prisma.InputJsonObject });
      }
    }
    await tx.webhookDelivery.createMany({ data: rows });
    this.dispatcher.kick(input.tenantId);
  }

  /** A reservation's audit action, as the webhook events it is (`RESERVATION_ACTION_EVENTS`). A room move also says where the guest came from. */
  async reservationChanged(
    tx: TenantTx,
    input: { tenantId: string; branchId: string; action: string; reservationId: string; previousRoomId?: string },
  ): Promise<void> {
    const types = RESERVATION_ACTION_EVENTS[input.action];
    if (!types) return;
    await this.emit(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
      types,
      build: async () => ({
        reservation: await reservationView(tx, input.reservationId),
        ...(input.previousRoomId ? { previousRoom: await tx.room.findFirst({ where: { id: input.previousRoomId }, select: { id: true, number: true } }) } : {}),
      }),
    });
  }

  /** A payment taken (`payment.received`) or money handed back (`refund.paid`, with the refund it settled when there was one). */
  async paymentRecorded(
    tx: TenantTx,
    input: { tenantId: string; branchId: string; type: 'payment.received' | 'refund.paid'; paymentId: string; refundId?: string },
  ): Promise<void> {
    await this.emit(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
      types: [input.type],
      build: async () => ({
        ...(await paymentView(tx, input.paymentId)),
        ...(input.type === 'refund.paid'
          ? {
              refund: input.refundId
                ? await tx.refund.findFirst({ where: { id: input.refundId }, select: { id: true, reason: true, method: true, paymentId: true, createdAt: true } })
                : null,
            }
          : {}),
      }),
    });
  }
}
