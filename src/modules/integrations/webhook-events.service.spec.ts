import { Prisma } from '@prisma/client';
import { TenantTx } from '../../prisma/prisma.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookEventsService } from './webhook-events.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';

function reservationRow() {
  return {
    id: 'res-1',
    confirmationNumber: 'RES-2026-00001',
    status: 'checked_in',
    channel: 'walk_in',
    branchId: BRANCH_ID,
    checkInDate: new Date('2026-10-07T00:00:00.000Z'),
    checkOutDate: new Date('2026-10-09T00:00:00.000Z'),
    adults: 2,
    children: 0,
    confirmedRate: new Prisma.Decimal('200000'),
    overrideRate: null,
    specialRequests: null,
    groupBlockId: null,
    corporateAccountId: null,
    actualCheckIn: new Date('2026-10-07T13:00:00.000Z'),
    actualCheckOut: null,
    createdAt: new Date('2026-10-07T13:00:00.000Z'),
    updatedAt: new Date('2026-10-07T13:00:00.000Z'),
    guest: { id: 'guest-1', name: 'Ada Obi', email: 'ada@guest.example', phone: '+2348012345678' },
    roomType: { id: 'rt-1', name: 'Deluxe' },
    room: { id: 'room-101', number: '101' },
    branch: { currency: 'NGN' },
  };
}

function makeTx(webhooks: Array<{ id: string; eventTypes: string[] }>) {
  return {
    webhook: { findMany: jest.fn().mockResolvedValue(webhooks) },
    webhookDelivery: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    reservation: { findFirstOrThrow: jest.fn().mockResolvedValue(reservationRow()) },
    room: { findFirst: jest.fn().mockResolvedValue({ id: 'room-102', number: '102' }) },
    payment: {
      findFirstOrThrow: jest.fn().mockResolvedValue({
        id: 'pay-1',
        amount: new Prisma.Decimal('-5000'),
        currency: 'NGN',
        method: 'cash',
        paymentPurpose: 'payment',
        reference: 'Refund — overcharge',
        recordedAt: new Date('2026-10-07T15:00:00.000Z'),
        folio: { id: 'folio-1', label: null, payerName: null, reservation: { id: 'res-1', confirmationNumber: 'RES-2026-00001' }, guest: { id: 'guest-1', name: 'Ada Obi' } },
      }),
    },
    refund: { findFirst: jest.fn().mockResolvedValue({ id: 'refund-1', reason: 'Overcharge', method: 'cash', paymentId: null, createdAt: new Date() }) },
  };
}

describe('WebhookEventsService', () => {
  const kick = jest.fn();
  const service = new WebhookEventsService({ kick } as unknown as WebhookDispatcherService);
  beforeEach(() => jest.clearAllMocks());

  it('with nobody listening, nothing is built or queued', async () => {
    const tx = makeTx([]);
    await service.reservationChanged(tx as unknown as TenantTx, { tenantId: TENANT_ID, branchId: BRANCH_ID, action: 'reservation.created', reservationId: 'res-1' });
    expect(tx.webhook.findMany).toHaveBeenCalledWith({
      where: { isActive: true, eventTypes: { hasSome: ['reservation.created'] }, OR: [{ branchId: null }, { branchId: BRANCH_ID }] },
      select: { id: true, eventTypes: true },
    });
    expect(tx.reservation.findFirstOrThrow).not.toHaveBeenCalled();
    expect(tx.webhookDelivery.createMany).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it('an audit action that isn’t an event asks nobody', async () => {
    const tx = makeTx([{ id: 'wh-1', eventTypes: ['reservation.created'] }]);
    await service.reservationChanged(tx as unknown as TenantTx, { tenantId: TENANT_ID, branchId: BRANCH_ID, action: 'no_show.penalty_waived', reservationId: 'res-1' });
    expect(tx.webhook.findMany).not.toHaveBeenCalled();
  });

  it('a walk-in is two events, each queued only for the webhooks that want it, sharing an id per event', async () => {
    const tx = makeTx([
      { id: 'wh-crm', eventTypes: ['reservation.created'] },
      { id: 'wh-lock', eventTypes: ['reservation.checked_in', 'reservation.checked_out'] },
      { id: 'wh-all', eventTypes: ['reservation.created', 'reservation.checked_in'] },
    ]);
    await service.reservationChanged(tx as unknown as TenantTx, { tenantId: TENANT_ID, branchId: BRANCH_ID, action: 'reservation.walk_in', reservationId: 'res-1' });

    const rows = tx.webhookDelivery.createMany.mock.calls[0][0].data as Array<{ webhookId: string; eventType: string; eventId: string; payload: Record<string, unknown> }>;
    expect(rows.map((row) => `${row.eventType}→${row.webhookId}`)).toEqual([
      'reservation.created→wh-crm',
      'reservation.created→wh-all',
      'reservation.checked_in→wh-lock',
      'reservation.checked_in→wh-all',
    ]);
    expect(rows[0].eventId).toBe(rows[1].eventId);
    expect(rows[0].eventId).not.toBe(rows[2].eventId);
    expect(rows[2].payload).toMatchObject({
      type: 'reservation.checked_in',
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
      data: {
        reservation: {
          confirmationNumber: 'RES-2026-00001',
          status: 'checked_in',
          checkInDate: '2026-10-07',
          checkOutDate: '2026-10-09',
          nights: 2,
          room: { number: '101' },
          guest: { name: 'Ada Obi', email: 'ada@guest.example' },
          roomTotal: '200000.00',
          currency: 'NGN',
        },
      },
    });
    expect(kick).toHaveBeenCalledWith(TENANT_ID);
  });

  it('a room move says which room the guest left', async () => {
    const tx = makeTx([{ id: 'wh-lock', eventTypes: ['reservation.room_moved'] }]);
    await service.reservationChanged(tx as unknown as TenantTx, { tenantId: TENANT_ID, branchId: BRANCH_ID, action: 'reservation.room_moved', reservationId: 'res-1', previousRoomId: 'room-102' });
    const [row] = tx.webhookDelivery.createMany.mock.calls[0][0].data as Array<{ payload: { data: Record<string, unknown> } }>;
    expect(row.payload.data.previousRoom).toEqual({ id: 'room-102', number: '102' });
  });

  it('a refund carries the money out and the refund it settled', async () => {
    const tx = makeTx([{ id: 'wh-acct', eventTypes: ['refund.paid'] }]);
    await service.paymentRecorded(tx as unknown as TenantTx, { tenantId: TENANT_ID, branchId: BRANCH_ID, type: 'refund.paid', paymentId: 'pay-1', refundId: 'refund-1' });
    const [row] = tx.webhookDelivery.createMany.mock.calls[0][0].data as Array<{ payload: { data: Record<string, unknown> } }>;
    expect(row.payload.data).toMatchObject({
      payment: { id: 'pay-1', amount: '-5000.00', method: 'cash' },
      reservation: { confirmationNumber: 'RES-2026-00001' },
      refund: { id: 'refund-1', reason: 'Overcharge' },
    });
  });
});
