import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { CommsLogService } from './comms-log.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const GUEST_ID = '55555555-5555-4555-8555-555555555555';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';

function makeTx() {
  return {
    reservation: {
      findFirst: jest.fn().mockResolvedValue({ id: RESERVATION_ID, branchId: BRANCH_ID, guestId: GUEST_ID }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    guestProfile: { findFirst: jest.fn().mockResolvedValue({ id: GUEST_ID, name: 'Ada Okafor', email: 'ada@example.com', phone: null }) },
    communicationLog: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'comm-1', ...data })),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe('CommsLogService', () => {
  let service: CommsLogService;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(async () => {
    tx = makeTx();
    const moduleRef = await Test.createTestingModule({
      providers: [CommsLogService, { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } }],
    }).compile();
    service = moduleRef.get(CommsLogService);
  });

  describe('logAutomatedInTx', () => {
    it('writes a queued row with no sentBy — automated, not a human send', async () => {
      await service.logAutomatedInTx(tx as never, TENANT_ID, BRANCH_ID, {
        reservationId: RESERVATION_ID,
        guestId: GUEST_ID,
        channel: 'email',
        body: 'Your reservation is confirmed.',
        trigger: 'booking_confirmation',
      });
      expect(tx.communicationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deliveryStatus: 'queued', sentBy: null, trigger: 'booking_confirmation' }) }),
      );
    });
  });

  describe('sendManual', () => {
    it('writes a queued row stamped with the sending agent and trigger "manual"', async () => {
      await service.sendManual(TENANT_ID, RESERVATION_ID, { channel: 'email', subject: 'Hi', body: 'A note.' }, ACTOR_ID);
      expect(tx.communicationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ branchId: BRANCH_ID, guestId: GUEST_ID, trigger: 'manual', deliveryStatus: 'queued', sentBy: ACTOR_ID }),
        }),
      );
    });

    it('404s on a reservation that does not exist', async () => {
      tx.reservation.findFirst.mockResolvedValue(null);
      await expect(service.sendManual(TENANT_ID, RESERVATION_ID, { channel: 'sms', body: 'x' }, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('listForGuest', () => {
    it('passes through an unfiltered query when no date range is given', async () => {
      await service.listForGuest(TENANT_ID, GUEST_ID);
      expect(tx.communicationLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { guestId: GUEST_ID } }));
    });

    it('adds a sentAt range filter when from/to are given', async () => {
      await service.listForGuest(TENANT_ID, GUEST_ID, '2026-01-01', '2026-02-01');
      const where = tx.communicationLog.findMany.mock.calls[0][0].where;
      expect(where.guestId).toBe(GUEST_ID);
      expect(where.sentAt.gte).toEqual(new Date('2026-01-01'));
      expect(where.sentAt.lte).toEqual(new Date('2026-02-01'));
    });
  });

  describe('unified inbox', () => {
    type Where = { where: { id?: string; guestId?: string } };

    it('lists only guests who have written in — newest activity first, with unread counts and a short preview', async () => {
      tx.communicationLog.findMany.mockResolvedValueOnce([{ guestId: 'g-old' }, { guestId: 'g-new' }]);
      tx.guestProfile.findFirst.mockImplementation(({ where }: Where) => Promise.resolve({ id: where.id, name: where.id, email: null, phone: null }));
      tx.communicationLog.findFirst.mockImplementation(({ where }: Where) =>
        Promise.resolve({
          direction: 'inbound', channel: 'in_app_chat', trigger: 'guest_message', body: 'x'.repeat(300),
          sentAt: where.guestId === 'g-new' ? new Date('2026-10-02') : new Date('2026-10-01'),
        }),
      );
      tx.communicationLog.count.mockImplementation(({ where }: Where) => Promise.resolve(where.guestId === 'g-new' ? 2 : 0));
      tx.reservation.findFirst.mockResolvedValue(null);

      const inbox = await service.listInbox(TENANT_ID, BRANCH_ID, 'all');
      expect(tx.communicationLog.findMany.mock.calls[0][0].where).toEqual({ branchId: BRANCH_ID, direction: 'inbound' });
      expect(inbox.map((c) => c.guest.id)).toEqual(['g-new', 'g-old']);
      expect(inbox[0].unreadCount).toBe(2);
      expect(inbox[0].lastMessage.preview).toHaveLength(161);
    });

    it('the unread filter only looks at inbound messages nobody has read', async () => {
      await service.listInbox(TENANT_ID, BRANCH_ID, 'unread');
      expect(tx.communicationLog.findMany.mock.calls[0][0].where).toEqual({ branchId: BRANCH_ID, direction: 'inbound', readAt: null });
    });

    it('404s on the thread of a guest that does not exist', async () => {
      tx.guestProfile.findFirst.mockResolvedValue(null);
      await expect(service.getThread(TENANT_ID, BRANCH_ID, GUEST_ID)).rejects.toThrow(NotFoundException);
    });

    it('returns a thread oldest-first, automated notices included', async () => {
      tx.communicationLog.findMany.mockResolvedValueOnce([{ id: 'newer' }, { id: 'older' }]);
      const thread = await service.getThread(TENANT_ID, BRANCH_ID, GUEST_ID);
      expect(tx.communicationLog.findMany.mock.calls[0][0].where).toEqual({ branchId: BRANCH_ID, guestId: GUEST_ID });
      expect(thread.messages.map((m) => (m as { id: string }).id)).toEqual(['older', 'newer']);
    });

    it("marks every unread inbound message in the guest's thread read", async () => {
      tx.communicationLog.updateMany.mockResolvedValue({ count: 3 });
      await expect(service.markThreadRead(TENANT_ID, BRANCH_ID, GUEST_ID)).resolves.toEqual({ marked: 3 });
      const call = tx.communicationLog.updateMany.mock.calls[0][0] as { where: unknown; data: { readAt: unknown } };
      expect(call.where).toEqual({ branchId: BRANCH_ID, guestId: GUEST_ID, direction: 'inbound', readAt: null });
      expect(call.data.readAt).toBeInstanceOf(Date);
    });

    it('replies on the booking the guest last wrote about, and marks the thread read', async () => {
      tx.communicationLog.findFirst.mockResolvedValue({ reservationId: 'res-written-about' });
      await service.replyInThread(TENANT_ID, BRANCH_ID, GUEST_ID, { channel: 'in_app_chat', body: 'Done!' }, ACTOR_ID);
      expect(tx.communicationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reservationId: 'res-written-about', direction: 'outbound', trigger: 'manual', sentBy: ACTOR_ID }) }),
      );
      expect(tx.communicationLog.updateMany).toHaveBeenCalled();
    });

    it('a portal reply is "sent" the moment it is written; an email waits in the queue for the dispatcher', async () => {
      await service.replyInThread(TENANT_ID, BRANCH_ID, GUEST_ID, { channel: 'in_app_chat', body: 'On the portal' }, ACTOR_ID);
      await service.replyInThread(TENANT_ID, BRANCH_ID, GUEST_ID, { channel: 'email', subject: 'Your stay', body: 'By email' }, ACTOR_ID);
      const statuses = tx.communicationLog.create.mock.calls.map((c) => (c[0] as { data: { deliveryStatus: string } }).data.deliveryStatus);
      expect(statuses).toEqual(['sent', 'queued']);
    });

    it('404s when the guest has no booking here to reply on', async () => {
      tx.communicationLog.findFirst.mockResolvedValue(null);
      tx.reservation.findFirst.mockResolvedValue(null);
      await expect(service.replyInThread(TENANT_ID, BRANCH_ID, GUEST_ID, { channel: 'in_app_chat', body: 'Hi' }, ACTOR_ID)).rejects.toThrow(NotFoundException);
      expect(tx.communicationLog.create).not.toHaveBeenCalled();
    });

    it('a guest message is an inbound, received in_app_chat row with no staff sender, tagged when it is a request', async () => {
      await service.logGuestMessageInTx(tx as never, TENANT_ID, BRANCH_ID, { reservationId: RESERVATION_ID, guestId: GUEST_ID, body: 'Until 2pm?', requestType: 'late_checkout' });
      expect(tx.communicationLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          direction: 'inbound', channel: 'in_app_chat', deliveryStatus: 'delivered', sentBy: null,
          trigger: 'guest_request', subject: 'Late check-out request', body: 'Until 2pm?',
        }),
      });
    });

    it('the guest sees only the conversation — their messages and staff replies — in reading order', async () => {
      tx.communicationLog.findMany.mockResolvedValueOnce([{ id: 'second' }, { id: 'first' }]);
      const rows = await service.guestThreadInTx(tx as never, RESERVATION_ID);
      expect(tx.communicationLog.findMany.mock.calls[0][0].where).toEqual({
        reservationId: RESERVATION_ID,
        OR: [{ direction: 'inbound' }, { direction: 'outbound', trigger: 'manual' }],
      });
      expect(rows.map((r) => (r as unknown as { id: string }).id)).toEqual(['first', 'second']);
    });
  });
});
