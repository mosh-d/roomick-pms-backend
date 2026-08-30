import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { EventSpacesService } from './event-spaces.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

describe('EventSpacesService', () => {
  let service: EventSpacesService;
  let tx: {
    eventSpace: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
    eventBooking: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; delete: jest.Mock };
  };
  let prisma: { withTenant: jest.Mock };

  beforeEach(async () => {
    tx = {
      eventSpace: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
      eventBooking: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), create: jest.fn(), delete: jest.fn() },
    };
    prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) };
    const moduleRef = await Test.createTestingModule({
      providers: [EventSpacesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(EventSpacesService);
  });

  describe('createBooking', () => {
    const startsAt = '2026-10-05T09:00:00.000Z';
    const endsAt = '2026-10-05T17:00:00.000Z';

    it('rejects endsAt at or before startsAt', async () => {
      await expect(service.createBooking(TENANT_ID, 'space-1', { title: 'X', startsAt, endsAt: startsAt }, ACTOR)).rejects.toMatchObject({ status: 409 });
      expect(tx.eventBooking.create).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND for an unknown event space', async () => {
      tx.eventSpace.findFirst.mockResolvedValue(null);
      await expect(service.createBooking(TENANT_ID, 'nonexistent', { title: 'X', startsAt, endsAt }, ACTOR)).rejects.toMatchObject({ status: 404 });
    });

    it('rejects a booking that overlaps an existing one on the same space', async () => {
      tx.eventSpace.findFirst.mockResolvedValue({ id: 'space-1', name: 'Grand Ballroom' });
      tx.eventBooking.findFirst.mockResolvedValue({ id: 'existing-booking' });
      await expect(service.createBooking(TENANT_ID, 'space-1', { title: 'X', startsAt, endsAt }, ACTOR)).rejects.toMatchObject({ status: 409 });
      expect(tx.eventBooking.create).not.toHaveBeenCalled();
    });

    it('creates the booking when the space is free for that time range', async () => {
      tx.eventSpace.findFirst.mockResolvedValue({ id: 'space-1', name: 'Grand Ballroom' });
      tx.eventBooking.findFirst.mockResolvedValue(null);
      tx.eventBooking.create.mockImplementation(({ data }) => Promise.resolve({ id: 'booking-1', ...data }));
      const result = await service.createBooking(TENANT_ID, 'space-1', { title: 'Product Launch', startsAt, endsAt }, ACTOR);
      expect(result.title).toBe('Product Launch');
      expect(tx.eventBooking.findFirst).toHaveBeenCalledWith({
        where: { eventSpaceId: 'space-1', startsAt: { lt: new Date(endsAt) }, endsAt: { gt: new Date(startsAt) } },
      });
    });

    it('does NOT reject two bookings on the same day that do not actually overlap in time', async () => {
      tx.eventSpace.findFirst.mockResolvedValue({ id: 'space-1', name: 'Grand Ballroom' });
      // Simulates the real query: an existing 9am-12pm booking does not overlap a new 1pm-5pm one.
      tx.eventBooking.findFirst.mockImplementation(({ where }) => {
        const existingEnd = new Date('2026-10-05T12:00:00.000Z');
        const existingStart = new Date('2026-10-05T09:00:00.000Z');
        const overlaps = existingStart < where.endsAt.lt && existingEnd > where.startsAt.gt;
        return Promise.resolve(overlaps ? { id: 'existing' } : null);
      });
      tx.eventBooking.create.mockImplementation(({ data }) => Promise.resolve({ id: 'booking-2', ...data }));
      const result = await service.createBooking(TENANT_ID, 'space-1', { title: 'Afternoon Session', startsAt: '2026-10-05T13:00:00.000Z', endsAt: '2026-10-05T17:00:00.000Z' }, ACTOR);
      expect(result.title).toBe('Afternoon Session');
    });
  });

  describe('cancelBooking', () => {
    it('throws NOT_FOUND for an unknown booking', async () => {
      tx.eventBooking.findFirst.mockResolvedValue(null);
      await expect(service.cancelBooking(TENANT_ID, 'nonexistent')).rejects.toMatchObject({ status: 404 });
    });

    it('deletes a real booking, freeing the slot', async () => {
      tx.eventBooking.findFirst.mockResolvedValue({ id: 'booking-1' });
      await service.cancelBooking(TENANT_ID, 'booking-1');
      expect(tx.eventBooking.delete).toHaveBeenCalledWith({ where: { id: 'booking-1' } });
    });
  });

  describe('listBookings', () => {
    it('scopes to the branch via the event space relation and the date-range overlap filter', async () => {
      const from = new Date('2026-10-01');
      const to = new Date('2026-10-31');
      await service.listBookings(TENANT_ID, BRANCH_ID, from, to);
      expect(tx.eventBooking.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { eventSpace: { branchId: BRANCH_ID }, startsAt: { lt: to }, endsAt: { gt: from } } }));
    });
  });
});
