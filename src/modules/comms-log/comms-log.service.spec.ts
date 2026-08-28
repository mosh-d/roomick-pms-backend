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
    reservation: { findFirst: jest.fn().mockResolvedValue({ id: RESERVATION_ID, branchId: BRANCH_ID, guestId: GUEST_ID }) },
    communicationLog: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'comm-1', ...data })),
      findMany: jest.fn().mockResolvedValue([]),
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
});
